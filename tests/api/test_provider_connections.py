"""등록/검증/사용 분리, revision 충돌, 키 보존과 사용자 격리를 API로 검증한다."""

import uuid
from typing import Any

import httpx
import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from sqlalchemy import select

from sooljang.application import provider_connections as service
from sooljang.domain.discovery import SourceOutcome
from sooljang.infrastructure.database.models import (
    ProviderConnection,
    ProviderCredential,
)
from sooljang.infrastructure.database.session import get_session_factory

SECRET = "synthetic-provider-credential-abcd"


def create(
    client: TestClient,
    prefix: str,
    *,
    kind: str = "brave",
    values: dict[str, str] | None = None,
    name: str = "검증용 연결",
) -> dict[str, Any]:
    response = client.post(
        f"{prefix}/connections",
        json={"provider_kind": kind, "name": name, "credentials": values or {}},
    )
    assert response.status_code == 201, response.text
    return response.json()


def patch(
    client: TestClient, prefix: str, connection: dict[str, Any], **fields: Any
) -> httpx.Response:
    return client.patch(
        f"{prefix}/connections/{connection['id']}",
        json={"expected_revision": connection["config_revision"], **fields},
    )


def read_ciphertext(client: TestClient, connection_id: str, name: str = "api_key") -> bytes:
    async def query() -> bytes:
        async with get_session_factory()() as session:
            value = await session.scalar(
                select(ProviderCredential.secret_ciphertext).where(
                    ProviderCredential.connection_id == uuid.UUID(connection_id),
                    ProviderCredential.name == name,
                )
            )
            assert value is not None
            return value

    assert client.portal is not None
    return client.portal.call(query)


def test_catalog_distinguishes_naver_auth_and_does_not_offer_shopping(
    api_client: TestClient, prefix: str
) -> None:
    response = api_client.get(f"{prefix}/connections/providers")
    assert response.status_code == 200
    catalog = {entry["kind"]: entry for entry in response.json()}
    assert set(catalog) >= {"naver_hub", "naver_legacy", "brave", "exa", "openai_ocr", "dailyshot"}
    assert [field["name"] for field in catalog["naver_hub"]["fields"]] == [
        "client_id",
        "client_secret",
    ]
    assert all("쇼핑" not in feature for item in catalog.values() for feature in item["features"])
    assert "no-store" in response.headers["cache-control"]


def test_registered_credentials_survive_reload_without_test_or_activation(
    api_client: TestClient, prefix: str
) -> None:
    connection = create(api_client, prefix, values={"api_key": SECRET})
    assert connection["registration"] == "saved"
    assert connection["last_outcome"] == "unknown"
    assert connection["last_test_at"] is None
    assert connection["is_active"] is False
    response = api_client.get(f"{prefix}/connections")
    assert response.json()[0]["id"] == connection["id"]
    assert response.json()[0]["credential_fields"][0]["masked_hint"] == "...abcd"
    assert SECRET not in response.text
    assert "secret_ciphertext" not in response.text
    assert "no-store" in response.headers["cache-control"]
    assert response.json()[0]["usage"] == {"minute": 0, "day": 0}


def test_partial_naver_and_keyless_source_have_distinct_registration(
    api_client: TestClient, prefix: str
) -> None:
    naver = create(
        api_client, prefix, kind="naver_hub", values={"client_id": "synthetic-client-id"}
    )
    assert naver["registration"] == "incomplete"
    assert naver["missing_fields"] == ["client_secret"]
    free = create(api_client, prefix, kind="dailyshot", name="키 없는 소스")
    assert free["registration"] == "not_required"
    assert free["credential_fields"] == []
    assert free["is_active"] is False
    assert len(free["sources"]) == 1


def test_blank_input_keeps_ciphertext_while_explicit_delete_removes_it(
    api_client: TestClient, prefix: str
) -> None:
    connection = create(api_client, prefix, values={"api_key": SECRET})
    old = read_ciphertext(api_client, connection["id"])
    response = patch(api_client, prefix, connection, credentials={"api_key": ""})
    assert response.status_code == 200, response.text
    assert response.json()["config_revision"] == connection["config_revision"]
    assert read_ciphertext(api_client, connection["id"]) == old
    response = patch(api_client, prefix, connection, delete_credentials=["api_key"])
    assert response.status_code == 200
    assert response.json()["registration"] == "unregistered"
    assert response.json()["credential_fields"][0]["saved"] is False
    assert response.json()["config_revision"] == connection["config_revision"] + 1


def test_pause_preserves_key_and_rotation_invalidates_verification(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def verified(*_args: Any, **_kwargs: Any) -> SourceOutcome:
        return SourceOutcome.SUCCESS

    monkeypatch.setattr(service, "test_provider_connection", verified)
    connection = create(api_client, prefix, values={"api_key": SECRET})
    response = api_client.post(
        f"{prefix}/connections/{connection['id']}/probe", json={"expected_revision": 1}
    )
    assert response.status_code == 200 and response.json()["applied"]
    checked = api_client.get(f"{prefix}/connections/{connection['id']}").json()
    assert checked["last_outcome"] == "success" and not checked["verification_stale"]
    rotated = patch(
        api_client, prefix, checked, credentials={"api_key": "different-secret-with-abcd"}
    ).json()
    assert rotated["registration"] == "saved"
    assert rotated["verification_stale"] is True
    assert rotated["last_test_at"] == checked["last_test_at"]
    old = read_ciphertext(api_client, connection["id"])
    used = patch(api_client, prefix, rotated, is_active=True).json()
    paused = patch(api_client, prefix, used, is_active=False).json()
    assert paused["registration"] == "saved" and not paused["is_active"]
    assert old == read_ciphertext(api_client, connection["id"])


@pytest.mark.parametrize(
    "outcome",
    [
        SourceOutcome.AUTHENTICATION_FAILED,
        SourceOutcome.FORBIDDEN,
        SourceOutcome.RATE_LIMITED,
        SourceOutcome.NETWORK_ERROR,
        SourceOutcome.PARSE_ERROR,
    ],
)
def test_test_failure_keeps_registration_and_active_state(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch, outcome: SourceOutcome
) -> None:
    async def fail(*_args: Any, **_kwargs: Any) -> SourceOutcome:
        return outcome

    monkeypatch.setattr(service, "test_provider_connection", fail)
    connection = create(api_client, prefix, values={"api_key": SECRET})
    response = api_client.post(
        f"{prefix}/connections/{connection['id']}/probe", json={"expected_revision": 1}
    )
    assert response.json()["outcome"] == outcome.value
    after = api_client.get(f"{prefix}/connections/{connection['id']}").json()
    assert after["registration"] == "saved" and not after["is_active"]
    assert after["last_outcome"] == outcome.value


def test_late_test_result_is_not_applied_to_changed_revision(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    connection = create(api_client, prefix, values={"api_key": SECRET})

    async def delayed(*_args: Any, **_kwargs: Any) -> SourceOutcome:
        async with get_session_factory().begin() as session:
            current = await session.get(ProviderConnection, uuid.UUID(connection["id"]))
            assert current is not None
            current.config_revision += 1
        return SourceOutcome.SUCCESS

    monkeypatch.setattr(service, "test_provider_connection", delayed)
    response = api_client.post(
        f"{prefix}/connections/{connection['id']}/probe", json={"expected_revision": 1}
    )
    assert response.status_code == 200
    assert response.json()["applied"] is False
    after = api_client.get(f"{prefix}/connections/{connection['id']}").json()
    assert after["last_outcome"] == "unknown"
    assert after["last_test_at"] is None
    assert patch(api_client, prefix, connection, name="오래된 수정").status_code == 409


def test_wrong_master_key_marks_recovery_without_erasing_ciphertext(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    connection = create(api_client, prefix, values={"api_key": SECRET})
    old = read_ciphertext(api_client, connection["id"])
    from sooljang.config import get_settings

    monkeypatch.setattr(get_settings(), "secret_key", Fernet.generate_key().decode())
    response = api_client.post(
        f"{prefix}/connections/{connection['id']}/probe", json={"expected_revision": 1}
    )
    assert response.json()["outcome"] == "credential_unavailable"
    after = api_client.get(f"{prefix}/connections/{connection['id']}").json()
    assert after["registration"] == "recovery_required"
    assert read_ciphertext(api_client, connection["id"]) == old


def test_other_users_cannot_read_update_probe_or_delete_connection(
    api_client: TestClient, prefix: str
) -> None:
    connection = create(api_client, prefix, values={"api_key": SECRET})

    async def transfer() -> None:
        async with get_session_factory().begin() as session:
            row = await session.get(ProviderConnection, uuid.UUID(connection["id"]))
            assert row is not None
            row.user_id = uuid.uuid4()

    assert api_client.portal is not None
    api_client.portal.call(transfer)
    assert api_client.get(f"{prefix}/connections").json() == []
    assert api_client.get(f"{prefix}/connections/{connection['id']}").status_code == 404
    assert (
        patch(
            api_client, prefix, connection, credentials={"api_key": "replacement-private"}
        ).status_code
        == 404
    )
    assert (
        api_client.post(
            f"{prefix}/connections/{connection['id']}/probe", json={"expected_revision": 1}
        ).status_code
        == 404
    )
    assert (
        api_client.request(
            "DELETE", f"{prefix}/connections/{connection['id']}", json={"expected_revision": 1}
        ).status_code
        == 404
    )


def test_connection_endpoints_require_authentication(anon_client: TestClient, prefix: str) -> None:
    response = anon_client.get(f"{prefix}/connections")
    assert response.status_code == 401
    assert "no-store" in response.headers["cache-control"]


def test_existing_ocr_ciphertext_and_opt_in_are_preserved_and_changes_are_shared(
    api_client: TestClient, prefix: str
) -> None:
    response = api_client.put(
        f"{prefix}/llm-settings",
        json={
            "provider": "openai",
            "api_key": SECRET,
            "model": "gpt-4o-mini",
            "rematch_enabled": True,
            "rematch_monthly_cap": 7,
        },
    )
    assert response.status_code == 200
    connection = api_client.get(f"{prefix}/connections").json()[0]
    assert connection["is_active"] is True
    assert connection["ocr_rematch_enabled"] is True
    assert connection["ocr_rematch_monthly_cap"] == 7
    original = read_ciphertext(api_client, connection["id"])
    changed = patch(
        api_client,
        prefix,
        connection,
        credentials={"api_key": ""},
        ocr_model="existing-model-choice",
    ).json()
    assert read_ciphertext(api_client, connection["id"]) == original
    assert changed["ocr_rematch_enabled"] is True
    assert api_client.get(f"{prefix}/llm-settings").json()["model"] == "existing-model-choice"
    paused = patch(api_client, prefix, changed, is_active=False).json()
    assert paused["ocr_rematch_enabled"] is True

    async def request_key() -> Any:
        from sooljang.application.llm_settings import get_decrypted_api_key
        from sooljang.config import get_settings

        async with get_session_factory()() as session:
            row = await session.get(ProviderConnection, uuid.UUID(connection["id"]))
            assert row is not None
            return await get_decrypted_api_key(
                session,
                user_id=row.user_id,
                master_key=get_settings().secret_key,
            )

    assert api_client.portal is not None
    assert api_client.portal.call(request_key) is None


def test_removing_connection_preserves_source_and_user_settings(
    api_client: TestClient, prefix: str
) -> None:
    connection = create(api_client, prefix, kind="dailyshot", name="삭제 영향 검증")
    source_id = connection["sources"][0]["id"]
    response = api_client.request(
        "DELETE", f"{prefix}/connections/{connection['id']}", json={"expected_revision": 1}
    )
    assert response.status_code == 204
    assert api_client.get(f"{prefix}/connections").json() == []
    assert any(
        source["id"] == source_id for source in api_client.get(f"{prefix}/external-sources").json()
    )


def test_source_credentials_share_canonical_ciphertext_without_suffix_dedup(
    api_client: TestClient, prefix: str
) -> None:
    ids = []
    for index, value in enumerate((SECRET, "different-account-abcd")):
        source = api_client.post(
            f"{prefix}/external-sources",
            json={
                "name": f"별도 프로필 {index}",
                "base_url": "https://example.com",
                "adapter_spec": {
                    "search": {"url_template": "https://example.com/search?q={query}"},
                    "credentials": [{"name": "api_key", "header": "X-Api-Key"}],
                },
            },
        ).json()
        response = api_client.put(
            f"{prefix}/external-sources/{source['id']}/credentials",
            json={"values": {"api_key": value}},
        )
        assert response.status_code == 200
        ids.append(source["connection_id"])
    assert ids[0] != ids[1]
    assert read_ciphertext(api_client, ids[0]) != read_ciphertext(api_client, ids[1])
    connections = api_client.get(f"{prefix}/connections").json()
    assert len(connections) == 2
    assert all(item["credential_fields"][0]["masked_hint"] == "...abcd" for item in connections)


def test_shared_provider_key_cannot_be_attached_to_an_unrelated_host(
    api_client: TestClient, prefix: str
) -> None:
    connection = create(
        api_client,
        prefix,
        kind="naver_hub",
        values={"client_id": "client-id-example", "client_secret": SECRET},
    )
    source = api_client.post(
        f"{prefix}/external-sources",
        json={
            "name": "다른 서버",
            "base_url": "https://example.com",
            "adapter_spec": {
                "search": {"url_template": "https://example.com/search?q={query}"},
                "credentials": [{"name": "client_id"}, {"name": "client_secret"}],
            },
        },
    ).json()
    response = api_client.put(
        f"{prefix}/connections/{connection['id']}/sources/{source['id']}",
        json={"expected_revision": connection["config_revision"]},
    )
    assert response.status_code == 422
    assert SECRET not in response.text


def test_connection_secret_validation_does_not_echo_value(
    api_client: TestClient, prefix: str
) -> None:
    oversized = "sensitive-value-" * 500
    response = api_client.post(
        f"{prefix}/connections",
        json={"provider_kind": "brave", "credentials": {"api_key": oversized}},
    )
    assert response.status_code == 422
    assert oversized not in response.text
    assert "no-store" in response.headers["cache-control"]
