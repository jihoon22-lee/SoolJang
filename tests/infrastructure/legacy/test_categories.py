"""주종 계층 매핑과 품종 정규화 테스트."""

from sooljang.infrastructure.legacy.categories import (
    DEFAULT_CATEGORY_PATHS,
    DEFAULT_ROOT_CATEGORIES,
    MAX_CATEGORY_DEPTH,
    UNCLASSIFIED_ROOT,
    default_seed_paths,
    forward_fill_categories,
    resolve_category,
)
from sooljang.infrastructure.legacy.varieties import normalize_varieties


def test_forward_fill_restores_group_separator_column() -> None:
    """`종류` 는 결측이 아니라 그룹 구분자다. 전파해야 전체 행이 주종을 갖는다."""
    values: list[str | None] = ["레드와인", "", "", "백주", "", "전통주(탁주)", ""]

    assert forward_fill_categories(values) == [
        "레드와인",
        "레드와인",
        "레드와인",
        "백주",
        "백주",
        "전통주(탁주)",
        "전통주(탁주)",
    ]


def test_forward_fill_leaves_leading_rows_unfilled() -> None:
    # 첫 구분자 이전 행은 전파받을 값이 없다. 상위 계층이 경고로 보고한다.
    assert forward_fill_categories(["", "", "맥주"]) == [None, None, "맥주"]


def test_resolve_category_maps_to_measured_hierarchy() -> None:
    resolved = resolve_category("싱글몰트 위스키")

    assert resolved is not None
    assert resolved.path == ("양주", "위스키", "싱글몰트 위스키")
    assert resolved.root == "양주"
    assert resolved.leaf == "싱글몰트 위스키"
    assert resolved.matched is True


def test_resolve_category_maps_sweet_wine_to_three_levels() -> None:
    resolved = resolve_category("토카이와인")

    assert resolved is not None
    assert resolved.path == ("와인", "스위트와인", "토카이와인")
    assert resolved.depth == 3


def test_unknown_category_is_preserved_under_unclassified() -> None:
    """사전에 없는 값도 버리지 않는다. 사용자가 나중에 옮길 수 있어야 한다."""
    resolved = resolve_category("듣도 보도 못한 주종")

    assert resolved is not None
    assert resolved.matched is False
    assert resolved.root == UNCLASSIFIED_ROOT
    assert resolved.leaf == "듣도 보도 못한 주종"


def test_resolve_category_returns_none_for_empty() -> None:
    assert resolve_category(None) is None
    assert resolve_category("   ") is None


def test_default_root_categories_match_measured_rollup() -> None:
    # 레거시 통계 롤업의 최상위 5개. 병수 합계가 1,078 로 시트 합계행과 일치했다.
    assert set(DEFAULT_ROOT_CATEGORIES) == {"맥주", "와인", "양주", "전통주", "사케"}


def test_every_mapping_starts_from_a_default_root() -> None:
    for path in DEFAULT_CATEGORY_PATHS.values():
        assert path[0] in DEFAULT_ROOT_CATEGORIES


def test_seed_paths_list_parents_before_children() -> None:
    """시드 적용 시 부모가 없으면 자식을 만들 수 없다."""
    paths = default_seed_paths()
    seen: set[tuple[str, ...]] = set()

    for path in paths:
        if len(path) > 1:
            assert path[:-1] in seen, f"{path} 의 부모가 아직 없다"
        seen.add(path)


def test_seed_paths_include_unclassified_bucket() -> None:
    assert (UNCLASSIFIED_ROOT,) in default_seed_paths()


def test_seed_depth_stays_within_the_guard() -> None:
    # 사용자는 더 깊게 만들 수 있다. 기본 시드가 상한을 잡아먹지 않아야 한다.
    assert max(len(path) for path in default_seed_paths()) < MAX_CATEGORY_DEPTH


def test_variety_typo_is_normalized() -> None:
    resolved = normalize_varieties(["Carbernet Sauvignon"])

    assert len(resolved) == 1
    assert resolved[0].name == "Cabernet Sauvignon"
    assert resolved[0].canonical is True
    assert resolved[0].raw == "Carbernet Sauvignon"


def test_multivalue_varieties_are_split_and_deduplicated() -> None:
    resolved = normalize_varieties(["Weissbier", "Hefeweizen", "weissbier"])

    assert [item.name for item in resolved] == ["Weissbier", "Hefeweizen"]


def test_unknown_variety_is_preserved_as_is() -> None:
    resolved = normalize_varieties(["처음 보는 품종"])

    assert resolved[0].name == "처음 보는 품종"
    assert resolved[0].canonical is False


def test_variety_column_accepts_beer_styles_and_baijiu_aroma() -> None:
    # 이 컬럼은 다목적이다. 와인 품종·맥주 스타일·백주 향형이 섞여 있다.
    names = [item.name for item in normalize_varieties(["IPA", "농향형", "Cognac"])]

    assert names == ["IPA", "농향형", "Cognac"]


def test_empty_variety_values_are_dropped() -> None:
    assert normalize_varieties(["", "   "]) == []
