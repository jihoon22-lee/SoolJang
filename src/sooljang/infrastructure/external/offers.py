"""허용된 응답의 판매 사실을 정리한다. 결측 조건이나 다른 규격은 비교하지 않는다."""

import hashlib
import json
import math
from decimal import Decimal, InvalidOperation
from typing import Any

from sooljang.infrastructure.external.matching import (
    ProductIdentity,
    detail_name,
    parse_name,
    score_details,
)


def prepare_offer(
    *,
    product_key: str,
    offer_key: str,
    name: str,
    url: str,
    fields: dict[str, Any],
    identity: ProductIdentity,
    confirmed: bool,
) -> dict[str, Any] | None:
    """가격은 원통화 문자열로 보존한다. 검색 발췌·미확인 조건은 최저가 집계에서 제외한다."""
    raw_amount = fields.get("amount", fields.get("price_krw", fields.get("price")))
    try:
        amount = Decimal(str(raw_amount))
    except InvalidOperation, ValueError:
        return None
    exponent = amount.as_tuple().exponent
    if (
        not amount.is_finite()
        or amount < 0
        or amount >= Decimal("1e14")
        or not isinstance(exponent, int)
        or exponent < -4
    ):
        return None
    facts = parse_name(detail_name(name, fields))
    currency = fields.get("currency", "KRW" if "price_krw" in fields else None)
    if (
        not isinstance(currency, str)
        or len(currency) != 3
        or not currency.isascii()
        or not currency.isalpha()
    ):
        return None
    volume = fields.get("volume_ml", facts.volume_ml)
    if (
        isinstance(volume, bool)
        or not isinstance(volume, (int, float))
        or not math.isfinite(volume)
        or volume <= 0
    ):
        volume = None
    units = fields.get("units", facts.pack_count)
    if isinstance(units, bool) or not isinstance(units, int) or units < 1:
        units = None
    result: dict[str, Any] = {
        "product_key": product_key,
        "offer_key": offer_key,
        "name": name,
        "source_url": url,
        "amount": str(amount),
        "currency": currency.upper(),
        "volume_ml": volume,
        "vintage": facts.vintage,
        "age_years": facts.age_years,
        "abv": facts.abv,
        "producer": None,
        "units": units,
        "is_set": facts.is_set,
        "seller_key": None,
        "seller_name": None,
        "branch": None,
        "price_kind": None,
        "membership": None,
        "coupon": None,
        "fulfillment": None,
        "region": None,
        "shipping": None,
        "tax": None,
        "in_stock": None,
        "source_observed_at": None,
        "comparison_group": None,
        "collection_scope": "검색 응답에 포함된 판매 조건",
    }
    for key in result.keys() & fields.keys() - {
        "product_key",
        "offer_key",
        "name",
        "source_url",
        "amount",
        "currency",
        "volume_ml",
        "units",
        "is_set",
        "comparison_group",
    }:
        value = fields[key]
        if isinstance(value, Decimal) and key in {"vintage", "age_years", "abv"}:
            value = float(value)
        if isinstance(value, float) and not math.isfinite(value):
            continue
        if value is None or isinstance(value, (str, bool, int, float)):
            result[key] = value
    if not isinstance(result["in_stock"], bool):
        result["in_stock"] = None
    judgment = score_details(identity, name, fields)
    result["relationship"] = judgment.relationship
    result["needs_confirmation"] = (
        not confirmed or bool(judgment.conflicts) or bool(judgment.missing)
    )
    condition_keys = (
        "price_kind",
        "membership",
        "coupon",
        "fulfillment",
        "region",
        "shipping",
        "tax",
    )
    # unknown != confirmed-none. 미기재 조건을 일반가/무료배송으로 가정하지 않는다.
    if (
        not result["needs_confirmation"]
        and volume is not None
        and units is not None
        and not facts.is_set
        and all(result[key] is not None for key in condition_keys)
        and result["price_kind"] not in {"snippet", "recommended"}
        and result["in_stock"] is not False
    ):
        comparison = [
            currency.upper(),
            volume,
            units,
            facts.age_years,
            facts.vintage,
            facts.abv,
            facts.batch,
            facts.cask,
            *(result[key] for key in condition_keys),
        ]
        result["comparison_group"] = hashlib.sha256(
            json.dumps(comparison, ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest()[:24]
    # 조건이 바뀌면 같은 공급자 offer ID여도 별도의 판매 조건 identity다.
    identity_fields = [
        product_key,
        offer_key,
        url,
        result["seller_key"],
        result["branch"],
        volume,
        units,
        facts.is_set,
        *(result[key] for key in condition_keys),
    ]
    result["condition_key"] = hashlib.sha256(
        json.dumps(identity_fields, ensure_ascii=False).encode()
    ).hexdigest()
    return result


def raw_offer(offer: dict[str, Any]) -> dict[str, Any]:
    """재계산 가능한 매칭/비교 지표와 응답 ID는 관측 사실에 저장하지 않는다."""
    return {
        key: value
        for key, value in offer.items()
        if key
        not in {
            "comparison_group",
            "relationship",
            "needs_confirmation",
            "observation_id",
            "fetched_at",
        }
    }
