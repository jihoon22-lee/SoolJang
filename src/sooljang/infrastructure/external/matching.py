"""제품 이름 매칭 — 정규화·점수·질의 생성(Task 34 PR2).

**네트워크 의존성이 없는 순수 모듈이다.** AGENTS.md 의 "네트워크 부수효과를 순수 변환
로직과 분리" 규약을 따른다 — 덕분에 매칭 규칙은 HTTP 스텁 없이 표 기반 테스트로 검증된다.

## 왜 전체 문자열 유사도만으로는 안 되는가

Task 18 이 쓰던 `difflib` 전체 문자열 유사도 하나로는 실측에서 두 종류의 오답이 났다.

1. **접두사만 같은 다른 증류소** — "글렌고인"↔"글렌리벳", "글렌알라키"↔"글렌그란트".
   D148 이 접두사 게이트로 막았지만, 그 게이트는 `[단독] 글렌알라키…` 처럼 상품명 앞에
   프로모션 블록이 붙으면 **정답을 탈락시키는** 부작용이 있었다.
2. **한쪽이 다른 쪽의 완전한 접두사** — "우드포드 리저브"↔"우드포드 리저브 라이".
   D148 이 "순수 문자열 비교로는 원천적으로 구분할 수 없다" 고 문서화한 한계다.
   실측 유사도 0.875 로, 정탐("부나하벤 12y"↔"부나하벤 12년", 0.857)보다 **높았다**.

이 모듈은 둘 다 푼다. 프로모션 블록을 정규화 단계에서 걷어내고, 토큰 집합을 주 가중치로
쓰며(1번), 용량·연수·빈티지·도수를 하드 제약으로 걸어(2번) 다른 제품을 탈락시킨다.
"우드포드 리저브 라이" 는 `라이` 토큰이 한쪽에만 있어 토큰 점수가 떨어진다.
"""

import difflib
import re
import unicodedata
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal

#: 상품명 앞뒤에 붙는 판매 문구. 술 이름의 일부가 아니라 노이즈다.
#: 괄호 속 식별 정보를 보존하고 판촉 단어만 토큰 단위로 뺀다.
_PROMO_TOKENS = frozenset(
    {
        "단독",
        "한정",
        "특가",
        "할인",
        "무료배송",
        "new",
        "best",
        "hot",
        "sale",
        "정품",
        "본품",
        "인기",
        "추천",
    }
)

#: 표기 흔들림을 한 형태로 모은다. 국내 몰은 같은 술을 여러 표기로 올린다.
#: 실측으로 확인한 것만 넣는다 — 상상해서 채우지 않는다.
_SYNONYMS = {
    "캐스크스트렝스": "cs",
    "캐스크스트렝쓰": "cs",
    "caskstrength": "cs",
    "싱글몰트": "sm",
    "singlemalt": "sm",
    "논칠필터드": "ncf",
    "논칠필터": "ncf",
    "nonchillfiltered": "ncf",
    "쉐리": "셰리",
    "sherry": "셰리",
    "버본": "버번",
    "bourbon": "버번",
    "위스키": "위스키",
    "whisky": "위스키",
    "whiskey": "위스키",
}

#: 용량. `700ml` `700 ml` `0.7L` `70cl` 을 전부 ml 로 환산한다.
_VOLUME_ML = re.compile(r"(\d+(?:\.\d+)?)\s*(ml|밀리|cl|l|리터)\b", re.IGNORECASE)
#: 숙성 연수. `10년` `10y` `10yo` `10 years` `aged 10`.
#: `aged 10` 은 뒤에 단위가 없으므로 별도 분기로 둔다 — 하나의 정규식에 optional 단위로
#: 합치면 "글렌피딕 12" 같은 단위 없는 숫자까지 연수로 읽어 버린다.
_AGE = re.compile(
    r"aged\s*(\d{1,2})\b|(?<!\d)(\d{1,2})\s*(?:년|yo|yrs|yr|years|year|y)\b", re.IGNORECASE
)
#: 도수. `46.3%` `46.3도` `abv 46.3`.
#: `%` 는 비단어 문자라 뒤에 `\b` 를 붙이면 절대 매치되지 않는다(실측으로 확인).
_ABV = re.compile(r"(?:abv\s*)?(\d{1,2}(?:\.\d)?)\s*(?:%|도(?![수]))", re.IGNORECASE)
#: 빈티지. 단독 4자리. 용량·도수·연수로 이미 소비된 숫자는 앞 단계에서 지워져 남지 않는다.
_VINTAGE = re.compile(r"(?<!\d)(19\d{2}|20\d{2})(?!\d)(?:년)?")

_TOKEN_SPLIT = re.compile(r"[\W_]+", re.UNICODE)
_BATCH = re.compile(r"(?:batch|배치|#)\s*([a-z0-9-]+)", re.IGNORECASE)
_CASK = re.compile(r"(?:cask|캐스크)\s*(?:no\.?\s*)?(\d+[a-z0-9-]*)", re.IGNORECASE)
_PACK = re.compile(r"(\d+)\s*(?:병|bottles?|팩|pack)\b", re.IGNORECASE)
_SET = re.compile(r"(?:세트|선물세트|글라스|gift\s*set|glass|\bset\b)", re.IGNORECASE)


def _unicode_name(text: str) -> str:
    # NFKC로 전각/호환 문자를 합치고 Latin 악센트만 제거한다. 일본어 탁점은 보존한다.
    folded = unicodedata.normalize("NFKC", text).casefold()
    return "".join(
        "".join(
            part for part in unicodedata.normalize("NFD", char) if not unicodedata.combining(part)
        )
        if "LATIN" in unicodedata.name(char, "")
        else char
        for char in folded
    )


#: 토큰 집합에 주는 가중치. 어순·수식어가 사이트마다 달라 문자열 비율만으로는 흔들린다.
_TOKEN_WEIGHT = 0.6
_STRING_WEIGHT = 0.4
#: 도수는 배치별로 미세하게 다를 수 있다(46.0 vs 46.3). 이 폭 안이면 같은 제품으로 본다.
_ABV_TOLERANCE = 0.6


@dataclass(frozen=True)
class ProductIdentity:
    """내 제품 쪽 식별 정보. `Product` 와 그 SKU 에서 조립한다.

    Task 18 은 `product.name` 하나만 매칭에 썼다 — `name_en`·`abv`·`vintage`·
    `age_years`·`producer`·`sku.volume_ml` 이 전부 스키마에 있는데도 놀고 있었다.
    """

    name: str
    name_en: str | None = None
    producer: str | None = None
    abv: Decimal | None = None
    vintage: int | None = None
    age_years: Decimal | None = None
    volumes_ml: tuple[int, ...] = ()


@dataclass(frozen=True)
class NameFacts:
    """상품명 하나에서 뽑아낸 사실. 이름에 적혀 있는 것만 담는다."""

    tokens: frozenset[str]
    normalized: str
    volume_ml: int | None = None
    age_years: float | None = None
    abv: float | None = None
    vintage: int | None = None
    batch: str | None = None
    cask: str | None = None
    pack_count: int = 1
    is_set: bool = False


@dataclass(frozen=True)
class MatchScore:
    """점수와, 있다면 탈락 사유. `conflicts` 가 비어 있지 않으면 다른 제품이다."""

    value: float
    conflicts: tuple[str, ...] = ()
    missing: tuple[str, ...] = ()
    relationship: Literal[
        "same_sku", "same_product", "related", "needs_confirmation", "mismatch"
    ] = "needs_confirmation"

    @property
    def rejected(self) -> bool:
        return bool(self.conflicts)


def _to_ml(amount: float, unit: str) -> int:
    unit = unit.lower()
    if unit in ("l", "리터"):
        return round(amount * 1000)
    if unit == "cl":
        return round(amount * 10)
    return round(amount)


def _apply_synonyms(raw_tokens: list[str]) -> set[str]:
    """동의어를 적용한다. 인접 두 토큰을 붙여 본 뒤 단일 토큰을 본다.

    "캐스크 스트렝스" 처럼 **공백으로 갈린 복합어**가 흔하다. 토큰 하나씩만 보면
    `캐스크스트렝스` 키가 영원히 매치되지 않아 동의어 표가 무용지물이 된다.
    """
    tokens: set[str] = set()
    index = 0
    while index < len(raw_tokens):
        if index + 1 < len(raw_tokens):
            joined = raw_tokens[index] + raw_tokens[index + 1]
            if joined in _SYNONYMS:
                tokens.add(_SYNONYMS[joined])
                index += 2
                continue
        token = raw_tokens[index]
        tokens.add(_SYNONYMS.get(token, token))
        index += 1
    return tokens


def parse_name(text: str) -> NameFacts:
    """상품명에서 토큰과 속성(용량·연수·도수·빈티지)을 뽑는다.

    속성으로 소비된 숫자는 토큰에서 빠진다 — 그래야 `700` 이 빈티지로 잘못 읽히거나
    용량 숫자가 이름 유사도에 노이즈로 섞이지 않는다.
    """
    # 괄호는 구두점일 뿐이다. 판촉 토큰만 아래에서 제거하고 판본 정보는 유지한다.
    lowered = _unicode_name(text)
    batch_match = _BATCH.search(lowered)
    cask_match = _CASK.search(lowered)
    pack_match = _PACK.search(lowered)

    volume_ml: int | None = None
    age_years: float | None = None
    abv: float | None = None
    vintage: int | None = None

    def take_volume(match: re.Match[str]) -> str:
        nonlocal volume_ml
        if volume_ml is None:
            volume_ml = _to_ml(float(match.group(1)), match.group(2))
        return " "

    def take_age(match: re.Match[str]) -> str:
        nonlocal age_years
        if age_years is None:
            age_years = float(match.group(1) or match.group(2))
        return " "

    def take_abv(match: re.Match[str]) -> str:
        nonlocal abv
        if abv is None:
            abv = float(match.group(1))
        return " "

    # 순서가 중요하다. 용량(`0.7l`)을 먼저 걷어내지 않으면 도수 정규식이 숫자를 물고,
    # 연수·도수를 걷어내야 남은 4자리만 빈티지로 남는다.
    stripped = _VOLUME_ML.sub(take_volume, lowered)
    stripped = _ABV.sub(take_abv, stripped)
    stripped = _AGE.sub(take_age, stripped)

    stripped = _BATCH.sub(" ", _CASK.sub(" ", stripped))
    vintage_match = _VINTAGE.search(stripped)
    if vintage_match is not None:
        vintage = int(vintage_match.group(1))
        stripped = stripped[: vintage_match.start()] + " " + stripped[vintage_match.end() :]

    raw_tokens = [
        token for token in _TOKEN_SPLIT.split(stripped) if token and token not in _PROMO_TOKENS
    ]
    tokens = _apply_synonyms(raw_tokens)
    normalized = "".join(sorted(tokens))

    return NameFacts(
        tokens=frozenset(tokens),
        normalized=normalized,
        volume_ml=volume_ml,
        age_years=age_years,
        abv=abv,
        vintage=vintage,
        batch=batch_match.group(1) if batch_match else None,
        cask=cask_match.group(1) if cask_match else None,
        pack_count=int(pack_match.group(1)) if pack_match else 1,
        is_set=bool(_SET.search(lowered)),
    )


def _jaccard(left: frozenset[str], right: frozenset[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def _conflicts(
    identity: ProductIdentity, query: NameFacts, candidate: NameFacts
) -> tuple[str, ...]:
    """하드 제약. **양쪽에 값이 다 있을 때만** 적용한다.

    한쪽이 모르는 값으로 정답을 탈락시키면 안 된다 — 상품명에 용량이 안 적힌 사이트가
    흔하고, 그때는 제약을 걸 근거가 없다. 이 "둘 다 있을 때만" 이 핵심 안전장치다.
    """
    conflicts: list[str] = []

    query_volumes = set(identity.volumes_ml)
    if query.volume_ml is not None:
        query_volumes.add(query.volume_ml)
    if (
        candidate.volume_ml is not None
        and query_volumes
        and candidate.volume_ml not in query_volumes
    ):
        conflicts.append("volume_ml")

    query_age = query.age_years
    if query_age is None and identity.age_years is not None:
        query_age = float(identity.age_years)
    if (
        candidate.age_years is not None
        and query_age is not None
        and candidate.age_years != query_age
    ):
        conflicts.append("age_years")

    # 사용자가 별도 필드에 등록한 빈티지를 이름의 오래된/모호한 표기보다 우선한다.
    query_vintage = identity.vintage if identity.vintage is not None else query.vintage
    if (
        candidate.vintage is not None
        and query_vintage is not None
        and candidate.vintage != query_vintage
    ):
        conflicts.append("vintage")

    query_abv = query.abv
    if query_abv is None and identity.abv is not None:
        query_abv = float(identity.abv)
    if (
        candidate.abv is not None
        and query_abv is not None
        and abs(candidate.abv - query_abv) > _ABV_TOLERANCE
    ):
        conflicts.append("abv")

    for name in ("batch", "cask"):
        expected = getattr(query, name)
        actual = getattr(candidate, name)
        if expected is not None and actual is not None and expected != actual:
            conflicts.append(name)
    if query.pack_count != candidate.pack_count or query.is_set != candidate.is_set:
        conflicts.append("packaging")
    return tuple(conflicts)


def score(
    identity: ProductIdentity, candidate_name: str, *, query: str | None = None
) -> MatchScore:
    """내 제품과 후보 상품명의 일치도.

    `query`는 호출 호환성을 위해 받으며 최종 판정은 원래 identity를 사용한다.
    점수는 문자열/속성 일치 지표이며 통계적 확률이 아니다.
    """
    # 검색 질의가 축약되더라도 최종 식별 근거는 원본/등록된 원어명에서만 얻는다.
    originals = [parse_name(identity.name)]
    if identity.name_en:
        originals.append(parse_name(identity.name_en))
    candidate_facts = parse_name(candidate_name)
    conflicts = tuple(
        dict.fromkeys(
            conflict
            for original in originals
            for conflict in _conflicts(identity, original, candidate_facts)
        )
    )
    similarities = [
        _TOKEN_WEIGHT * _jaccard(original.tokens, candidate_facts.tokens)
        + _STRING_WEIGHT
        * difflib.SequenceMatcher(None, original.normalized, candidate_facts.normalized).ratio()
        if original.tokens and candidate_facts.tokens
        else 0.0
        for original in originals
    ]
    value = max(similarities)
    missing: list[str] = []
    for name in ("age_years", "vintage", "abv", "batch", "cask", "volume_ml"):
        expected = any(getattr(original, name) is not None for original in originals)
        expected = (
            expected or bool(identity.volumes_ml)
            if name == "volume_ml"
            else expected or getattr(identity, name, None) is not None
        )
        if expected and getattr(candidate_facts, name) is None:
            missing.append(name)
    if conflicts:
        relationship = "same_product" if conflicts == ("volume_ml",) else "mismatch"
        return MatchScore(0.0, conflicts, tuple(missing), relationship)
    if missing:
        value = min(value, 0.84)
    relationship = (
        "needs_confirmation"
        if missing
        else "same_sku"
        if value >= 0.85 and candidate_facts.volume_ml is not None
        else "same_product"
        if value >= 0.85
        else "related"
        if value >= 0.5
        else "mismatch"
    )
    return MatchScore(value, (), tuple(missing), relationship)


def is_excluded(candidate_name: str, exclude_keywords: list[str]) -> bool:
    """후보 이름이 제외 키워드에 걸리는지(Task 34 PR7).

    단순 부분 문자열 매칭은 오작동한다 — `잔`이 `잔티`·`발란자`에도 걸린다. 이 함수는
    `parse_name`의 토큰 집합을 재사용해 **토큰 단위로** 비교한다: 키워드 자체도 같은
    파이프라인으로 토큰화해, 키워드의 토큰 전부가 후보의 토큰 집합에 포함될 때만
    제외한다(`부분 문자열 포함`이 아니라 `부분 집합`). 초안 목록은 전부 한 단어라 결과는
    같지만, 앞으로 여러 단어짜리 키워드가 추가돼도 그대로 맞는 규칙이다.
    """
    if not exclude_keywords:
        return False
    candidate_tokens = parse_name(candidate_name).tokens
    for keyword in exclude_keywords:
        keyword_tokens = parse_name(keyword).tokens
        if keyword_tokens and keyword_tokens <= candidate_tokens:
            return True
    return False


#: 배치·한정판 표기. 축약형 질의를 만들 때 뺀다.
_BATCH_MARKS = re.compile(r"(#\s*\d+|배치\s*\d+|batch\s*\d+|한정판|limited)", re.IGNORECASE)


def build_queries(identity: ProductIdentity) -> list[str]:
    """검색에 쓸 질의를 우선순위대로 만든다(최대 3개).

    각 질의가 HTTP 요청 1회라 소스의 `rate_limit_per_min` 을 그만큼 소비한다. 상한을
    3으로 두고, 호출부가 자동 채택 구간에 들면 즉시 멈춘다.

    2번(`name_en`)이 있는 이유: 국내 몰에 영문명으로만 등록된 상품이 흔한데, 스키마에
    있는 `name_en` 이 Task 18 에서 전혀 쓰이지 않았다.
    """
    queries: list[str] = [identity.name.strip()]

    if identity.name_en:
        english = identity.name_en.strip()
        if english and english.lower() != identity.name.strip().lower():
            queries.append(english)

    short = _BATCH_MARKS.sub(" ", identity.name)
    short = re.sub(r"\s+", " ", short).strip()
    if short and short != identity.name.strip():
        queries.append(short)

    # 중복 제거하되 순서는 유지한다.
    seen: set[str] = set()
    unique: list[str] = []
    for candidate in queries:
        key = candidate.lower()
        if candidate and key not in seen:
            seen.add(key)
            unique.append(candidate)
    return unique[:3]


def detail_name(name: str, fields: dict[str, object]) -> str:
    """허용된 상세 필드에서 명시한 속성만 이름 판정 근거에 보탠다."""
    facts = parse_name(name)
    pieces = [name]
    for key, unit in (("volume_ml", "ml"), ("age_years", "y"), ("abv", "%"), ("vintage", "")):
        value = fields.get(key)
        if (
            getattr(facts, key) is None
            and isinstance(value, (int, float, Decimal))
            and not isinstance(value, bool)
        ):
            pieces.append(f"{value}{unit}")
    return " ".join(pieces)


def score_details(identity: ProductIdentity, name: str, fields: dict[str, object]) -> MatchScore:
    """이름·상세 속성 상충은 확정하지 않는다. 결측 상세는 동일 판정의 근거가 아니다."""
    original = parse_name(name)
    contradictions = []
    for key in ("volume_ml", "age_years", "abv", "vintage"):
        value = fields.get(key)
        parsed = getattr(original, key)
        if (
            parsed is not None
            and isinstance(value, (int, float, Decimal))
            and not isinstance(value, bool)
            and Decimal(str(value)) != Decimal(str(parsed))
        ):
            contradictions.append(f"detail_{key}")
    candidate_producer = fields.get("producer")
    if (
        identity.producer
        and isinstance(candidate_producer, str)
        and parse_name(identity.producer).tokens != parse_name(candidate_producer).tokens
    ):
        contradictions.append("producer")
    judgment = score(identity, detail_name(name, fields))
    if contradictions:
        return MatchScore(0.0, (*judgment.conflicts, *contradictions), judgment.missing, "mismatch")
    return judgment
