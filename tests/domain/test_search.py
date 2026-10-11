"""한영 이름 검색 공통 정답. 실제 검색 제공자의 성능과 구분한다."""

import json
from pathlib import Path

import pytest

from sooljang.domain.search import expand_search_queries, matches_query

CASES = json.loads((Path(__file__).parents[1] / "fixtures/search_cases.json").read_text())["cases"]


@pytest.mark.parametrize("case", CASES, ids=[item["id"] for item in CASES])
def test_shared_name_retrieval(case: dict[str, object]) -> None:
    assert matches_query(str(case["name"]), str(case["query"])) is case["match"]


def test_expansion_preserves_edition_and_has_a_bound() -> None:
    queries = expand_search_queries("글렌알라키 12년 700ml 배치 3")
    assert queries[0] == "글렌알라키 12년 700ml 배치 3"
    assert len(queries) == 2
    assert "glenallachie" in queries[1].lower()
    assert queries[1] == "GlenAllachie 12년 700ml 배치 3"


def test_unknown_query_is_not_guessed() -> None:
    assert expand_search_queries("미확인브랜드") == ["미확인브랜드"]
    assert matches_query("The Glenlivet 12", "ㄱㄹㄹㅂ")


def test_reverse_expansion_keeps_original_units_and_edition() -> None:
    assert expand_search_queries("GlenAllachie 12 years old, 0.7L (Batch 3)") == [
        "GlenAllachie 12 years old, 0.7L (Batch 3)",
        "글렌알라키 12 years old, 0.7L (Batch 3)",
    ]


@pytest.mark.parametrize(
    ("name", "query", "expected"),
    [
        ("The Glenlivet 12", "The", True),
        ("The Glenlivet 12", "The Glen", True),
        ("The Glenlivet 12", "The Glenlivet 1", False),
        ("ガ 12", "カ 12", False),
        ("ガ 12", "カ\u3099 12", True),
        ("Kahlúa", "Kahlua", True),
    ],
)
def test_partial_original_and_non_latin_marks(name: str, query: str, expected: bool) -> None:
    assert matches_query(name, query) is expected
