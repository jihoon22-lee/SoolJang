"""이름 매칭 규칙 테스트(Task 34 PR2).

`matching.py` 는 네트워크 의존성이 없는 순수 모듈이라 HTTP 스텁 없이 표로 검증한다 —
케이스 추가 비용이 낮아 실측 오탐이 나올 때마다 한 줄씩 늘리면 된다.

**D148 이 남긴 오탐 3건이 여기서 회귀 테스트가 된다.** 접두사 게이트를 지우기 전에
새 점수 함수가 같은 오탐을 막는지부터 확인한다.
"""

from decimal import Decimal

import pytest

from sooljang.infrastructure.external.matching import (
    ProductIdentity,
    build_queries,
    parse_name,
    score,
)


def _identity(
    name: str,
    *,
    name_en: str | None = None,
    abv: Decimal | None = None,
    vintage: int | None = None,
    age_years: Decimal | None = None,
    volumes_ml: tuple[int, ...] = (),
) -> ProductIdentity:
    """이름만 주면 되는 경우가 대부분이라 기본값을 채운 얇은 헬퍼."""
    return ProductIdentity(
        name=name,
        name_en=name_en,
        abv=abv,
        vintage=vintage,
        age_years=age_years,
        volumes_ml=volumes_ml,
    )


# --- D148 오탐 회귀 -----------------------------------------------------------
#: 접두사만 같고 실제로는 다른 증류소·다른 제품. 전체 문자열 유사도만으로는 통과했다.
@pytest.mark.parametrize(
    ("query", "candidate"),
    [
        ("글렌고인 12년", "더 글렌리벳 12년"),
        ("글렌알라키 10년", "더 글렌그란트 10년"),
        ("우드포드 리저브", "우드포드 리저브 라이"),
    ],
)
def test_D148_오탐은_정탐보다_낮은_점수를_받는다(query: str, candidate: str) -> None:
    """정탐("부나하벤 12y"↔"부나하벤 12년")보다 낮으면 임계값으로 가를 수 있다.

    D148 이 기록한 실측에서는 오탐("우드포드 리저브"↔"우드포드 리저브 라이", 0.875)이
    정탐(0.857)보다 **높아** 임계값 조정으로는 원천적으로 못 갈랐다.
    """
    truthy = score(_identity("부나하벤 12y"), "부나하벤 12년")
    suspect = score(_identity(query), candidate)

    assert suspect.value < truthy.value


# --- 채택/탈락 표 -------------------------------------------------------------
@pytest.mark.parametrize(
    ("identity", "candidate", "should_reject", "reason"),
    [
        (
            _identity("발베니 12년", volumes_ml=(700,)),
            "발베니 12년 375ml",
            True,
            "용량이 다르면 다른 상품이고 가격 비교도 무의미하다",
        ),
        (
            _identity("아드벡 10년"),
            "아드벡 10년 700ml",
            False,
            "내 쪽 용량을 모르면 제약을 걸 근거가 없다",
        ),
        (
            _identity("맥캘란 12년"),
            "맥캘란 18년",
            True,
            "숙성 연수가 다르면 다른 제품",
        ),
        (
            _identity("샤토 마고", vintage=2015),
            "샤토 마고 2016",
            True,
            "빈티지가 다르면 다른 와인",
        ),
        (
            _identity("라가불린 16년", abv=Decimal("43.0")),
            "라가불린 16년 43.0도",
            False,
            "도수가 같으면 통과",
        ),
        (
            _identity("라가불린 16년", abv=Decimal("43.0")),
            "라가불린 16년 56.5%",
            True,
            "도수가 13%p 나 다르면 다른 배치가 아니라 다른 제품",
        ),
        (
            _identity("라가불린 16년", abv=Decimal("46.0")),
            "라가불린 16년 46.3%",
            False,
            "배치별 미세 차이(0.3%p)는 허용 범위",
        ),
    ],
)
def test_하드_제약은_양쪽에_값이_다_있을_때만_적용된다(
    identity: ProductIdentity, candidate: str, should_reject: bool, reason: str
) -> None:
    result = score(identity, candidate)

    assert result.rejected is should_reject, f"{reason}: {result.conflicts}"


def test_프로모션_블록과_동의어를_흡수한다() -> None:
    """접두사 게이트가 오히려 탈락시키던 케이스 — 상품명 앞에 판매 문구가 붙은 정답."""
    result = score(_identity("글렌알라키 10년 CS"), "[단독] 글렌알라키 10년 캐스크 스트렝스")

    assert result.rejected is False
    assert result.value > 0.7


def test_셰리_표기_흔들림을_흡수한다() -> None:
    assert score(_identity("맥캘란 12 셰리 오크"), "맥캘란 12 쉐리 오크").value > 0.9


# --- parse_name ---------------------------------------------------------------
@pytest.mark.parametrize(
    ("text", "expected_ml"),
    [("발베니 700ml", 700), ("발베니 700 ml", 700), ("발베니 0.7L", 700), ("발베니 70cl", 700)],
)
def test_용량_표기를_ml로_통일한다(text: str, expected_ml: int) -> None:
    assert parse_name(text).volume_ml == expected_ml


@pytest.mark.parametrize(
    ("text", "expected_age"),
    [("맥캘란 12년", 12.0), ("맥캘란 12y", 12.0), ("맥캘란 12yo", 12.0), ("맥캘란 aged 12", 12.0)],
)
def test_숙성_연수_표기를_통일한다(text: str, expected_age: float) -> None:
    assert parse_name(text).age_years == expected_age


def test_용량_숫자를_빈티지로_읽지_않는다() -> None:
    """`700ml` 의 700 이나 `1750ml` 의 1750 이 빈티지로 새면 하드 제약이 오작동한다."""
    facts = parse_name("발베니 12년 700ml")

    assert facts.volume_ml == 700
    assert facts.vintage is None
    assert facts.age_years == 12.0


def test_빈티지는_단독_4자리에서만_읽는다() -> None:
    assert parse_name("샤토 마고 2015").vintage == 2015


def test_속성으로_소비된_숫자는_토큰에_남지_않는다() -> None:
    tokens = parse_name("글렌피딕 12년 700ml 40%").tokens

    assert "글렌피딕" in tokens
    assert "700" not in tokens
    assert "12" not in tokens


# --- build_queries ------------------------------------------------------------
def test_영문명이_있으면_두번째_질의로_쓴다() -> None:
    queries = build_queries(_identity("글렌알라키 10년", name_en="GlenAllachie 10"))

    assert queries[0] == "글렌알라키 10년"
    assert "GlenAllachie 10" in queries


def test_영문명이_없으면_질의를_늘리지_않는다() -> None:
    assert build_queries(_identity("글렌알라키")) == ["글렌알라키"]


def test_배치_표기를_뺀_축약형을_질의에_넣는다() -> None:
    queries = build_queries(_identity("글렌알라키 10년 캐스크 스트렝스 #5"))

    assert queries[0] == "글렌알라키 10년 캐스크 스트렝스 #5"
    assert "글렌알라키 10년 캐스크 스트렝스" in queries


def test_축약형이_원본과_같으면_중복_질의를_만들지_않는다() -> None:
    assert build_queries(_identity("글렌피딕 12년")) == ["글렌피딕 12년"]


def test_질의는_최대_세개다() -> None:
    queries = build_queries(_identity("글렌알라키 10년 배치 5", name_en="GlenAllachie 10 Batch 5"))

    assert len(queries) <= 3
