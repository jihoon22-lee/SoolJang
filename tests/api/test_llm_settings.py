"""LLM 설정 API 테스트."""

from fastapi.testclient import TestClient

# 테스트용 값. 실제 키가 아니다. scan-secrets-allow
FAKE_API_KEY = "sk-test-1234567890abcdef"  # scan-secrets-allow


def test_설정하기_전에는_configured가_false다(api_client: TestClient, prefix: str) -> None:
    response = api_client.get(f"{prefix}/llm-settings")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["configured"] is False
    assert body["provider"] is None
    assert body["api_key_masked"] is None


def test_저장하면_마스킹된_키를_돌려준다(api_client: TestClient, prefix: str) -> None:
    response = api_client.put(
        f"{prefix}/llm-settings",
        json={"provider": "openai", "api_key": FAKE_API_KEY, "model": "gpt-4o-mini"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["configured"] is True
    assert body["provider"] == "openai"
    assert body["model"] == "gpt-4o-mini"
    assert body["api_key_masked"] == "...cdef"
    assert FAKE_API_KEY not in response.text


def test_저장한_뒤_조회하면_마스킹된_값이_남아있다(api_client: TestClient, prefix: str) -> None:
    api_client.put(
        f"{prefix}/llm-settings",
        json={"provider": "openai", "api_key": FAKE_API_KEY, "model": "gpt-4o-mini"},
    )

    response = api_client.get(f"{prefix}/llm-settings")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["configured"] is True
    assert body["api_key_masked"] == "...cdef"
    assert FAKE_API_KEY not in response.text


def test_다시_저장하면_기존_행을_덮어쓴다(api_client: TestClient, prefix: str) -> None:
    api_client.put(
        f"{prefix}/llm-settings",
        json={"provider": "openai", "api_key": FAKE_API_KEY, "model": "gpt-4o-mini"},
    )

    second_key = "sk-test-0000000000wxyz"  # scan-secrets-allow
    response = api_client.put(
        f"{prefix}/llm-settings",
        json={"provider": "openai", "api_key": second_key, "model": "gpt-4o"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["model"] == "gpt-4o"
    assert body["api_key_masked"] == "...wxyz"


def test_삭제하면_다시_configured가_false다(api_client: TestClient, prefix: str) -> None:
    api_client.put(
        f"{prefix}/llm-settings",
        json={"provider": "openai", "api_key": FAKE_API_KEY, "model": "gpt-4o-mini"},
    )

    delete_response = api_client.delete(f"{prefix}/llm-settings")
    assert delete_response.status_code == 204, delete_response.text

    response = api_client.get(f"{prefix}/llm-settings")
    assert response.json()["configured"] is False


def test_짧은_키는_거부한다(api_client: TestClient, prefix: str) -> None:
    response = api_client.put(
        f"{prefix}/llm-settings", json={"provider": "openai", "api_key": "abc", "model": "gpt-4o"}
    )

    assert response.status_code == 422, response.text


def test_로그인하지_않으면_거부한다(anon_client: TestClient, prefix: str) -> None:
    response = anon_client.get(f"{prefix}/llm-settings")

    assert response.status_code == 401, response.text
