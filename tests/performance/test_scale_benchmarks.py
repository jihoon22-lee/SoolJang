"""실사용 규모·10배 규모 성능 측정(Task 21).

`docs/plan.md` Task 21 이 요구하는 "429 제품 / 1,078병 기준, 10배 규모 합성 데이터"
응답 시간 측정이다. 매 CI 실행마다 수천~만 건을 심는 비용을 치르지 않도록
opt-in 이다(`live_llm`·`requires_legacy_sheet` 와 같은 패턴) —
`SOOLJANG_RUN_BENCHMARKS=1` 이 없으면 스스로 건너뛴다.

측정값을 하드 기준으로 강제하지 않는다. CI 러너 성능이 매번 달라 미세한 지연을
"실패"로 처리하면 곧 무시하게 된다. 대신 "명백히 뭔가 잘못됐다"고 볼 수 있는 넉넉한
상한(수십 배 여유)만 검사하고, 실제 측정값은 표준 출력에 남겨 사람이 판단하게 한다.

    SOOLJANG_RUN_BENCHMARKS=1 SOOLJANG_DATABASE_URL=... \
        uv run pytest tests/performance -m benchmark -s
"""

import os
import random
import time
import uuid
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from sooljang.application.categories import make_slug
from sooljang.application.products import normalized_name_of
from sooljang.config import get_settings
from sooljang.infrastructure.database.models import (
    Bottle,
    BottleStatus,
    Category,
    Product,
    Purchase,
    Sku,
    Vendor,
)

pytestmark = pytest.mark.benchmark

#: 레거시 실측 규모(`docs/legacy-schema.md` §5).
REAL_SCALE_PRODUCTS = 429
REAL_SCALE_BOTTLES = 1078

CATEGORY_NAMES = ["위스키", "와인", "맥주", "사케", "전통주", "브랜디", "럼", "진"]
VENDOR_NAMES = [f"벤치마크구매처{i}" for i in range(15)]
COUNTRIES = ["대한민국", "스코틀랜드", "프랑스", "일본", "미국", None]


def _skip_unless_enabled() -> None:
    if not os.environ.get("SOOLJANG_RUN_BENCHMARKS"):
        pytest.skip("SOOLJANG_RUN_BENCHMARKS=1 이 없으면 건너뛴다 (Task 21 opt-in 성능 측정)")


async def _seed_scale(
    session: AsyncSession, *, user_id: uuid.UUID, product_count: int, total_bottles: int
) -> None:
    """제품·구매·병을 대량으로 심는다. ORM 객체를 만들되 왕복은 몇 번의 flush 로 줄인다."""
    rng = random.Random(42)  # 재현 가능한 분포 — 실행마다 다른 조건을 재는 걸 피한다.

    categories = [
        Category(user_id=user_id, name=name, slug=make_slug(name)) for name in CATEGORY_NAMES
    ]
    vendors = [Vendor(user_id=user_id, name=name) for name in VENDOR_NAMES]
    session.add_all(categories)
    session.add_all(vendors)
    await session.flush()

    bottles_left = total_bottles
    for i in range(product_count):
        # 마지막 제품이 나머지를 전부 가져가 총 병수가 정확히 맞게 한다.
        remaining_products = product_count - i
        quantity = (
            max(1, bottles_left // remaining_products)
            if i < product_count - 1
            else max(1, bottles_left)
        )
        bottles_left -= quantity

        product_name = f"벤치마크 술 {i:05d}"
        product = Product(
            user_id=user_id,
            name=product_name,
            normalized_name=normalized_name_of(product_name),
            category_id=rng.choice(categories).id,
            country=rng.choice(COUNTRIES),
            vintage=rng.choice([None, 2015, 2018, 2020, 2023]),
            abv=Decimal(str(rng.choice([40.0, 43.0, 12.5, 5.0, 46.0]))),
            personal_rating=Decimal(rng.choice(["3.0", "4.0", "4.5", "5.0", "6.0"]))
            if rng.random() > 0.2
            else None,
        )
        session.add(product)
        await session.flush()

        sku = Sku(
            user_id=user_id, product_id=product.id, volume_ml=rng.choice([350, 500, 700, 750])
        )
        session.add(sku)
        await session.flush()

        purchase = Purchase(
            user_id=user_id,
            sku_id=sku.id,
            vendor_id=rng.choice(vendors).id,
            quantity=quantity,
            unit_list_price=Decimal(str(rng.randint(10, 300) * 1000)),
            unit_paid_price=Decimal(str(rng.randint(8, 280) * 1000)),
        )
        session.add(purchase)
        await session.flush()

        bottles = [
            Bottle(
                user_id=user_id,
                purchase_id=purchase.id,
                label_no=n + 1,
                status=rng.choice(
                    [BottleStatus.UNOPENED, BottleStatus.UNOPENED, BottleStatus.FINISHED]
                ),
            )
            for n in range(quantity)
        ]
        session.add_all(bottles)

        # 500 제품마다 한 번씩만 커밋해 트랜잭션 로그 부담을 줄인다.
        if i % 500 == 499:
            await session.commit()

    await session.commit()


async def _seed_via_direct_session(
    *, user_id: uuid.UUID, product_count: int, total_bottles: int
) -> None:
    """대량 시딩 전용 엔진으로 직접 쓰고, 끝나면 통계를 갱신한다.

    별도 엔진을 쓰는 이유: `get_session_factory()`(프로세스 전역 `@lru_cache`)를
    그대로 쓰면 `api_client` fixture 가 `TestClient` 의 anyio 포털 스레드에서 이미
    만들어 둔 엔진을 이 테스트 함수 자신의 이벤트 루프에서 재사용하게 된다. 두 루프가
    같은 엔진을 공유하는 상황 자체를 피하려고 시딩 전용 엔진을 새로 만들고 끝나면
    바로 정리한다.

    `ANALYZE` 를 직접 도는 이유(Task 21 실측): 이 함수처럼 한 트랜잭션에서 수백~수천
    행을 한꺼번에 넣으면, autovacuum 의 자동 ANALYZE 가 따라잡기 전(보통 수십 초~1분)
    바로 뒤이어 도는 조회 쿼리는 플래너가 옛 통계(빈 테이블 기준)로 `user_id` 선택도를
    오판해 해시 조인 대신 중첩 루프를 고르고, 서브쿼리가 행마다 재실행되는 최악의
    플랜을 짤 수 있다 — 429행 기준 정상 4~6ms 가 25~30초로 실측됐다. 이 함수 자체가
    바로 이런 대량 삽입이므로 실제 운영 임포트 경로(`application/legacy_import.py::
    apply_plan`)에 적용한 것과 같은 처방을 여기서도 적용해, 이 벤치마크가 "방금 막
    끝난 대량 삽입 직후의 통계 공백"이 아니라 "정상 운영 중(autovacuum 이 따라잡은)
    응답 시간"을 재도록 한다.
    """
    settings = get_settings()
    engine = create_async_engine(str(settings.database_url))
    try:
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as session:
            await _seed_scale(
                session, user_id=user_id, product_count=product_count, total_bottles=total_bottles
            )
        async with engine.begin() as conn:
            for table in ("category", "vendor", "product", "sku", "purchase", "bottle"):
                await conn.execute(text(f"ANALYZE {table}"))
    finally:
        await engine.dispose()


def _time_get(
    client: TestClient, path: str, *, params: dict[str, Any] | None = None
) -> tuple[float, int]:
    start = time.perf_counter()
    response = client.get(path, params=params)
    elapsed = time.perf_counter() - start
    return elapsed, response.status_code


def _time_post(client: TestClient, path: str, json: dict) -> tuple[float, int]:
    start = time.perf_counter()
    response = client.post(path, json=json)
    elapsed = time.perf_counter() - start
    return elapsed, response.status_code


def _report(label: str, product_count: int, bottle_count: int, elapsed: float, status: int) -> None:
    print(  # noqa: T201 - 벤치마크 결과는 사람이 읽어야 한다. -s 없이 돌리면 어차피 버려진다.
        f"[benchmark] {label}: 제품 {product_count}건·병 {bottle_count}건 → "
        f"{elapsed * 1000:.1f}ms (status={status})"
    )


@pytest.mark.timeout(180)
async def test_실사용_규모_응답_시간(api_client: TestClient, api_user_id: uuid.UUID) -> None:
    _skip_unless_enabled()
    await _seed_via_direct_session(
        user_id=api_user_id,
        product_count=REAL_SCALE_PRODUCTS,
        total_bottles=REAL_SCALE_BOTTLES,
    )
    _run_and_report(api_client, "실사용 규모(429/1,078)", REAL_SCALE_PRODUCTS, REAL_SCALE_BOTTLES)


@pytest.mark.timeout(300)
async def test_10배_규모_응답_시간(api_client: TestClient, api_user_id: uuid.UUID) -> None:
    _skip_unless_enabled()
    products = REAL_SCALE_PRODUCTS * 10
    bottles = REAL_SCALE_BOTTLES * 10
    await _seed_via_direct_session(
        user_id=api_user_id, product_count=products, total_bottles=bottles
    )
    _run_and_report(api_client, "10배 규모(4,290/10,780)", products, bottles)


def _run_and_report(client: TestClient, label: str, product_count: int, bottle_count: int) -> None:
    prefix = "/api/v1"

    elapsed, status = _time_get(client, f"{prefix}/products", params={"limit": 50})
    assert status == 200
    _report(
        f"{label} — GET /products (첫 페이지 50건)", product_count, bottle_count, elapsed, status
    )
    assert elapsed < 5.0, f"제품 목록 조회가 비정상적으로 느리다: {elapsed:.2f}s"

    elapsed, status = _time_get(client, f"{prefix}/stats/summary")
    assert status == 200
    _report(f"{label} — GET /stats/summary", product_count, bottle_count, elapsed, status)
    assert elapsed < 10.0, f"전체 합계 조회가 비정상적으로 느리다: {elapsed:.2f}s"

    elapsed, status = _time_get(client, f"{prefix}/stats/by-category")
    assert status == 200
    _report(f"{label} — GET /stats/by-category", product_count, bottle_count, elapsed, status)
    assert elapsed < 10.0, f"주종별 집계가 비정상적으로 느리다: {elapsed:.2f}s"

    elapsed, status = _time_get(client, f"{prefix}/stats/rankings")
    assert status == 200
    _report(f"{label} — GET /stats/rankings", product_count, bottle_count, elapsed, status)
    assert elapsed < 10.0, f"랭킹 조회가 비정상적으로 느리다: {elapsed:.2f}s"

    elapsed, status = _time_post(
        client,
        f"{prefix}/stats/pivot",
        {"row_dimension": "vendor", "column_dimension": "category", "metric": "discount_rate"},
    )
    assert status == 200
    _report(
        f"{label} — POST /stats/pivot(구매처×주종)", product_count, bottle_count, elapsed, status
    )
    assert elapsed < 15.0, f"피벗 계산이 비정상적으로 느리다: {elapsed:.2f}s"

    elapsed, status = _time_get(client, f"{prefix}/stats/timeseries")
    assert status == 200
    _report(f"{label} — GET /stats/timeseries", product_count, bottle_count, elapsed, status)
    assert elapsed < 10.0, f"시계열 조회가 비정상적으로 느리다: {elapsed:.2f}s"
