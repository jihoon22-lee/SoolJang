"""실제 두 DB 세션에서 원문 취득 중 고정/권한 변경과 선택 적용 취소를 확인한다."""

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from sooljang.application import external_sources
from sooljang.infrastructure.database.models import (
    ExternalLookupCache,
    ExternalProductMatch,
    ExternalSource,
)
from sooljang.infrastructure.database.session import get_session_factory
from tests.api.test_discovery import observation_count, setup_lookup


@pytest.mark.parametrize("change", ["history_disabled", "pin_changed"])
def test_product_lookup_discards_stale_result_after_source_or_pin_change(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch, change: str
) -> None:
    source = setup_lookup(api_client, prefix, monkeypatch)
    product = api_client.post(
        f"{prefix}/products", json={"name": "Harbor 12y 700ml", "skus": [{"volume_ml": 700}]}
    ).json()
    source_id, product_id = uuid.UUID(source["id"]), uuid.UUID(product["id"])
    if change == "pin_changed":
        response = api_client.post(
            f"{prefix}/products/{product_id}/external-matches",
            json={
                "source_id": str(source_id),
                "external_url": "https://example.com/item/1",
                "external_name": "Harbor 12y 700ml",
                "external_key": "1",
                "external_product_key": "harbor-12",
            },
        )
        assert response.status_code == 201, response.text
    original = external_sources._fetch_source

    async def change_after_network(*args: Any, **kwargs: Any) -> Any:
        result = await original(*args, **kwargs)
        async with get_session_factory()() as edit, edit.begin():
            if change == "history_disabled":
                await edit.execute(
                    update(ExternalSource)
                    .where(ExternalSource.id == source_id)
                    .values(
                        price_history_allowed=False,
                        config_revision=ExternalSource.config_revision + 1,
                    )
                )
            else:
                await edit.execute(
                    update(ExternalProductMatch)
                    .where(
                        ExternalProductMatch.source_id == source_id,
                        ExternalProductMatch.product_id == product_id,
                    )
                    .values(
                        external_url="https://example.com/item/other",
                        external_name="Other Malt 18y",
                        external_key="other",
                        external_product_key="other-product",
                    )
                )
        return result

    monkeypatch.setattr(external_sources, "_fetch_source", change_after_network)
    response = api_client.post(
        f"{prefix}/discovery/products/{product_id}/lookup", json={"source_ids": [str(source_id)]}
    )
    assert response.status_code == 200, response.text
    assert response.json()[0]["offers"] == [], response.text
    assert observation_count(api_client) == 0

    async def cached() -> bool:
        async with get_session_factory()() as session:
            cache = await session.scalar(
                select(ExternalLookupCache).where(ExternalLookupCache.product_id == product_id)
            )
            return cache is None

    assert api_client.portal is not None
    assert api_client.portal.call(cached)


def test_connection_revocation_before_product_lock_prevents_old_evidence_apply(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from datetime import UTC, datetime

    from sooljang.application import discovery, discovery_evidence
    from sooljang.domain.discovery import SourceOutcome
    from sooljang.infrastructure.database.models import ProviderConnection
    from sooljang.infrastructure.external.search import SearchDocument, SearchResult
    from tests.api.test_provider_connections import create, patch

    connection = create(
        api_client, prefix, kind="exa", values={"api_key": "synthetic-exa-test-value"}
    )
    patch(api_client, prefix, connection, is_active=True)

    async def response(*args: Any, **kwargs: Any) -> SearchResult:
        return SearchResult(
            SourceOutcome.SUCCESS,
            [
                SearchDocument(
                    "synthetic",
                    "https://example.com/malt",
                    "example.com",
                    "Malt 46%",
                    "Synthetic",
                    datetime.now(UTC),
                )
            ],
        )

    monkeypatch.setattr(discovery, "search_provider", response)
    evidence = api_client.post(
        f"{prefix}/discovery/search", json={"connection_id": connection["id"], "query": "Malt"}
    ).json()["documents"][0]["evidence_token"]
    product = api_client.post(
        f"{prefix}/products", json={"name": "Malt", "abv": "40", "skus": [{"volume_ml": 700}]}
    ).json()
    original = discovery_evidence.load_product

    async def revoke_before_product_lock(*args: Any, **kwargs: Any) -> Any:
        async with get_session_factory()() as edit, edit.begin():
            await edit.execute(
                update(ProviderConnection)
                .where(ProviderConnection.id == uuid.UUID(connection["id"]))
                .values(is_active=False, config_revision=ProviderConnection.config_revision + 1)
            )
        return await original(*args, **kwargs)

    monkeypatch.setattr(discovery_evidence, "load_product", revoke_before_product_lock)
    response = api_client.post(
        f"{prefix}/discovery/apply",
        json={
            "product_id": product["id"],
            "expected_updated_at": product["updated_at"],
            "evidence_token": evidence,
            "selected_fields": ["abv"],
        },
    )
    assert response.status_code == 409, response.text
    assert api_client.get(f"{prefix}/products/{product['id']}").json()["abv"] == "40.00"
