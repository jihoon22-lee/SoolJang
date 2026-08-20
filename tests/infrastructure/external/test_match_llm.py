"""LLM 애매 구간 재판정 테스트(Task 34 PR6).

`test_llm.py` 와 같은 패턴 — `httpx.MockTransport` 로 OpenAI SDK 의 `http_client` 를
대체해 실제 네트워크를 타지 않는다.
"""

import json
from decimal import Decimal

import httpx

from sooljang.infrastructure.external.match_llm import RematchOutcome, rematch
from sooljang.infrastructure.external.matching import ProductIdentity


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


async def _rematch(handler, **kwargs) -> RematchOutcome | None:
    identity = kwargs.pop("identity", ProductIdentity(name="글렌피딕 12년"))
    candidates = kwargs.pop("candidates", ["글렌피딕 12년 위스키", "글렌피딕 15년 솔레라"])
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        return await rematch(
            identity, candidates, api_key="sk-test", model="gpt-4o-mini", http_client=http_client
        )


async def test_후보_인덱스와_확신도를_구조화해서_받는다() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/chat/completions"
        body = json.loads(request.content)
        prompt = body["messages"][0]["content"]
        assert "글렌피딕 12년" in prompt
        assert "0: 글렌피딕 12년 위스키" in prompt
        return httpx.Response(
            200, json=_chat_completion(content=json.dumps({"index": 0, "confidence": 0.9}))
        )

    result = await _rematch(handler)

    assert result is not None
    assert result.index == 0
    assert result.confidence == 0.9


async def test_확신할_후보가_없으면_index가_null이다() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json=_chat_completion(content=json.dumps({"index": None, "confidence": 0.1}))
        )

    result = await _rematch(handler)

    assert result is not None
    assert result.index is None


async def test_거부_응답은_none으로_통일한다() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_chat_completion(refusal="처리할 수 없습니다"))

    result = await _rematch(handler)

    assert result is None


async def test_스키마에_맞지_않는_응답은_none으로_통일한다() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_chat_completion(content="이건 JSON 이 아니다"))

    result = await _rematch(handler)

    assert result is None


async def test_네트워크_타임아웃도_none으로_통일한다() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out", request=request)

    result = await _rematch(handler)

    assert result is None


async def test_인증_오류도_none으로_통일한다() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            json={"error": {"message": "Incorrect API key provided", "code": "invalid_api_key"}},
        )

    result = await _rematch(handler)

    assert result is None


async def test_후보_범위를_벗어난_인덱스는_none으로_통일한다() -> None:
    """LLM 이 스키마상으로는 유효하지만(정수) 실제 후보 개수를 벗어난 값을 줄 수 있다 —
    신뢰할 수 없는 응답이라 추천 없음으로 취급한다."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json=_chat_completion(content=json.dumps({"index": 99, "confidence": 0.5}))
        )

    result = await _rematch(handler)

    assert result is None


async def test_후보가_없으면_호출하지_않는다() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("후보가 없으면 호출 자체가 없어야 한다")

    result = await _rematch(handler, candidates=[])

    assert result is None


async def test_입력에는_이름_속성만_담기고_가격이나_url은_없다() -> None:
    """`match_llm.rematch` 는 애초에 이름 문자열만 인자로 받는다 — 가격·URL 을 실어 보낼
    방법 자체가 시그니처에 없다는 것을 프롬프트 내용으로 재확인한다."""
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        captured["prompt"] = body["messages"][0]["content"]
        return httpx.Response(
            200, json=_chat_completion(content=json.dumps({"index": 0, "confidence": 0.8}))
        )

    await _rematch(
        handler,
        identity=ProductIdentity(name="글렌알라키 12년", producer="GlenAllachie", abv=Decimal(46)),
    )

    assert "글렌알라키 12년" in captured["prompt"]
    assert "GlenAllachie" in captured["prompt"]
    assert "46" in captured["prompt"]
