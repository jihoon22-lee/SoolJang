"""커서 페이지네이션.

offset 방식은 데이터가 바뀌면 중복·누락이 생긴다. 목록을 보는 중에 술을 하나 등록하면
다음 페이지에서 같은 항목이 다시 나오거나 건너뛰어진다. 무한 스크롤에서는 이것이 곧
버그로 보인다.

커서는 `(정렬키, id)` 복합값이다. 정렬키만 쓰면 값이 같은 행에서 순서가 불안정해 누락이
생기므로 `id` 를 tie-breaker 로 항상 붙인다.
"""

import base64
import json
import uuid
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal

from sqlalchemy import Select, and_, or_
from sqlalchemy.orm import InstrumentedAttribute

from sooljang.api.errors import ValidationFailedError

SortOrder = Literal["asc", "desc"]

#: 한 번에 가져올 최대 항목 수. 모바일 목록에서 과도한 페이로드를 막는다.
MAX_LIMIT = 200
DEFAULT_LIMIT = 50


@dataclass(frozen=True, slots=True)
class Cursor:
    """복합 커서. 정렬키 값과 tie-breaker id 를 담는다."""

    sort_value: Any
    id: uuid.UUID

    def encode(self) -> str:
        """URL 에 실을 수 있는 불투명 문자열로 만든다.

        불투명하게 만드는 이유는 클라이언트가 내부 구조에 의존하지 않게 하기 위해서다.
        나중에 정렬 구현을 바꿔도 계약이 깨지지 않는다.
        """
        payload = json.dumps(
            {"v": _serialize(self.sort_value), "id": str(self.id)},
            separators=(",", ":"),
            ensure_ascii=False,
        )
        return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii").rstrip("=")

    @classmethod
    def decode(cls, raw: str) -> Cursor:
        """커서 문자열을 되돌린다. 잘못된 값은 검증 오류로 알린다."""
        try:
            padding = "=" * (-len(raw) % 4)
            payload = json.loads(base64.urlsafe_b64decode(raw + padding).decode("utf-8"))
            # 복원은 여기서 한 번만 한다. 사용처마다 역직렬화하면 빠뜨리기 쉽다.
            return cls(sort_value=_deserialize(payload["v"]), id=uuid.UUID(payload["id"]))
        except Exception as error:  # noqa: BLE001 - 원인을 구분해도 사용자 대응은 같다
            raise ValidationFailedError(
                "cursor 값을 해석할 수 없습니다. 첫 페이지부터 다시 요청하세요"
            ) from error


def _serialize(value: Any) -> Any:
    """JSON 으로 실을 수 있게 바꾼다. Decimal 은 문자열로 유지해 정밀도를 잃지 않는다."""
    if isinstance(value, Decimal):
        return {"__decimal__": str(value)}
    if isinstance(value, uuid.UUID):
        return str(value)
    if hasattr(value, "isoformat"):
        return {"__iso__": value.isoformat()}
    return value


def _deserialize(value: Any) -> Any:
    if isinstance(value, dict):
        if "__decimal__" in value:
            return Decimal(value["__decimal__"])
        if "__iso__" in value:
            return value["__iso__"]
    return value


@dataclass(frozen=True, slots=True)
class Page[T]:
    """페이지 결과. `next_cursor` 가 None 이면 마지막 페이지다."""

    items: list[T]
    next_cursor: str | None

    @property
    def has_more(self) -> bool:
        return self.next_cursor is not None


def normalize_limit(limit: int | None) -> int:
    """limit 을 허용 범위로 맞춘다."""
    if limit is None:
        return DEFAULT_LIMIT
    if limit < 1:
        raise ValidationFailedError("limit 은 1 이상이어야 합니다")
    return min(limit, MAX_LIMIT)


def apply_cursor(
    statement: Select[Any],
    *,
    sort_column: InstrumentedAttribute[Any],
    id_column: InstrumentedAttribute[uuid.UUID],
    cursor: Cursor | None,
    order: SortOrder,
) -> Select[Any]:
    """커서 이후 구간만 남기고 정렬을 적용한다.

    NULL 값 처리에 주의한다. PostgreSQL 의 기본은 ASC 에서 NULL 이 마지막인데, 커서 비교에
    NULL 이 들어가면 항상 거짓이 되어 나머지 페이지가 사라진다. `nulls_last()` 를 명시하고
    커서 값이 None 이면 id 만으로 비교한다.
    """
    ascending = order == "asc"
    sort_expression = sort_column.asc() if ascending else sort_column.desc()
    statement = statement.order_by(
        sort_expression.nullslast(), id_column.asc() if ascending else id_column.desc()
    )

    if cursor is None:
        return statement

    sort_value = cursor.sort_value
    if sort_value is None:
        # 정렬키가 NULL 인 구간에 들어왔다. 같은 NULL 그룹 안에서 id 로만 이어 간다.
        return statement.where(
            and_(
                sort_column.is_(None),
                id_column > cursor.id if ascending else id_column < cursor.id,
            )
        )

    if ascending:
        boundary = or_(
            sort_column > sort_value,
            and_(sort_column == sort_value, id_column > cursor.id),
            sort_column.is_(None),
        )
    else:
        boundary = or_(
            sort_column < sort_value,
            and_(sort_column == sort_value, id_column < cursor.id),
            # `nullslast()` 는 두 방향 다 NULL 을 맨 뒤로 보낸다 — 오름차순 분기처럼
            # 여기도 NULL 을 포함해야 한다. 안 그러면 커서 값이 NULL 이 아닌 순간부터
            # (즉 2페이지부터) NULL 키 행 전체가 경계 조건에 안 걸려 조용히 사라진다.
            sort_column.is_(None),
        )
    return statement.where(boundary)


def build_page[T](rows: list[T], *, limit: int, sort_value_of: Any, id_of: Any) -> Page[T]:
    """한 개 더 읽어 온 결과에서 다음 커서를 만든다.

    `limit + 1` 개를 요청해 마지막 항목이 있으면 다음 페이지가 있다는 뜻이다. 별도 COUNT
    쿼리를 돌리지 않아도 된다.
    """
    if len(rows) <= limit:
        return Page(items=rows, next_cursor=None)
    visible = rows[:limit]
    last = visible[-1]
    cursor = Cursor(sort_value=sort_value_of(last), id=id_of(last))
    return Page(items=visible, next_cursor=cursor.encode())
