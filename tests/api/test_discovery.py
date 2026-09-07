"""새 탐색의 인증·부분 결과·관심 원장·명시 적용 경계를 실제 API/DB로 확인한다."""

import uuid
from datetime import datetime
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from sooljang.application import discovery as service
from sooljang.application import external_sources
from sooljang.infrastructure.database.models import ExternalPriceObservation
from sooljang.infrastructure.database.session import get_session_factory
from sooljang.infrastructure.external.search import search_provider as real_search
from tests.api.test_external_sources import _create_source
from tests.api.test_provider_connections import create, patch
from tests.infrastructure.external.test_offers import ITEMS, SPEC


def search_transport(monkeypatch: pytest.MonkeyPatch, captured: list[httpx.Request]) -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "title": "가상 술 시음 후기",
                        "url": "https://review.example.org/drink",
                        "text": "확인 가능한 발췌",
                    }
                ]
            },
        )

    async def search(*args: Any, **kwargs: Any) -> Any:
        kwargs["transport"] = httpx.MockTransport(respond)
        return await real_search(*args, **kwargs)

    monkeypatch.setattr(service, "search_provider", search)


def test_new_search_requires_authentication_and_rejects_personal_payload(
    anon_client: TestClient, prefix: str
) -> None:
    response = anon_client.post(
        f"{prefix}/discovery/search", json={"connection_id": str(uuid.uuid4()), "query": "술"}
    )
    assert response.status_code == 401


def test_missing_inactive_and_ready_connections_are_independent(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[httpx.Request] = []
    search_transport(monkeypatch, calls)
    connection = create(api_client, prefix, kind="exa", values={"api_key": "synthetic-exa-value"})
    payload = {"connection_id": connection["id"], "query": "가상 술"}
    inactive = api_client.post(f"{prefix}/discovery/search", json=payload)
    assert inactive.status_code == 200 and inactive.json()["outcome"] == "invalid_configuration"
    assert calls == []
    patch(api_client, prefix, connection, is_active=True)
    ready = api_client.post(f"{prefix}/discovery/search", json=payload)
    assert ready.status_code == 200, ready.text
    assert ready.json()["outcome"] == "success" and len(ready.json()["documents"]) == 1
    assert ready.headers["cache-control"] == "no-store"
    assert "synthetic-exa" not in ready.text
    assert len(calls) == 1
    assert (
        api_client.post(
            f"{prefix}/discovery/search", json={**payload, "tasting_note": "개인 기록"}
        ).status_code
        == 422
    )
    assert (
        api_client.post(
            f"{prefix}/discovery/search", json={**payload, "connection_id": str(uuid.uuid4())}
        ).status_code
        == 404
    )
    missing = create(api_client, prefix, kind="exa", name="키 없는 연결")
    patch(api_client, prefix, missing, is_active=True)
    result = api_client.post(
        f"{prefix}/discovery/search", json={**payload, "connection_id": missing["id"]}
    )
    assert result.json()["outcome"] == "credential_unavailable"
    assert len(calls) == 1


def setup_lookup(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch, *, history: bool = True
) -> dict[str, Any]:
    source = _create_source(
        api_client,
        prefix,
        name="합성 판매",
        base_url="https://example.com",
        adapter_spec=SPEC,
        price_history_allowed=history,
        rate_limit_per_min=60,
    )
    actual = external_sources.fetch_snapshot

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/robots.txt":
            return httpx.Response(404)
        return httpx.Response(200, json={"results": ITEMS})

    async def fetch(*args: Any, **kwargs: Any) -> Any:
        kwargs["transport"] = httpx.MockTransport(respond)
        return await actual(*args, **kwargs)

    async def forbidden_llm(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("새 탐색은 LLM을 호출하지 않는다")

    monkeypatch.setattr(external_sources, "fetch_snapshot", fetch)
    monkeypatch.setattr(external_sources, "_maybe_llm_rematch", forbidden_llm)
    return source


def observation_count(client: TestClient) -> int:
    async def count() -> int:
        async with get_session_factory()() as session:
            return (
                await session.scalar(select(func.count()).select_from(ExternalPriceObservation))
            ) or 0

    assert client.portal is not None
    return client.portal.call(count)


@pytest.mark.parametrize("history", [True, False])
def test_unowned_lookup_is_ephemeral_and_interest_observations_keep_stable_identity(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch, history: bool
) -> None:
    source = setup_lookup(api_client, prefix, monkeypatch, history=history)
    identity = {"name": "Harbor 12y 700ml", "volumes_ml": [700], "age_years": "12"}
    payload = {"identity": identity, "source_ids": [source["id"]]}
    first = api_client.post(f"{prefix}/discovery/lookup", json=payload)
    assert first.status_code == 200, first.text
    assert len(first.json()[0]["offers"]) == 3
    assert observation_count(api_client) == 0
    before = api_client.get(f"{prefix}/stats/summary").json()
    interest = api_client.post(f"{prefix}/interests", json={"identity": identity}).json()
    assert api_client.get(f"{prefix}/stats/summary").json() == before
    second = api_client.post(
        f"{prefix}/discovery/interests/{interest['id']}/lookup", json={"source_ids": [source["id"]]}
    )
    assert second.status_code == 200, second.text
    offers = second.json()[0]["offers"]
    assert len(offers) == 3
    assert observation_count(api_client) == (3 if history else 0)
    assert all(("observation_id" in offer) == history for offer in offers)
    api_client.patch(
        f"{prefix}/interests/{interest['id']}",
        json={"expected_updated_at": interest["updated_at"], "archived": True},
    )
    archived = api_client.post(
        f"{prefix}/discovery/interests/{interest['id']}/lookup", json={"source_ids": [source["id"]]}
    )
    assert archived.status_code == 404


def test_external_apply_requires_selected_server_evidence_and_current_product_revision(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = setup_lookup(api_client, prefix, monkeypatch)
    from sooljang.infrastructure.external.adapter import AdapterResult

    async def fetch(*args: Any, **kwargs: Any) -> AdapterResult:
        return AdapterResult(
            source_url="https://example.com/item",
            fields={"abv": "46", "country": "Scotland", "personal_rating": "5"},
            raw_excerpt=None,
            degraded=False,
            warning=None,
            ok=True,
        )

    monkeypatch.setattr(service, "_fetch_source", fetch)
    result = api_client.post(
        f"{prefix}/discovery/lookup",
        json={"identity": {"name": "술"}, "source_ids": [source["id"]]},
    ).json()[0]
    assert result["applicable_fields"] == {"abv": "46", "country": "Scotland"}
    product = api_client.post(f"{prefix}/products", json={"name": "내 술", "abv": "40"}).json()
    payload = {
        "product_id": product["id"],
        "expected_updated_at": product["updated_at"],
        "evidence_token": result["evidence_token"],
        "selected_fields": ["abv"],
    }
    applied = api_client.post(f"{prefix}/discovery/apply", json=payload)
    assert applied.status_code == 200, applied.text
    actual = api_client.get(f"{prefix}/products/{product['id']}").json()
    assert (
        actual["abv"] == "46.00" and actual["country"] is None and actual["personal_rating"] is None
    )
    assert api_client.post(f"{prefix}/discovery/apply", json=payload).status_code == 409
    assert (
        api_client.post(
            f"{prefix}/discovery/apply", json={**payload, "evidence_token": "tampered"}
        ).status_code
        == 422
    )
    assert (
        api_client.post(
            f"{prefix}/discovery/apply", json={**payload, "selected_fields": ["personal_rating"]}
        ).status_code
        == 422
    )


def test_search_title_evidence_cannot_apply_after_connection_changes(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from datetime import UTC, datetime

    from sooljang.domain.discovery import SourceOutcome
    from sooljang.infrastructure.external.search import SearchDocument, SearchResult

    async def result(*args: Any, **kwargs: Any) -> SearchResult:
        return SearchResult(
            SourceOutcome.SUCCESS,
            [
                SearchDocument(
                    "doc",
                    "https://example.org/drink",
                    "example.org",
                    "Harbor 12y 46%",
                    "2024년에 작성한 글",
                    datetime.now(UTC),
                )
            ],
        )

    monkeypatch.setattr(service, "search_provider", result)
    connection = create(api_client, prefix, kind="exa", values={"api_key": "synthetic-exa-value"})
    activated = patch(api_client, prefix, connection, is_active=True).json()
    found = api_client.post(
        f"{prefix}/discovery/search", json={"connection_id": connection["id"], "query": "Harbor"}
    ).json()["documents"][0]
    assert found["applicable_fields"] == {"abv": "46.0", "age_years": "12.0"}
    assert "vintage" not in found["applicable_fields"]
    product = api_client.post(f"{prefix}/products", json={"name": "Harbor"}).json()
    patch(api_client, prefix, activated, is_active=False)
    response = api_client.post(
        f"{prefix}/discovery/apply",
        json={
            "product_id": product["id"],
            "expected_updated_at": product["updated_at"],
            "evidence_token": found["evidence_token"],
            "selected_fields": ["abv"],
        },
    )
    assert response.status_code == 409
    assert api_client.get(f"{prefix}/products/{product['id']}").json()["abv"] is None


def test_interest_failure_returns_original_observation_time_without_new_history(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = setup_lookup(api_client, prefix, monkeypatch)
    interest = api_client.post(
        f"{prefix}/interests",
        json={
            "identity": {"name": "Harbor 12y 700ml"},
            "source_matches": {
                source["id"]: {
                    "product_key": "harbor-12",
                    "external_url": "https://example.com/item/1",
                    "external_name": "Harbor 12y 700ml",
                    "external_key": "1",
                }
            },
        },
    ).json()
    path = f"{prefix}/discovery/interests/{interest['id']}/lookup"
    payload = {"source_ids": [source["id"]]}
    first = api_client.post(path, json=payload)
    assert first.status_code == 200, first.text
    assert first.json()[0]["pinned"] and observation_count(api_client) == 3
    original_time = first.json()[0]["offers"][0]["fetched_at"]
    from sooljang.domain.discovery import SourceOutcome
    from sooljang.infrastructure.external.adapter import AdapterResult

    async def failed(*args: Any, **kwargs: Any) -> AdapterResult:
        return AdapterResult(None, {}, None, True, "일시 실패", outcome=SourceOutcome.NETWORK_ERROR)

    monkeypatch.setattr(service, "_fetch_source", failed)
    second = api_client.post(path, json=payload)
    assert second.status_code == 200, second.text
    result = second.json()[0]
    assert result["degraded"] and len(result["offers"]) == 3
    assert all(
        row["last_good"]
        and datetime.fromisoformat(row["fetched_at"]) == datetime.fromisoformat(original_time)
        for row in result["offers"]
    )
    assert observation_count(api_client) == 3


@pytest.mark.parametrize("changed_target", ["interest", "source"])
def test_edit_during_lookup_cannot_persist_stale_prices(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch, changed_target: str
) -> None:
    from sqlalchemy import update

    from sooljang.infrastructure.database.models import ExternalSource
    from sooljang.infrastructure.database.models.interest import Interest

    source = setup_lookup(api_client, prefix, monkeypatch)
    interest = api_client.post(
        f"{prefix}/interests", json={"identity": {"name": "Harbor 12y 700ml"}}
    ).json()
    original = service._fetch_source

    async def change_after_response(*args: Any, **kwargs: Any) -> Any:
        result = await original(*args, **kwargs)
        async with get_session_factory()() as edit, edit.begin():
            if changed_target == "interest":
                await edit.execute(
                    update(Interest)
                    .where(Interest.id == uuid.UUID(interest["id"]))
                    .values(name="다른 술", identity={"name": "다른 술"})
                )
            else:
                await edit.execute(
                    update(ExternalSource)
                    .where(ExternalSource.id == uuid.UUID(source["id"]))
                    .values(config_revision=ExternalSource.config_revision + 1)
                )
        return result

    monkeypatch.setattr(service, "_fetch_source", change_after_response)
    response = api_client.post(
        f"{prefix}/discovery/interests/{interest['id']}/lookup", json={"source_ids": [source["id"]]}
    )
    if changed_target == "interest":
        assert response.status_code == 409, response.text
    else:
        assert response.status_code == 200, response.text
        assert (
            response.json()[0]["offers"] == []
            and response.json()[0]["outcome"] == "invalid_configuration"
        )
    assert observation_count(api_client) == 0


def test_product_discovery_keeps_existing_pin_and_never_uses_opt_in_llm(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = setup_lookup(api_client, prefix, monkeypatch)
    product = api_client.post(
        f"{prefix}/products", json={"name": "Harbor 12y 700ml", "skus": [{"volume_ml": 700}]}
    ).json()
    pinned = api_client.post(
        f"{prefix}/products/{product['id']}/external-matches",
        json={
            "source_id": source["id"],
            "external_url": "https://example.com/item/1",
            "external_name": "Harbor 12y 700ml",
            "external_key": "1",
            "external_product_key": "harbor-12",
            "preferred_seller_key": "Shop 2",
        },
    )
    assert pinned.status_code == 201, pinned.text
    context = api_client.get(f"{prefix}/discovery/products/{product['id']}/context")
    assert context.status_code == 200, context.text
    assert context.headers["cache-control"] == "no-store"
    copied = api_client.post(
        f"{prefix}/interests",
        json={
            "identity": context.json()["identity"],
            "source_matches": context.json()["source_matches"],
        },
    )
    assert copied.status_code == 201, copied.text
    original_pin = copied.json()["source_matches"][source["id"]]
    assert original_pin["external_key"] == "1" and original_pin["product_key"] == "harbor-12"
    assert original_pin["preferred_seller_key"] == "Shop 2"
    assert copied.json()["identity"]["volumes_ml"] == [700]
    path = f"{prefix}/discovery/products/{product['id']}/lookup"
    first = api_client.post(path, json={"source_ids": [source["id"]]})
    assert first.status_code == 200, first.text
    result = first.json()[0]
    assert result["pinned"] and result["preferred_seller_key"] == "Shop 2"
    assert len(result["offers"]) == 3 and observation_count(api_client) == 3
    second = api_client.post(path, json={"source_ids": [source["id"]]})
    assert second.json()[0]["cached"] and second.json()[0]["pinned"]
    assert observation_count(api_client) == 3
    assert api_client.post(path, json={"source_ids": [str(uuid.uuid4())]}).status_code == 404

    # 애매한 새 결과여도 기존 선택형 LLM helper를 호출하면 fixture가 실패한다.
    from sqlalchemy import delete

    from sooljang.infrastructure.database.models import ExternalLookupCache
    from sooljang.infrastructure.external.adapter import AdapterResult

    async def clear_cache() -> None:
        async with get_session_factory()() as session, session.begin():
            await session.execute(delete(ExternalLookupCache))

    assert api_client.portal is not None
    api_client.portal.call(clear_cache)

    async def ambiguous(*args: Any, **kwargs: Any) -> AdapterResult:
        return AdapterResult(None, {}, None, False, None, needs_confirmation=True)

    monkeypatch.setattr(external_sources, "_fetch_source", ambiguous)
    ambiguous_response = api_client.post(path, json={"source_ids": [source["id"]]})
    assert ambiguous_response.status_code == 200
    assert ambiguous_response.json()[0]["llm_recommended_url"] is None
