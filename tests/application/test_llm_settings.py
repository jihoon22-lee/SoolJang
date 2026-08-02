"""LLM 설정 순수 함수 테스트. DB 를 거치는 저장·조회는 `tests/api/test_llm_settings.py`,
`tests/api/test_ocr.py` 가 API 왕복으로 함께 검증한다.
"""

from sooljang.application.llm_settings import hint_of, mask_api_key


def test_힌트는_마지막_4자다() -> None:
    assert hint_of("sk-abcdef1234") == "1234"


def test_마스킹은_힌트_앞에_점_세_개를_붙인다() -> None:
    assert mask_api_key("1234") == "...1234"
