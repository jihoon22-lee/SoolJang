"""Vision LLM 라벨 인식 테스트.

`httpx.MockTransport` 로 OpenAI SDK 의 `http_client` 주입점을 대체해, 대부분은 실제
네트워크를 타지 않는다(Task 16 의 Open Food Facts 조회와 같은 패턴). 실제 API 호출은
`live_llm` 마커가 붙은 opt-in 테스트 하나뿐이다 — `OPENAI_API_KEY` 가 환경 변수에 없으면
건너뛴다.
"""

import json
import os
import struct
import zlib

import httpx
import pytest

from sooljang.infrastructure.external.llm import (
    LabelExtraction,
    LabelExtractionFailedError,
    extract_label,
)

_VALID_BODY = {
    "name": "글렌알라키 12년",
    "name_confidence": 0.92,
    "producer": "GlenAllachie",
    "producer_confidence": 0.8,
    "abv": 46.0,
    "abv_confidence": 0.75,
    "volume_ml": 700,
    "volume_ml_confidence": 0.9,
    "vintage": None,
    "vintage_confidence": 0.0,
    "age_years": 12,
    "age_years_confidence": 0.85,
    "category_guess": "위스키",
    "category_guess_confidence": 0.95,
}


def _chat_completion(*, content: str | None = None, refusal: str | None = None) -> dict:
    return {
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "created": 1234567890,
        "model": "gpt-4o-mini",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content, "refusal": refusal},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20},
    }


def _minimal_png() -> bytes:
    """1x1 빨간 픽셀 PNG. 손으로 쓴 헥스 대신 실제로 인코딩해 형식이 깨지지 않게 한다."""

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    signature = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    raw_scanline = b"\x00" + b"\xff\x00\x00"
    idat = zlib.compress(raw_scanline)
    return signature + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


async def _extract(handler) -> LabelExtraction:
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        return await extract_label(
            b"fake-image-bytes", api_key="sk-test", model="gpt-4o-mini", http_client=http_client
        )


async def test_필드와_신뢰도를_구조화해서_받는다() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/chat/completions"
        return httpx.Response(200, json=_chat_completion(content=json.dumps(_VALID_BODY)))

    result = await _extract(handler)

    assert result.name == "글렌알라키 12년"
    assert result.name_confidence == 0.92
    assert result.vintage is None
    assert result.age_years == 12
    assert result.category_guess == "위스키"


async def test_요청_이미지는_data_url로_인코딩된다() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        captured["image_url"] = body["messages"][0]["content"][1]["image_url"]["url"]
        return httpx.Response(200, json=_chat_completion(content=json.dumps(_VALID_BODY)))

    await _extract(handler)

    assert captured["image_url"].startswith("data:image/jpeg;base64,")


async def test_거부_응답은_실패로_통일한다() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_chat_completion(refusal="이 요청은 처리할 수 없습니다"))

    with pytest.raises(LabelExtractionFailedError):
        await _extract(handler)


async def test_스키마에_맞지_않는_응답은_실패로_통일한다() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_chat_completion(content="이건 JSON 이 아니다"))

    with pytest.raises(LabelExtractionFailedError):
        await _extract(handler)


async def test_인증_오류는_실패로_통일한다() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            json={"error": {"message": "Incorrect API key provided", "code": "invalid_api_key"}},
        )

    with pytest.raises(LabelExtractionFailedError):
        await _extract(handler)


async def test_네트워크_타임아웃도_실패로_통일한다() -> None:
    """`extract_label` 의 `except Exception` 은 인증·형식 오류뿐 아니라 연결 타임아웃 같은
    네트워크 계층 예외도 잡아야 한다(Task 21 장애 주입 검증) — 그래야 라우터가 항상
    `LabelExtractionFailedError` 하나만 알면 되고, `httpx` 예외가 그대로 새어 나가 500 으로
    비치지 않는다.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out", request=request)

    with pytest.raises(LabelExtractionFailedError):
        await _extract(handler)


@pytest.mark.live_llm
async def test_실제_openai_api로_라벨을_인식한다() -> None:
    """opt-in 실호출 테스트. `OPENAI_API_KEY` 환경 변수가 있어야 실행된다.

    1x1 픽셀 PNG 를 보낸다 — 실제 라벨 사진이 아니므로 필드는 대부분 비어 있겠지만,
    이 테스트의 목적은 추출 정확도가 아니라 **왕복 자체가 동작하는지**(인증·요청 형식·
    구조화 출력 파싱)를 확인하는 것이다.
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        pytest.skip("OPENAI_API_KEY 가 설정되지 않았습니다")

    result = await extract_label(
        _minimal_png(), api_key=api_key, model="gpt-4o-mini", content_type="image/png"
    )

    assert 0.0 <= result.name_confidence <= 1.0
