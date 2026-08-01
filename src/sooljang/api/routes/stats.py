"""통계 라우터. 랭킹·주종별 집계·전체 합계.

`docs/architecture.md` §4.2 통계 v1. 결과가 항상 작고 고정 크기라 `api/routes/purchases.py`
와 같은 판단으로 커서 페이지네이션을 쓰지 않는다.
"""

from typing import Annotated

from fastapi import APIRouter, Query

from sooljang.api.deps import SessionDep, UserDep
from sooljang.api.schemas.stats import (
    CategoryStatOut,
    RankingEntryOut,
    RankingsOut,
    StatsSummaryOut,
)
from sooljang.application.stats import (
    DEFAULT_RANKING_LIMIT,
    CategoryStat,
    RankingEntry,
    Rankings,
    StatsSummary,
    get_category_rollup,
    get_rankings,
    get_summary,
)

router = APIRouter(prefix="/stats", tags=["stats"])


def _entry_out(entry: RankingEntry) -> RankingEntryOut:
    return RankingEntryOut(
        product_id=entry.product_id, product_name=entry.product_name, value=entry.value
    )


def _rankings_out(rankings: Rankings) -> RankingsOut:
    return RankingsOut(
        by_bottle_price=[_entry_out(e) for e in rankings.by_bottle_price],
        by_total_spend=[_entry_out(e) for e in rankings.by_total_spend],
        by_price_per_100ml=[_entry_out(e) for e in rankings.by_price_per_100ml],
        by_personal_rating=[_entry_out(e) for e in rankings.by_personal_rating],
    )


def _category_out(stat: CategoryStat) -> CategoryStatOut:
    return CategoryStatOut(
        category_id=stat.category_id,
        name=stat.name,
        bottle_count=stat.bottle_count,
        total_spend=stat.total_spend,
        avg_abv=stat.avg_abv,
        avg_rating=stat.avg_rating,
        avg_price_per_100ml=stat.avg_price_per_100ml,
        discount_rate=stat.discount_rate,
    )


def _summary_out(summary: StatsSummary) -> StatsSummaryOut:
    return StatsSummaryOut(
        purchased_count=summary.purchased_count,
        consumed_count=summary.consumed_count,
        in_stock_count=summary.in_stock_count,
        unopened_count=summary.unopened_count,
        opened_count=summary.opened_count,
        total_volume_ml=summary.total_volume_ml,
        list_total=summary.list_total,
        paid_total=summary.paid_total,
        avg_list_price=summary.avg_list_price,
        avg_paid_price=summary.avg_paid_price,
        avg_price_per_100ml=summary.avg_price_per_100ml,
        discount_rate=summary.discount_rate,
        avg_personal_rating=summary.avg_personal_rating,
        vendor_count=summary.vendor_count,
    )


@router.get("/rankings", response_model=RankingsOut, summary="랭킹 4종")
async def list_rankings(
    session: SessionDep,
    user_id: UserDep,
    limit: Annotated[int, Query(ge=1, le=50, description="랭킹당 상위 건수")] = (
        DEFAULT_RANKING_LIMIT
    ),
) -> RankingsOut:
    """병당 가격·총 구매액·100ml당 가격·개인 평점 랭킹.

    병당 가격·총 구매액은 실구매가 기준, 100ml당 가격은 정가 기준이다
    (근거는 `application/stats.py` 모듈 docstring 참조).
    """
    rankings = await get_rankings(session, user_id=user_id, limit=limit)
    return _rankings_out(rankings)


@router.get("/by-category", response_model=list[CategoryStatOut], summary="주종별 집계")
async def list_by_category(session: SessionDep, user_id: UserDep) -> list[CategoryStatOut]:
    """최상위 주종별 병수·총액·평균 도수·평균 평점·평균 100ml가·할인율."""
    stats = await get_category_rollup(session, user_id=user_id)
    return [_category_out(stat) for stat in stats]


@router.get("/summary", response_model=StatsSummaryOut, summary="전체 합계")
async def get_summary_route(session: SessionDep, user_id: UserDep) -> StatsSummaryOut:
    """전체 컬렉션 합계. `docs/legacy-schema.md` §5 대조 기준값과 대응한다."""
    summary = await get_summary(session, user_id=user_id)
    return _summary_out(summary)
