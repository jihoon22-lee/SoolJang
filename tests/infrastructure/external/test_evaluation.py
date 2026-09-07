"""후보를 전부 보류해 정확도가 좋아 보이는 집계를 방지한다."""

from sooljang.infrastructure.external.evaluation import evaluate_matching


def test_empty_and_unanswered_sets_do_not_report_perfect_precision() -> None:
    empty = evaluate_matching([])
    assert empty.precision is None
    assert empty.candidate_recall is None
    assert empty.automatic_coverage is None
    no_candidates = evaluate_matching(
        [{"id": "missing", "identity": {"name": "Harbor 12y"}, "candidates": []}]
    )
    assert no_candidates.cases == 1
    assert no_candidates.precision is None


def test_false_acceptance_and_unrecovered_answers_are_counted_separately() -> None:
    result = evaluate_matching(
        [
            {
                "id": "wrong",
                "identity": {"name": "Harbor 12y"},
                "candidates": [{"name": "Harbor 12y", "matches": False}],
            },
            {
                "id": "right",
                "identity": {"name": "Harbor 12y", "age_years": "12"},
                "candidates": [{"name": "Harbor 12y", "matches": True}],
            },
            {
                "id": "missed",
                "identity": {"name": "한글 제품명"},
                "candidates": [{"name": "Foreign Product", "matches": True}],
            },
        ]
    )
    assert result.precision == 0.5
    assert result.candidate_recall == 0.5
    assert result.automatic_coverage == 0.5
    assert result.false_accept_case_ids == ("wrong",)
    assert result.missed_case_ids == ("missed",)
