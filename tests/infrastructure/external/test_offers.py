"""합성 3매장·규격/조건 분리와 고정 제품 전체 판매 취득."""

import json
from copy import deepcopy
from decimal import Decimal
from typing import Any

import httpx
import pytest

from sooljang.infrastructure.external.adapter import PinnedMatch, fetch_snapshot, reset_robots_cache
from sooljang.infrastructure.external.matching import ProductIdentity
from sooljang.infrastructure.external.offers import prepare_offer, raw_offer

IDENTITY = ProductIdentity(name="Harbor 12y 700ml")
CONDITIONS: dict[str, Any] = {
    "price_kind": "listed",
    "membership": "none",
    "coupon": "none",
    "fulfillment": "pickup",
    "region": "Seoul",
    "shipping": "none",
    "tax": "included",
}
SPEC: dict[str, Any] = {
    "format": "json",
    "search": {
        "url_template": "https://example.com/search?q={query}",
        "item": "results",
        "fields": {
            "name": {"path": "name"},
            "url": {"url_template": "https://example.com/item/{id}"},
            "product_key": {"path": "product"},
        },
        "result_fields": {"price_krw": {"path": "price"}},
        "offer_fields": {
            **{key: {"const": value} for key, value in CONDITIONS.items()},
            "seller_name": {"path": "seller"},
        },
    },
}
ITEMS = [
    {
        "id": str(index),
        "product": "harbor-12",
        "name": "Harbor 12y 700ml",
        "price": price,
        "seller": f"Shop {index}",
    }
    for index, price in enumerate((60000, 59000, 58000), 1)
]


def offer(**changes: Any) -> dict[str, Any]:
    result = prepare_offer(
        product_key="harbor-12",
        offer_key="offer-1",
        name="Harbor 12y 700ml",
        url="https://example.com/item/1",
        fields={"price_krw": 60000, **CONDITIONS, **changes},
        identity=IDENTITY,
        confirmed=True,
    )
    assert result is not None
    return result


@pytest.mark.parametrize("field", list(CONDITIONS))
def test_missing_condition_is_not_assumed_to_be_standard(field: str) -> None:
    assert offer(**{field: None})["comparison_group"] is None


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("membership", "member"),
        ("coupon", "coupon"),
        ("region", "Busan"),
        ("currency", "USD"),
        ("volume_ml", 1000),
        ("units", 2),
    ],
)
def test_other_conditions_are_compared_separately(field: str, value: Any) -> None:
    assert offer(**{field: value})["comparison_group"] != offer()["comparison_group"]


@pytest.mark.parametrize("amount", [None, "NaN", "Infinity", -1, "100000000000000", "1.00001"])
def test_invalid_price_is_not_a_new_observation(amount: Any) -> None:
    assert (
        prepare_offer(
            product_key="p",
            offer_key="o",
            name="Harbor",
            url="https://example.com/item/1",
            fields={"price_krw": amount},
            identity=IDENTITY,
            confirmed=True,
        )
        is None
    )


def test_raw_observation_excludes_derived_comparison() -> None:
    assert "comparison_group" not in raw_offer(offer())
    assert offer(price_krw=0)["amount"] == "0"


@pytest.mark.parametrize("candidate_vintage", [2021, 2020])
def test_structured_edition_evidence_survives_observation_round_trip(
    candidate_vintage: int,
) -> None:
    identity = ProductIdentity(
        name="Lumiere", vintage=2021, abv=Decimal("13.5"), volumes_ml=(750,), producer="Maison"
    )
    fresh = prepare_offer(
        product_key="wine",
        offer_key="shop",
        name="Lumiere",
        url="https://example.com/wine",
        fields={
            **CONDITIONS,
            "price_krw": 50000,
            "volume_ml": 750,
            "vintage": candidate_vintage,
            "abv": Decimal("13.5"),
            "producer": "Maison",
        },
        identity=identity,
        confirmed=True,
    )
    assert fresh is not None
    stored = json.loads(json.dumps(raw_offer(fresh)))
    assert stored["vintage"] == candidate_vintage
    assert stored["producer"] == "Maison"
    restored = prepare_offer(
        product_key=stored["product_key"],
        offer_key=stored["offer_key"],
        name=stored["name"],
        url=stored["source_url"],
        fields=stored,
        identity=identity,
        confirmed=True,
    )
    assert restored is not None
    assert restored["needs_confirmation"] is (candidate_vintage != 2021)
    assert restored["comparison_group"] == fresh["comparison_group"]


def test_name_detail_vintage_conflict_remains_unconfirmed_after_storage() -> None:
    identity = ProductIdentity(name="Lumiere", vintage=2021, volumes_ml=(750,))
    fresh = prepare_offer(
        product_key="wine",
        offer_key="shop",
        name="Lumiere 2021",
        url="https://example.com/wine",
        fields={**CONDITIONS, "price_krw": 50000, "volume_ml": 750, "vintage": 2020},
        identity=identity,
        confirmed=True,
    )
    assert fresh is not None
    stored = raw_offer(fresh)
    restored = prepare_offer(
        product_key=stored["product_key"],
        offer_key=stored["offer_key"],
        name=stored["name"],
        url=stored["source_url"],
        fields=stored,
        identity=identity,
        confirmed=True,
    )
    assert restored is not None and restored["needs_confirmation"]
    assert restored["comparison_group"] is None


@pytest.mark.parametrize(
    "pinned",
    [
        None,
        PinnedMatch("https://example.com/item/1", "1"),
        PinnedMatch("https://example.com/old-item", "old", "harbor-12"),
    ],
)
async def test_three_sellers_survive_product_pin(pinned: PinnedMatch | None) -> None:
    reset_robots_cache()
    items = deepcopy(ITEMS)
    items.append(
        {**ITEMS[0], "id": "different", "product": "harbor-18", "name": "Harbor 18y 700ml"}
    )
    transport = httpx.MockTransport(
        lambda request: (
            httpx.Response(200, text="User-agent: *\nAllow: /")
            if request.url.path == "/robots.txt"
            else httpx.Response(200, json={"results": items})
        )
    )
    result = await fetch_snapshot(
        SPEC, base_url="https://example.com", identity=IDENTITY, transport=transport, pinned=pinned
    )
    assert len(result.offers) == 3
    assert {entry["seller_name"] for entry in result.offers} == {"Shop 1", "Shop 2", "Shop 3"}
    assert len({entry["comparison_group"] for entry in result.offers}) == 1
    assert result.product_key == "harbor-12"


@pytest.mark.parametrize("later_status", [200, 500])
async def test_pagination_preserves_prior_prices_and_marks_partial_failure(
    later_status: int,
) -> None:
    reset_robots_cache()
    spec = deepcopy(SPEC)
    spec["search"]["pagination"] = {"next_path": "next"}
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text="User-agent: *\nAllow: /")
        if request.url.path == "/search":
            return httpx.Response(
                200, json={"results": ITEMS[:2], "next": "https://example.com/page2"}
            )
        return httpx.Response(later_status, json={"results": ITEMS[2:], "next": None})

    result = await fetch_snapshot(
        spec,
        base_url="https://example.com",
        identity=IDENTITY,
        transport=httpx.MockTransport(handler),
    )
    assert result.ok and len(result.offers) == (3 if later_status == 200 else 2)
    assert result.degraded is (later_status != 200)
    assert paths == ["/robots.txt", "/search", "/page2"]


async def test_private_next_page_is_not_requested_and_first_page_is_retained() -> None:
    reset_robots_cache()
    spec = deepcopy(SPEC)
    spec["search"]["pagination"] = {"next_path": "next"}
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return (
            httpx.Response(200, text="User-agent: *\nAllow: /")
            if request.url.path == "/robots.txt"
            else httpx.Response(200, json={"results": ITEMS, "next": "http://127.0.0.1/private"})
        )

    result = await fetch_snapshot(
        spec,
        base_url="https://example.com",
        identity=IDENTITY,
        transport=httpx.MockTransport(handler),
    )
    assert result.ok and result.degraded and len(result.offers) == 3
    assert len(calls) == 2
