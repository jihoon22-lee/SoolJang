"""오프라인 동기화 프로토콜 — 델타 풀과 outbox 배치 적용.

`docs/architecture.md` §5. 두 방향이 있다.

- **풀**(`pull_changes`): 사용자의 12개 동기화 대상 테이블에서 `(updated_at, id)` 커서
  이후 변경분을 가져온다. `deleted_at` 이 있는 행도 포함한다 — 삭제도 전파해야 한다(§5.3)
- **푸시**(`apply_batch`): 오프라인에서 쌓인 작업을 순서대로 적용한다. 각 작업을
  SAVEPOINT 로 감싸 실패한 작업 하나가 이전 작업들의 커밋까지 되돌리지 않게 하고,
  실패 이후 작업은 보내지 않는다(head-of-line blocking, §5.2 — 부모보다 자식이 먼저
  도착하면 FK 가 깨지므로 순서를 반드시 지켜야 한다)

**쓰기 범위**: `category`·`product`·`sku`·`vendor`·`purchase`·`bottle`(상태 전이
action)·`tasting_session`(record_tasting action)만 오프라인 쓰기를 지원한다.
`producer`·`variety`·`product_variety`·`attachment` 는 풀(읽기) 전용이다 — `producer`
는 이 앱 어디에도 생성 경로가 아직 없고(향후 Task), `variety`/`product_variety` 는
제품 생성 시 이름으로 자동 해석되는 로직(`resolve_variety_ids`)이 있어 오프라인에서
그 해석까지 복제하는 비용이 이번 범위를 벗어난다. 온라인 복귀 후 추가하면 된다.
카테고리의 `reparent`/`merge`/`reorder`/`reset-seed`, 구매 건 `:split` 도 순환·깊이·
계단식 재배치 로직이 있어 온라인 전용으로 남긴다 — `category.update` 에 `parent_id`
가 오면 검증 오류로 명시적으로 거부한다(조용히 무시하지 않는다).

**구매 건 생성은 병을 함께 만든다.** `POST /purchases` 의 기존 온라인 동작
(`_add_bottles`)과 같다. `bottle_ids` 를 페이로드에 주면 그 id 를 그대로 쓰고,
없으면 서버가 새로 만든다 — 오프라인 낙관적 UI 가 병 id 를 미리 알아야 하는
경우(구매 직후 병 목록에 바로 표시)에 쓴다.
"""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy import delete as sa_delete
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.api.errors import NotFoundError, ValidationFailedError
from sooljang.api.pagination import Cursor
from sooljang.application.categories import CategoryError, create_category, make_slug
from sooljang.application.products import ensure_category_exists, normalized_name_of
from sooljang.application.tastings import (
    BottleTransitionError,
    InsufficientRemainingError,
    InvalidRatingError,
    TastingInput,
    finish_bottle,
    hand_over_bottle,
    open_bottle,
    record_tasting,
    reopen_bottle,
)
from sooljang.infrastructure.database.base import Base
from sooljang.infrastructure.database.models import (
    Attachment,
    BarcodeType,
    Bottle,
    BottleStatus,
    Category,
    ConflictLog,
    OutboxReceipt,
    Producer,
    Product,
    ProductVariety,
    Purchase,
    Sku,
    TastingSession,
    Variety,
    Vendor,
    VendorKind,
)

#: 풀 대상 12개 엔티티. `docs/architecture.md` §5.3 의 `changes` 키와 1:1 대응한다.
#: 값은 전부 `EntityMixin` 을 쓰는 모델이지만(`id`·`user_id`·`updated_at` 보장),
#: 믹스인은 `Base` 와 별도로 섞여 들어가 정적 타입으로 표현하기 어려워 `Any` 로 둔다.
SYNC_ENTITIES: dict[str, type[Any]] = {
    "category": Category,
    "producer": Producer,
    "variety": Variety,
    "product": Product,
    "product_variety": ProductVariety,
    "sku": Sku,
    "vendor": Vendor,
    "purchase": Purchase,
    "bottle": Bottle,
    "tasting_session": TastingSession,
    "attachment": Attachment,
    "conflict_log": ConflictLog,
}

#: 오프라인 쓰기(outbox)를 지원하는 엔티티. 나머지는 풀 전용이다 — 모듈 docstring 참조.
WRITABLE_ENTITIES = frozenset(
    {"category", "product", "sku", "vendor", "purchase", "bottle", "tasting_session"}
)

#: 한 번에 풀할 엔티티당 최대 행 수.
SYNC_PAGE_LIMIT = 500
#: `outbox_receipt` 보관 기간(§5.2).
OUTBOX_RECEIPT_RETENTION_DAYS = 30

#: dict.get 의 기본값(None)과 "필드가 아예 없음"을 구분하기 위한 표식.
_MISSING: Any = object()


# --- 공용 타입 변환 ------------------------------------------------------------


def _uuid(value: Any) -> uuid.UUID | None:
    if value is None:
        return None
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


def _required_uuid(value: Any, *, field_name: str) -> uuid.UUID:
    result = _uuid(value)
    if result is None:
        raise ValidationFailedError(f"{field_name} 은(는) 필수입니다")
    return result


def _date(value: Any):  # noqa: ANN202 - datetime.date | None, 순환 임포트 피하려 지연 평가 안 함
    import datetime as _dt

    if value is None:
        return None
    if isinstance(value, _dt.date):
        return value
    return _dt.date.fromisoformat(str(value))


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    return Decimal(str(value))


# --- 풀 --------------------------------------------------------------------


def _json_safe(value: Any) -> Any:
    """JSON/JSONB 로 그대로 쓸 수 있게 바꾼다.

    `outbox_receipt.response_snapshot`·`conflict_log.client_snapshot` 은 psycopg 가
    표준 `json.dumps` 로 직접 인코딩하는 JSONB 컬럼이다 — FastAPI 응답과 달리 Pydantic
    인코더를 거치지 않으므로 `UUID`·`Decimal`·`date`/`datetime` 을 미리 문자열로 바꿔야
    한다. `StrEnum`(`BottleStatus` 등)은 이미 `str` 서브클래스라 그대로 둔다.
    """
    if value is None or isinstance(value, str | int | float | bool):
        return value
    if isinstance(value, uuid.UUID | Decimal):
        return str(value)
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def serialize_row(instance: Base) -> dict[str, Any]:
    """행을 컬럼 그대로 JSON-safe dict 로 만든다.

    Dexie 미러는 원자값 1:1이 목적이라 조인·계산 필드가 섞인 응답 스키마(`ProductOut`
    등)를 쓰지 않는다 — 11개 전용 Out 스키마를 새로 만들 필요가 없다.
    """
    mapper = sa_inspect(type(instance)).mapper
    return {column.key: _json_safe(getattr(instance, column.key)) for column in mapper.column_attrs}


@dataclass(frozen=True, slots=True)
class SyncPullResult:
    changes: dict[str, list[dict[str, Any]]]
    next_cursor: str | None
    has_more: bool


async def pull_changes(
    session: AsyncSession, *, user_id: uuid.UUID, cursor: Cursor | None
) -> SyncPullResult:
    """`(updated_at, id)` 커서 이후 변경분을 엔티티별로 가져온다.

    `deleted_at IS NULL` 필터를 걸지 않는다 — 소프트 삭제도 전파해야 한다.

    엔티티마다 페이지 상한을 넘으면 그 엔티티만 잘린다. 다음 커서는 잘린 엔티티들
    중 가장 이른 워터마크로 잡는다(보수적). 잘리지 않은 엔티티는 다음 풀에서 같은
    행을 다시 받을 수 있지만, 클라이언트 병합은 멱등이라 문제가 없다.
    """
    boundary_time: datetime | None = None
    boundary_id: uuid.UUID | None = None
    if cursor is not None:
        raw = cursor.sort_value
        boundary_time = datetime.fromisoformat(raw) if isinstance(raw, str) else raw
        boundary_id = cursor.id

    changes: dict[str, list[dict[str, Any]]] = {}
    truncated_watermarks: list[tuple[datetime, uuid.UUID]] = []
    max_watermark: tuple[datetime, uuid.UUID] | None = None

    for name, model in SYNC_ENTITIES.items():
        statement: Select[Any] = select(model).where(model.user_id == user_id)
        if boundary_time is not None:
            statement = statement.where(
                or_(
                    model.updated_at > boundary_time,
                    and_(model.updated_at == boundary_time, model.id > boundary_id),
                )
            )
        statement = statement.order_by(model.updated_at, model.id).limit(SYNC_PAGE_LIMIT + 1)
        rows = list((await session.scalars(statement)).all())

        capped = len(rows) > SYNC_PAGE_LIMIT
        visible = rows[:SYNC_PAGE_LIMIT] if capped else rows
        changes[name] = [serialize_row(row) for row in visible]

        if visible:
            last = visible[-1]
            watermark = (last.updated_at, last.id)
            if capped:
                truncated_watermarks.append(watermark)
            if max_watermark is None or watermark > max_watermark:
                max_watermark = watermark

    if truncated_watermarks:
        watermark = min(truncated_watermarks)
        has_more = True
    else:
        watermark = max_watermark
        has_more = False

    if watermark is not None:
        next_cursor = Cursor(sort_value=watermark[0], id=watermark[1]).encode()
    else:
        next_cursor = cursor.encode() if cursor is not None else None

    return SyncPullResult(changes=changes, next_cursor=next_cursor, has_more=has_more)


# --- 푸시 --------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SyncOperation:
    """outbox 작업 하나. `idempotency_key` 는 이 작업 자체를 식별하고(재전송 판정),
    `entity_id` 는 대상 레코드의 PK 다 — `create` 에서는 흔히 같은 값이지만
    강제되지 않는다."""

    idempotency_key: uuid.UUID
    entity: str
    op: str  # "create" | "update" | "delete" | "action"
    entity_id: uuid.UUID
    base_updated_at: datetime | None = None
    action: str | None = None
    fields: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class OperationResult:
    idempotency_key: uuid.UUID
    status: str  # "applied" | "conflict" | "failed"
    detail: str | None = None
    snapshot: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class BatchResult:
    results: list[OperationResult]
    #: True 면 실패한 작업 이후를 보내지 않고 멈췄다는 뜻이다(head-of-line blocking).
    stopped: bool


async def apply_batch(
    session: AsyncSession, *, user_id: uuid.UUID, operations: list[SyncOperation]
) -> BatchResult:
    """작업을 순서대로 적용한다. 실패하면 그 지점에서 멈춘다."""
    await _sweep_expired_receipts(session, user_id=user_id)

    results: list[OperationResult] = []
    stopped = False
    for op in operations:
        existing = await session.get(OutboxReceipt, op.idempotency_key)
        if existing is not None:
            results.append(
                OperationResult(
                    idempotency_key=op.idempotency_key,
                    status=existing.status,
                    snapshot=existing.response_snapshot,
                )
            )
            continue

        try:
            async with session.begin_nested():
                outcome = await _dispatch(session, user_id=user_id, op=op)
        except (
            NotFoundError,
            ValidationFailedError,
            CategoryError,
            BottleTransitionError,
            InsufficientRemainingError,
            InvalidRatingError,
            # 잘못된 payload(필수 필드 누락, 형식이 깨진 UUID·금액)는 이 배치 요청 전체를
            # 500 으로 죽이는 대신 해당 작업만 실패로 기록한다. 클라이언트 버그로 생긴
            # 배치 하나가 서버 예외를 일으키면 안 된다.
            KeyError,
            ValueError,
            InvalidOperation,
        ) as error:
            results.append(
                OperationResult(
                    idempotency_key=op.idempotency_key, status="failed", detail=str(error)
                )
            )
            stopped = True
            break

        session.add(
            OutboxReceipt(
                id=op.idempotency_key,
                user_id=user_id,
                entity=op.entity,
                operation=op.op,
                entity_id=op.entity_id,
                status=outcome.status,
                response_snapshot=outcome.snapshot or {},
            )
        )
        await session.flush()
        results.append(outcome)

    return BatchResult(results=results, stopped=stopped)


async def _sweep_expired_receipts(session: AsyncSession, *, user_id: uuid.UUID) -> None:
    """30일 지난 재전송 기록을 정리한다. 배치 요청마다 lazy 하게 실행한다."""
    cutoff = datetime.now(UTC) - timedelta(days=OUTBOX_RECEIPT_RETENTION_DAYS)
    await session.execute(
        sa_delete(OutboxReceipt).where(
            OutboxReceipt.user_id == user_id, OutboxReceipt.created_at < cutoff
        )
    )


async def _applied(session: AsyncSession, op: SyncOperation, row: Base) -> OperationResult:
    """성공 결과를 만든다.

    flush 직후 인메모리 값은 입력 그대로지만(예: `85000`) DB 에 저장된 값은
    `Numeric` 정밀도가 적용된 값(`85000.00`)이다. 재조회 없이 스냅샷을 만들면 outbox
    재전송 응답과 이후 풀 응답의 형식이 달라진다 — `api/routes/purchases.py` 의
    `_to_purchase_out` 이 같은 이유로 응답 전에 `session.refresh()` 한다.
    """
    await session.refresh(row)
    return OperationResult(
        idempotency_key=op.idempotency_key, status="applied", snapshot=serialize_row(row)
    )


async def _load_writable(
    session: AsyncSession, model: type[Any], *, user_id: uuid.UUID, entity_id: uuid.UUID, op: str
) -> Any:
    """수정 대상을 로드한다. `delete` 는 이미 지워진 행도 멱등 통과시키고, 그 외는 404."""
    row = await session.get(model, entity_id)
    if row is None or row.user_id != user_id:
        raise NotFoundError(f"레코드를 찾을 수 없습니다: {entity_id}")
    if row.deleted_at is not None and op != "delete":
        raise NotFoundError(f"레코드를 찾을 수 없습니다: {entity_id}")
    return row


async def _check_conflict(
    session: AsyncSession, *, user_id: uuid.UUID, entity: str, row: Any, op: SyncOperation
) -> OperationResult | None:
    """서버가 클라이언트 기준시점 이후 바뀌었으면 충돌로 기록하고 서버 값을 유지한다.

    `base_updated_at` 이 없으면(클라이언트가 큐에 쌓을 때 기준값을 몰랐던 경우) 항상
    적용한다 — 최소한 사용자의 가장 최근 의도는 반영한다.
    """
    if op.base_updated_at is None:
        return None
    if row.updated_at <= op.base_updated_at:
        return None
    session.add(
        ConflictLog(
            user_id=user_id,
            entity=entity,
            entity_id=row.id,
            server_updated_at=row.updated_at,
            client_updated_at=op.base_updated_at,
            client_snapshot=op.fields,
            idempotency_key=op.idempotency_key,
        )
    )
    await session.flush()
    return OperationResult(
        idempotency_key=op.idempotency_key,
        status="conflict",
        detail="서버 값이 더 최신이라 서버 값을 유지했습니다",
        snapshot=serialize_row(row),
    )


async def _dispatch(
    session: AsyncSession, *, user_id: uuid.UUID, op: SyncOperation
) -> OperationResult:
    if op.entity not in WRITABLE_ENTITIES:
        raise ValidationFailedError(f"'{op.entity}' 는 오프라인 쓰기를 지원하지 않습니다")

    if op.op == "action":
        return await _dispatch_action(session, user_id=user_id, op=op)
    if op.entity == "category":
        return await _dispatch_category(session, user_id=user_id, op=op)
    if op.entity == "product":
        return await _dispatch_product(session, user_id=user_id, op=op)
    if op.entity == "sku":
        return await _dispatch_sku(session, user_id=user_id, op=op)
    if op.entity == "vendor":
        return await _dispatch_vendor(session, user_id=user_id, op=op)
    if op.entity == "purchase":
        return await _dispatch_purchase(session, user_id=user_id, op=op)
    raise ValidationFailedError(f"'{op.entity}' 는 '{op.op}' 오퍼레이션을 지원하지 않습니다")


# --- 카테고리 ------------------------------------------------------------------


async def _dispatch_category(
    session: AsyncSession, *, user_id: uuid.UUID, op: SyncOperation
) -> OperationResult:
    fields = op.fields

    if op.op == "create":
        try:
            category = await create_category(
                session,
                user_id=user_id,
                name=fields["name"],
                parent_id=_uuid(fields.get("parent_id")),
                sort_order=fields.get("sort_order", 0),
                id=op.entity_id,
            )
        except CategoryError as error:
            raise ValidationFailedError(str(error)) from error
        if fields.get("note") is not None:
            category.note = fields["note"]
            await session.flush()
        return await _applied(session, op, category)

    category = await _load_writable(
        session, Category, user_id=user_id, entity_id=op.entity_id, op=op.op
    )

    if op.op == "delete":
        if category.deleted_at is None:
            category.deleted_at = datetime.now(UTC)
            await session.flush()
        return await _applied(session, op, category)

    conflict = await _check_conflict(
        session, user_id=user_id, entity="category", row=category, op=op
    )
    if conflict is not None:
        return conflict

    if fields.get("parent_id", _MISSING) is not _MISSING:
        # 이동은 순환·깊이 검사가 필요한 별개 연산이다 — 온라인 전용 `:reparent` 로만 한다.
        raise ValidationFailedError(
            "주종 이동은 오프라인에서 지원하지 않습니다. 온라인에서 다시 시도하세요"
        )
    if fields.get("name") is not None:
        category.name = fields["name"].strip()
        category.slug = make_slug(fields["name"])
    if "sort_order" in fields and fields["sort_order"] is not None:
        category.sort_order = fields["sort_order"]
    if "note" in fields:
        category.note = fields["note"]
    await session.flush()
    return await _applied(session, op, category)


# --- 제품 -------------------------------------------------------------------


async def _dispatch_product(
    session: AsyncSession, *, user_id: uuid.UUID, op: SyncOperation
) -> OperationResult:
    fields = op.fields

    if op.op == "create":
        category_id = _uuid(fields.get("category_id"))
        await ensure_category_exists(session, user_id=user_id, category_id=category_id)
        name = fields["name"]
        product = Product(
            id=op.entity_id,
            user_id=user_id,
            name=name.strip(),
            name_en=fields.get("name_en"),
            normalized_name=normalized_name_of(name),
            category_id=category_id,
            producer_id=_uuid(fields.get("producer_id")),
            country=fields.get("country"),
            region=fields.get("region"),
            abv=_decimal(fields.get("abv")),
            vintage=fields.get("vintage"),
            age_years=_decimal(fields.get("age_years")),
            personal_rating=_decimal(fields.get("personal_rating")),
            note=fields.get("note"),
        )
        session.add(product)
        await session.flush()
        return await _applied(session, op, product)

    product = await _load_writable(
        session, Product, user_id=user_id, entity_id=op.entity_id, op=op.op
    )

    if op.op == "delete":
        if product.deleted_at is None:
            product.deleted_at = datetime.now(UTC)
            await session.flush()
        return await _applied(session, op, product)

    conflict = await _check_conflict(session, user_id=user_id, entity="product", row=product, op=op)
    if conflict is not None:
        return conflict

    if "category_id" in fields:
        category_id = _uuid(fields["category_id"])
        await ensure_category_exists(session, user_id=user_id, category_id=category_id)
        product.category_id = category_id
    if "producer_id" in fields:
        product.producer_id = _uuid(fields["producer_id"])
    if fields.get("name") is not None:
        product.name = fields["name"].strip()
        product.normalized_name = normalized_name_of(fields["name"])
    for key in ("name_en", "country", "region", "note"):
        if key in fields:
            setattr(product, key, fields[key])
    for key in ("abv", "age_years", "personal_rating"):
        if key in fields:
            setattr(product, key, _decimal(fields[key]))
    if "vintage" in fields:
        product.vintage = fields["vintage"]
    await session.flush()
    return await _applied(session, op, product)


# --- 규격 -------------------------------------------------------------------


async def _dispatch_sku(
    session: AsyncSession, *, user_id: uuid.UUID, op: SyncOperation
) -> OperationResult:
    fields = op.fields

    if op.op == "create":
        product = await _load_writable(
            session,
            Product,
            user_id=user_id,
            entity_id=_required_uuid(fields["product_id"], field_name="product_id"),
            op="create",
        )
        sku = Sku(
            id=op.entity_id,
            user_id=user_id,
            product_id=product.id,
            volume_ml=fields["volume_ml"],
            barcode=fields.get("barcode"),
            barcode_type=BarcodeType(fields["barcode_type"])
            if fields.get("barcode_type")
            else None,
            package_note=fields.get("package_note"),
        )
        session.add(sku)
        await session.flush()
        return await _applied(session, op, sku)

    sku = await _load_writable(session, Sku, user_id=user_id, entity_id=op.entity_id, op=op.op)

    if op.op == "delete":
        if sku.deleted_at is None:
            sku.deleted_at = datetime.now(UTC)
            await session.flush()
        return await _applied(session, op, sku)

    conflict = await _check_conflict(session, user_id=user_id, entity="sku", row=sku, op=op)
    if conflict is not None:
        return conflict

    if "volume_ml" in fields:
        sku.volume_ml = fields["volume_ml"]
    if "barcode" in fields:
        sku.barcode = fields["barcode"]
    if "barcode_type" in fields:
        sku.barcode_type = BarcodeType(fields["barcode_type"]) if fields["barcode_type"] else None
    if "package_note" in fields:
        sku.package_note = fields["package_note"]
    await session.flush()
    return await _applied(session, op, sku)


# --- 구매처 -----------------------------------------------------------------


async def _dispatch_vendor(
    session: AsyncSession, *, user_id: uuid.UUID, op: SyncOperation
) -> OperationResult:
    fields = op.fields

    if op.op == "create":
        vendor = Vendor(
            id=op.entity_id,
            user_id=user_id,
            name=fields["name"].strip(),
            kind=VendorKind(fields["kind"]) if fields.get("kind") else VendorKind.OTHER,
            url=fields.get("url"),
            note=fields.get("note"),
        )
        session.add(vendor)
        await session.flush()
        return await _applied(session, op, vendor)

    vendor = await _load_writable(
        session, Vendor, user_id=user_id, entity_id=op.entity_id, op=op.op
    )

    if op.op == "delete":
        if vendor.deleted_at is None:
            in_use = await session.scalar(
                select(func.count())
                .select_from(Purchase)
                .where(Purchase.vendor_id == vendor.id, Purchase.deleted_at.is_(None))
            )
            if in_use:
                raise ValidationFailedError(f"구매 건 {in_use}개가 이 구매처를 참조합니다")
            vendor.deleted_at = datetime.now(UTC)
            await session.flush()
        return await _applied(session, op, vendor)

    conflict = await _check_conflict(session, user_id=user_id, entity="vendor", row=vendor, op=op)
    if conflict is not None:
        return conflict

    if fields.get("name") is not None:
        vendor.name = fields["name"].strip()
    if "kind" in fields and fields["kind"]:
        vendor.kind = VendorKind(fields["kind"])
    for key in ("url", "note"):
        if key in fields:
            setattr(vendor, key, fields[key])
    await session.flush()
    return await _applied(session, op, vendor)


# --- 구매 건 ----------------------------------------------------------------


async def _dispatch_purchase(
    session: AsyncSession, *, user_id: uuid.UUID, op: SyncOperation
) -> OperationResult:
    fields = op.fields

    if op.op == "create":
        sku = await _load_writable(
            session,
            Sku,
            user_id=user_id,
            entity_id=_required_uuid(fields["sku_id"], field_name="sku_id"),
            op="create",
        )
        vendor_id = _uuid(fields.get("vendor_id"))
        if vendor_id is not None:
            await _load_writable(session, Vendor, user_id=user_id, entity_id=vendor_id, op="create")
        quantity = fields.get("quantity", 1)

        purchase = Purchase(
            id=op.entity_id,
            user_id=user_id,
            sku_id=sku.id,
            vendor_id=vendor_id,
            purchased_on=_date(fields.get("purchased_on")),
            quantity=quantity,
            unit_list_price=_decimal(fields.get("unit_list_price")),
            unit_paid_price=_decimal(fields.get("unit_paid_price")),
            currency=(fields.get("currency") or "KRW").upper(),
            fx_rate=_decimal(fields.get("fx_rate")),
            foreign_unit_price=_decimal(fields.get("foreign_unit_price")),
            discount_note=fields.get("discount_note"),
            import_note=fields.get("import_note"),
        )
        session.add(purchase)
        await session.flush()

        if fields.get("create_bottles", True):
            _create_bottles(
                user_id=user_id,
                purchase_id=purchase.id,
                quantity=quantity,
                bottle_ids=fields.get("bottle_ids"),
                session=session,
            )
            await session.flush()

        return await _applied(session, op, purchase)

    purchase = await _load_writable(
        session, Purchase, user_id=user_id, entity_id=op.entity_id, op=op.op
    )

    if op.op == "delete":
        if purchase.deleted_at is None:
            now = datetime.now(UTC)
            purchase.deleted_at = now
            bottles = await session.scalars(
                select(Bottle).where(Bottle.purchase_id == purchase.id, Bottle.deleted_at.is_(None))
            )
            for bottle in bottles:
                bottle.deleted_at = now
            await session.flush()
        return await _applied(session, op, purchase)

    conflict = await _check_conflict(
        session, user_id=user_id, entity="purchase", row=purchase, op=op
    )
    if conflict is not None:
        return conflict

    if "vendor_id" in fields:
        vendor_id = _uuid(fields["vendor_id"])
        if vendor_id is not None:
            await _load_writable(session, Vendor, user_id=user_id, entity_id=vendor_id, op="update")
        purchase.vendor_id = vendor_id
    if "purchased_on" in fields:
        purchase.purchased_on = _date(fields["purchased_on"])
    for key in ("unit_list_price", "unit_paid_price", "fx_rate", "foreign_unit_price"):
        if key in fields:
            setattr(purchase, key, _decimal(fields[key]))
    if "discount_note" in fields:
        purchase.discount_note = fields["discount_note"]
    if "currency" in fields and fields["currency"]:
        purchase.currency = fields["currency"].upper()
    await session.flush()
    return await _applied(session, op, purchase)


def _create_bottles(
    *,
    session: AsyncSession,
    user_id: uuid.UUID,
    purchase_id: uuid.UUID,
    quantity: int,
    bottle_ids: list[Any] | None,
) -> None:
    """구매 건의 병수만큼 병을 만든다. `POST /purchases` 의 온라인 동작과 같다.

    `bottle_ids` 를 주면 그 id 를 그대로 쓴다 — 오프라인 낙관적 UI 가 구매 직후 병
    목록을 바로 보여줘야 할 때, 클라이언트가 미리 만든 id 와 일치시키기 위함이다.
    """
    if bottle_ids is not None and len(bottle_ids) != quantity:
        raise ValidationFailedError("bottle_ids 개수가 구매 병수와 다릅니다")
    for offset in range(quantity):
        kwargs: dict[str, Any] = {
            "user_id": user_id,
            "purchase_id": purchase_id,
            "label_no": offset + 1,
            "status": BottleStatus.UNOPENED,
        }
        if bottle_ids is not None:
            kwargs["id"] = _uuid(bottle_ids[offset])
        session.add(Bottle(**kwargs))


# --- action (병 상태 전이 · 시음 기록) -----------------------------------------


async def _load_bottle(
    session: AsyncSession, *, user_id: uuid.UUID, bottle_id: uuid.UUID
) -> Bottle:
    bottle = await session.get(Bottle, bottle_id)
    if bottle is None or bottle.deleted_at is not None or bottle.user_id != user_id:
        raise NotFoundError(f"병을 찾을 수 없습니다: {bottle_id}")
    return bottle


async def _dispatch_action(
    session: AsyncSession, *, user_id: uuid.UUID, op: SyncOperation
) -> OperationResult:
    if op.entity == "bottle":
        return await _dispatch_bottle_action(session, user_id=user_id, op=op)
    if op.entity == "tasting_session":
        return await _dispatch_tasting_action(session, user_id=user_id, op=op)
    raise ValidationFailedError(f"'{op.entity}' 는 action 오퍼레이션을 지원하지 않습니다")


async def _dispatch_bottle_action(
    session: AsyncSession, *, user_id: uuid.UUID, op: SyncOperation
) -> OperationResult:
    bottle = await _load_bottle(session, user_id=user_id, bottle_id=op.entity_id)
    fields = op.fields

    if op.action == "open":
        await open_bottle(
            session,
            bottle,
            opened_on=_date(fields.get("opened_on")),
            remaining_ml=fields.get("remaining_ml"),
        )
    elif op.action == "finish":
        await finish_bottle(session, bottle, finished_on=_date(fields.get("finished_on")))
    elif op.action in {"gift", "sell"}:
        status_value = BottleStatus.GIFTED if op.action == "gift" else BottleStatus.SOLD
        await hand_over_bottle(
            session,
            bottle,
            status=status_value,
            note=fields.get("note"),
            on=_date(fields.get("on")),
        )
    elif op.action == "reopen":
        await reopen_bottle(session, bottle)
    else:
        raise ValidationFailedError(f"알 수 없는 병 action 입니다: {op.action}")

    return await _applied(session, op, bottle)


async def _dispatch_tasting_action(
    session: AsyncSession, *, user_id: uuid.UUID, op: SyncOperation
) -> OperationResult:
    if op.action != "record_tasting":
        raise ValidationFailedError(f"알 수 없는 시음 action 입니다: {op.action}")

    fields = op.fields
    bottle: Bottle | None = None
    sku_id = _uuid(fields.get("sku_id"))

    if fields.get("bottle_id") is not None:
        bottle = await _load_bottle(
            session,
            user_id=user_id,
            bottle_id=_required_uuid(fields["bottle_id"], field_name="bottle_id"),
        )
        purchase = await session.get(Purchase, bottle.purchase_id)
        if purchase is None:
            raise NotFoundError("병에 연결된 구매 건을 찾을 수 없습니다")
        sku_id = purchase.sku_id

    if sku_id is None:
        raise ValidationFailedError("bottle_id 또는 sku_id 중 하나는 있어야 합니다")

    try:
        record = await record_tasting(
            session,
            user_id=user_id,
            sku_id=sku_id,
            bottle=bottle,
            id=op.entity_id,
            data=TastingInput(
                tasted_on=_date(fields["tasted_on"]),
                poured_ml=fields.get("poured_ml"),
                rating=_decimal(fields.get("rating")),
                nose=fields.get("nose"),
                palate=fields.get("palate"),
                finish=fields.get("finish"),
                note=fields.get("note"),
                place=fields.get("place"),
                companions=fields.get("companions"),
            ),
        )
    except InsufficientRemainingError as error:
        raise ValidationFailedError(str(error)) from error

    return await _applied(session, op, record)
