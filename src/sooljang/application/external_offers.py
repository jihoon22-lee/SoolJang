"""실제 취득만 가격 관측으로 기록한다. 실패·캐시 반환은 이 경로에 넣지 않는다."""

import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from sooljang.infrastructure.database.models import ExternalOffer, ExternalPriceObservation
from sooljang.infrastructure.external.matching import ProductIdentity, score_details
from sooljang.infrastructure.external.offers import prepare_offer, raw_offer


async def record_offers(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    source_id: uuid.UUID,
    product_id: uuid.UUID | None,
    fetched_at: datetime,
    offers: list[dict[str, Any]],
    interest_id: uuid.UUID | None = None,
) -> list[dict[str, Any]]:
    """동일 acquisition 재처리는 멱등. 미발견 offer의 마지막 관측은 보존한다."""
    if (product_id is None) == (interest_id is None):
        raise ValueError("제품 또는 관심 대상 하나가 필요합니다")
    target_column = "interest_id" if interest_id is not None else "product_id"
    result = []
    for offer in offers:
        row = insert(ExternalOffer).values(
            id=uuid.uuid4(),
            user_id=user_id,
            source_id=source_id,
            product_id=product_id,
            interest_id=interest_id,
            external_product_key=offer["product_key"],
            external_offer_key=offer["offer_key"],
            condition_key=offer["condition_key"],
            last_seen_at=fetched_at,
        )
        row = row.on_conflict_do_update(
            index_elements=["source_id", target_column, "condition_key"],
            set_={"last_seen_at": func.greatest(ExternalOffer.last_seen_at, fetched_at)},
        ).returning(ExternalOffer.id)
        offer_id = (await session.execute(row)).scalar_one()
        observation_id = uuid.uuid5(offer_id, fetched_at.astimezone(UTC).isoformat())
        await session.execute(
            insert(ExternalPriceObservation)
            .values(
                id=observation_id,
                user_id=user_id,
                offer_id=offer_id,
                amount=Decimal(offer["amount"]),
                currency=offer["currency"],
                source_url=offer["source_url"],
                fetched_at=fetched_at,
                facts=raw_offer(offer),
            )
            .on_conflict_do_nothing(index_elements=["offer_id", "fetched_at"])
        )
        result.append(
            {**offer, "observation_id": str(observation_id), "fetched_at": fetched_at.isoformat()}
        )
    return result


async def last_observed_offers(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    source_id: uuid.UUID,
    product_id: uuid.UUID | None,
    identity: ProductIdentity,
    pinned_product_key: str | None,
    interest_id: uuid.UUID | None = None,
) -> list[dict[str, Any]]:
    """조회 실패 때 최신 관측을 원래 시각과 함께 제공한다. 품절·새 관측으로 바꾸지 않는다."""
    observations = await session.scalars(
        select(ExternalPriceObservation)
        .join(ExternalOffer, ExternalOffer.id == ExternalPriceObservation.offer_id)
        .where(
            ExternalPriceObservation.user_id == user_id,
            ExternalOffer.user_id == user_id,
            ExternalOffer.source_id == source_id,
            ExternalOffer.product_id == product_id,
            ExternalOffer.interest_id == interest_id,
        )
        .distinct(ExternalPriceObservation.offer_id)
        .order_by(ExternalPriceObservation.offer_id, ExternalPriceObservation.fetched_at.desc())
        .limit(100)
    )
    result = []
    for observation in observations:
        facts = observation.facts
        if pinned_product_key is not None and facts["product_key"] != pinned_product_key:
            continue
        offer = prepare_offer(
            product_key=facts["product_key"],
            offer_key=facts["offer_key"],
            name=facts["name"],
            url=observation.source_url,
            fields=facts,
            identity=identity,
            confirmed=pinned_product_key == facts["product_key"]
            or score_details(identity, facts["name"], facts).value >= 0.85,
        )
        if offer is not None:
            result.append(
                {
                    **offer,
                    "fetched_at": observation.fetched_at.isoformat(),
                    "observation_id": str(observation.id),
                    "last_good": True,
                }
            )
    return result
