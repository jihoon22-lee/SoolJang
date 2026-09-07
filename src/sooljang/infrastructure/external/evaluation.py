"""합성 정답셋의 매칭 정확도·후보 회수율을 분리하는 결정론적 평가."""

from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from sooljang.infrastructure.external.matching import ProductIdentity, score


@dataclass(frozen=True)
class MatchingEvaluation:
    cases: int
    queries_with_answers: int
    auto_accepted: int
    correct_auto_accepted: int
    false_auto_accepted: int
    retrieved_answers: int
    missed_case_ids: tuple[str, ...]
    false_accept_case_ids: tuple[str, ...]

    @property
    def precision(self) -> float | None:
        return self.correct_auto_accepted / self.auto_accepted if self.auto_accepted else None

    @property
    def candidate_recall(self) -> float | None:
        return (
            self.retrieved_answers / self.queries_with_answers
            if self.queries_with_answers
            else None
        )

    @property
    def automatic_coverage(self) -> float | None:
        return (
            self.correct_auto_accepted / self.queries_with_answers
            if self.queries_with_answers
            else None
        )


def evaluate_matching(cases: list[dict[str, Any]]) -> MatchingEvaluation:
    """정답 후보 존재 여부와 상위 후보 선택을 함께 센다. 모든 확인 필요 전략은 통과하지 않는다."""
    auto = correct = false = answers = retrieved = 0
    missed: list[str] = []
    false_ids: list[str] = []
    for case in cases:
        data = dict(case["identity"])
        for key in ("abv", "age_years"):
            if data.get(key) is not None:
                data[key] = Decimal(str(data[key]))
        data["volumes_ml"] = tuple(data.get("volumes_ml", []))
        identity = ProductIdentity(**data)
        candidates = case["candidates"]
        ranked = sorted(
            ((score(identity, entry["name"]).value, entry["matches"]) for entry in candidates),
            key=lambda pair: pair[0],
            reverse=True,
        )
        has_answer = any(entry["matches"] for entry in candidates)
        answers += int(has_answer)
        recovered = any(value >= 0.5 and matches for value, matches in ranked[:5])
        retrieved += int(recovered)
        if has_answer and not recovered:
            missed.append(case["id"])
        if ranked and ranked[0][0] >= 0.85:
            auto += 1
            if ranked[0][1]:
                correct += 1
            else:
                false += 1
                false_ids.append(case["id"])
    return MatchingEvaluation(
        len(cases), answers, auto, correct, false, retrieved, tuple(missed), tuple(false_ids)
    )
