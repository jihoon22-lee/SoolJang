"""라벨 OCR API 스키마."""

from pydantic import BaseModel

from sooljang.infrastructure.external.llm import LabelExtraction


class LabelExtractionOut(BaseModel):
    """`infrastructure/external/llm.py::LabelExtraction` 을 그대로 노출한다.

    필드마다 신뢰도가 따라오므로, 화면은 낮은 신뢰도 필드를 표시하고 사용자 검수 후에만
    저장한다 — 이 응답 자체는 아무것도 저장하지 않는다.
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

    @classmethod
    def from_extraction(cls, extraction: LabelExtraction) -> LabelExtractionOut:
        return cls(**extraction.model_dump())
