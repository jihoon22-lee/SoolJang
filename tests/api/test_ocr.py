"""라벨 OCR API 테스트. Vision LLM 호출은 `llm.extract_label` 을 몽키패치해 대체한다."""

import pytest
from fastapi.testclient import TestClient

from sooljang.infrastructure.external import llm

FAKE_API_KEY = "sk-test-1234567890abcdef"  # scan-secrets-allow

_CANNED_EXTRACTION = llm.LabelExtraction(
    name="글렌알라키 12년",
    name_confidence=0.9,
    producer="GlenAllachie",
    producer_confidence=0.7,
    abv=46.0,
    abv_confidence=0.6,
    volume_ml=700,
    volume_ml_confidence=0.85,
    vintage=None,
    vintage_confidence=0.0,
    age_years=12,
    age_years_confidence=0.8,
    category_guess="위스키",
    category_guess_confidence=0.95,
)


def _configure_llm(client: TestClient, prefix: str) -> None:
    response = client.put(
        f"{prefix}/llm-settings",
        json={"provider": "openai", "api_key": FAKE_API_KEY, "model": "gpt-4o-mini"},
    )
    assert response.status_code == 200, response.text


def test_설정이_없으면_409(api_client: TestClient, prefix: str) -> None:
    response = api_client.post(
        f"{prefix}/ocr/label", files={"file": ("label.jpg", b"fake-bytes", "image/jpeg")}
    )

    assert response.status_code == 409, response.text
    assert response.json()["type"].endswith("/llm-not-configured")


def test_설정이_있으면_추출한_필드를_돌려준다(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    _configure_llm(api_client, prefix)

    async def fake_extract_label(image_bytes: bytes, **kwargs: object) -> llm.LabelExtraction:
        assert image_bytes == b"fake-bytes"
        assert kwargs["api_key"] == FAKE_API_KEY
        assert kwargs["model"] == "gpt-4o-mini"
        return _CANNED_EXTRACTION

    monkeypatch.setattr(llm, "extract_label", fake_extract_label)

    response = api_client.post(
        f"{prefix}/ocr/label", files={"file": ("label.jpg", b"fake-bytes", "image/jpeg")}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "글렌알라키 12년"
    assert body["name_confidence"] == 0.9
    assert body["vintage"] is None
    assert body["category_guess"] == "위스키"


def test_추출_실패는_422로_수동_입력을_유도한다(
    api_client: TestClient, prefix: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    _configure_llm(api_client, prefix)

    async def failing_extract_label(*args: object, **kwargs: object) -> llm.LabelExtraction:
        raise llm.LabelExtractionFailedError("모델이 거부했습니다")

    monkeypatch.setattr(llm, "extract_label", failing_extract_label)

    response = api_client.post(
        f"{prefix}/ocr/label", files={"file": ("label.jpg", b"fake-bytes", "image/jpeg")}
    )

    assert response.status_code == 422, response.text
    assert "직접 입력" in response.json()["detail"]


def test_지원하지_않는_파일_형식은_설정_없이도_422(api_client: TestClient, prefix: str) -> None:
    response = api_client.post(
        f"{prefix}/ocr/label", files={"file": ("label.txt", b"not an image", "text/plain")}
    )

    assert response.status_code == 422, response.text


def test_빈_파일은_422(api_client: TestClient, prefix: str) -> None:
    _configure_llm(api_client, prefix)

    response = api_client.post(
        f"{prefix}/ocr/label", files={"file": ("label.jpg", b"", "image/jpeg")}
    )

    assert response.status_code == 422, response.text


def test_너무_큰_파일은_422(api_client: TestClient, prefix: str) -> None:
    _configure_llm(api_client, prefix)

    oversized = b"x" * (10 * 1024 * 1024 + 1)
    response = api_client.post(
        f"{prefix}/ocr/label", files={"file": ("label.jpg", oversized, "image/jpeg")}
    )

    assert response.status_code == 422, response.text
