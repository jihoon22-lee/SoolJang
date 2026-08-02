"""Vision LLM 라벨 인식(Task 17).

OpenAI 의 구조화 출력(`chat.completions.parse`)을 쓴다. JSON 문자열을 받아 손으로 파싱하는
대신 SDK 가 곧바로 Pydantic 모델로 역직렬화하게 해서, 스키마 불일치를 호출부가 아니라 SDK
경계에서 잡는다.

`http_client` 는 테스트가 `httpx.MockTransport` 로 실제 네트워크 호출 없이 응답을 흉내 낼
수 있게 하는 자리다(Task 16 의 Open Food Facts 조회 `infrastructure/external/
open_food_facts.py` 와 같은 패턴) — 운영에서는 항상 `None`(SDK 기본 전송)이다.
"""

import base64

import httpx
from openai import AsyncOpenAI
from pydantic import BaseModel


class LabelExtraction(BaseModel):
    """라벨 사진에서 뽑아낸 필드.

    필드마다 신뢰도(0~1)를 같이 준다 — 그대로 저장하지 않고 사용자가 검수한 뒤 저장하게
    하려는 목적이다(`docs/plan.md` Task 17 "필드별 신뢰도 표시").
    """

    name: str | None
    name_confidence: float
    producer: str | None
    producer_confidence: float
    abv: float | None
    abv_confidence: float
    volume_ml: int | None
    volume_ml_confidence: float
    vintage: int | None
    vintage_confidence: float
    age_years: int | None
    age_years_confidence: float
    category_guess: str | None
    category_guess_confidence: float


class LabelExtractionFailedError(Exception):
    """LLM 이 구조화된 응답을 주지 못했다(거부, 빈 응답 등). 호출부는 수동 입력으로 유도한다."""


_PROMPT = (
    "이 이미지는 주류(술) 라벨 사진이다. 라벨에서 다음 정보를 읽어 구조화된 형태로 반환하라: "
    "이름(name), 생산자(producer), 도수(abv, %), 용량(volume_ml, ml), 빈티지(vintage, 연도), "
    "숙성 연수(age_years), 주종 추정(category_guess, 예: 위스키/와인/맥주/사케 등). "
    "라벨에서 읽을 수 없는 값은 null 로 두고, 각 필드마다 0(전혀 확신 없음)~1(매우 확신) "
    "사이 신뢰도를 함께 반환하라. 라벨에 실제로 보이는 내용만 근거로 삼고, 추측으로 채우지 마라."
)


async def extract_label(
    image_bytes: bytes,
    *,
    api_key: str,
    model: str,
    content_type: str = "image/jpeg",
    http_client: httpx.AsyncClient | None = None,
) -> LabelExtraction:
    """라벨 사진을 Vision LLM 에 보내 구조화된 필드를 뽑는다.

    실패(거부·빈 응답·네트워크 오류)는 `LabelExtractionFailedError` 로 통일한다 — 호출부가
    LLM SDK 의 예외 종류를 알 필요 없이 "실패 시 수동 폴백"(Task 17 사양)으로 넘어가면 된다.
    """
    client = AsyncOpenAI(api_key=api_key, http_client=http_client)
    data_url = f"data:{content_type};base64,{base64.b64encode(image_bytes).decode()}"

    try:
        response = await client.chat.completions.parse(
            model=model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": _PROMPT},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }
            ],
            response_format=LabelExtraction,
        )
    except Exception as error:
        # SDK 가 던지는 예외 종류가 다양하다(인증·요청 형식·네트워크·타임아웃 등) — 호출부는
        # 세부 종류를 몰라도 되게 전부 같은 실패로 통일한다.
        raise LabelExtractionFailedError(str(error)) from error

    message = response.choices[0].message
    if message.refusal:
        raise LabelExtractionFailedError(message.refusal)
    if message.parsed is None:
        raise LabelExtractionFailedError("LLM 이 구조화된 응답을 반환하지 않았습니다")
    return message.parsed
