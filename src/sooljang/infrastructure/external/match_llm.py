"""애매 구간 매칭을 LLM 으로 재판정한다(Task 34 PR6).

PR1 의 "확인 필요" 구간(점수 0.5~0.85)에서 사용자가 매번 후보를 직접 골라야 하는 빈도를
줄이는 보조 기능이다. `llm.py::extract_label` 과 같은 `chat.completions.parse` 구조화
출력 패턴을 그대로 쓴다.

**ToS 위험이 없다.** D167 에서 폐기한 `search` 전략은 검색엔진 결과를 스크래핑하는
것이었다 — 이건 다르다. 이미 소스의 `adapter` 가 정당하게 받아온 검색 후보 이름 중에서
고르는 것뿐이고, 외부 사이트에 추가 요청이 나가지 않는다.

**입력을 최소화한다.** 내 제품의 이름·생산자·도수·용량·숙성·빈티지와 후보 이름만 LLM 에
보낸다. 가격·URL·후기는 보내지 않는다 — 매칭 판정에 필요 없다.

**자동 고정하지 않는다.** 이 모듈은 추천 인덱스만 돌려준다. 그 추천에 "LLM 추천" 배지를
붙여 사용자 확인을 받는 것은 호출부(`application/external_sources.py`)의 책임이다 —
PR1 이 정한 "고정은 사용자 명시 조작으로만" 원칙과 같다(자동 고정은 오답을 영구화할
위험이 있다).

`fetch_snapshot` 과 같은 계약이다: 이 모듈의 공개 함수는 예외를 밖으로 내보내지 않는다.
실패·타임아웃·거부·스키마 불일치는 모두 `None` 으로 통일해, 호출부가 조용히 기존 점수
결과로 폴백하게 한다.
"""

import logging

import httpx
from openai import AsyncOpenAI
from pydantic import BaseModel

from sooljang.infrastructure.external.matching import ProductIdentity

logger = logging.getLogger(__name__)


class RematchOutcome(BaseModel):
    """LLM 이 고른 후보 인덱스와 확신도.

    `index` 가 `None` 이면 "확신할 수 있는 후보가 없다"는 LLM 의 판단이다 — 호출 실패와는
    다른 정상 응답이라, `rematch()` 는 이 경우도 그대로 돌려준다(실패로 뭉뚱그리지 않는다).
    """

    index: int | None
    confidence: float


_PROMPT_TEMPLATE = (
    "다음은 내가 가진 술 제품 정보다: {identity}\n\n"
    "아래는 한 쇼핑몰에서 이 제품 이름으로 검색했을 때 나온 후보 목록이다"
    "(0부터 시작하는 번호):\n{candidates}\n\n"
    "이 중 내 제품과 같은 상품인 것이 있으면 그 번호를 index 에, 확신할 수 있는 후보가 "
    "없으면 index 에 null 을 반환하라. confidence 는 0(전혀 확신 없음)~1(매우 확신) 사이로 "
    "함께 반환하라. 용량·숙성 연수·빈티지가 다르면 같은 상품이 아니다 — 이름이 비슷해도 "
    "그 경우엔 null 을 반환하라."
)


def _describe_identity(identity: ProductIdentity) -> str:
    parts = [f"이름: {identity.name}"]
    if identity.name_en:
        parts.append(f"영문명: {identity.name_en}")
    if identity.producer:
        parts.append(f"생산자: {identity.producer}")
    if identity.abv is not None:
        parts.append(f"도수: {identity.abv}%")
    if identity.volumes_ml:
        parts.append(f"용량: {', '.join(f'{v}ml' for v in identity.volumes_ml)}")
    if identity.age_years is not None:
        parts.append(f"숙성: {identity.age_years}년")
    if identity.vintage is not None:
        parts.append(f"빈티지: {identity.vintage}")
    return " / ".join(parts)


def _describe_candidates(names: list[str]) -> str:
    return "\n".join(f"{index}: {name}" for index, name in enumerate(names))


async def rematch(
    identity: ProductIdentity,
    candidate_names: list[str],
    *,
    api_key: str,
    model: str,
    http_client: httpx.AsyncClient | None = None,
) -> RematchOutcome | None:
    """애매한 후보 중 LLM 추천을 구한다.

    호출부의 비용 가드(호출 여부 자체를 결정하는 것)는 이 함수의 책임이 아니다 — 이
    함수는 "호출하기로 이미 정해졌을 때 어떻게 물어보고 실패를 어떻게 삼키는지"만 맡는다.
    """
    if not candidate_names:
        return None

    client = AsyncOpenAI(api_key=api_key, http_client=http_client)
    prompt = _PROMPT_TEMPLATE.format(
        identity=_describe_identity(identity),
        candidates=_describe_candidates(candidate_names),
    )

    try:
        response = await client.chat.completions.parse(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            response_format=RematchOutcome,
        )
    except Exception:
        # 인증·요청 형식·네트워크·타임아웃 등 SDK 가 던지는 예외 종류를 호출부가 알 필요
        # 없이 조용한 폴백 하나로 통일한다(`llm.py::extract_label` 과 같은 판단).
        logger.warning("LLM 재판정 호출 실패", exc_info=True)
        return None

    message = response.choices[0].message
    if message.refusal or message.parsed is None:
        return None

    outcome = message.parsed
    if outcome.index is not None and not (0 <= outcome.index < len(candidate_names)):
        # 후보 범위를 벗어난 인덱스는 스키마상 가능하다(LLM 이 잘못 세었을 수 있다) —
        # 신뢰할 수 없는 응답이니 추천 없음으로 통일한다.
        return None
    return outcome
