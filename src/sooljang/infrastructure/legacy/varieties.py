"""레거시 `품종` 값 정규화.

이 컬럼은 다목적이다(`docs/legacy-schema.md` §4.8). 와인 품종, 맥주 스타일(`Lager`·
`IPA`·`Stout`), 브랜디 등급(`Cognac`), 백주 향형(`농향형`)이 같은 컬럼에 섞여 있고
41행은 셀 내 개행으로 여러 값을 담고 있다.

정규화 목표는 두 가지다. 표기 오타를 합쳐 같은 품종이 두 레코드로 갈라지지 않게 하고,
대소문자·공백 차이를 흡수하는 것이다. 의미 분류는 하지 않는다. 주종 문맥으로 해석하면
충분하고, 섣부른 분류는 원본 정보를 잃는다.
"""

import re
from dataclasses import dataclass

#: 실측 오타·표기 변형 사전. 키는 소문자 정규화 후 비교한다.
#: `Carbernet Sauvignon` 은 레거시에 실제로 존재하는 오타다.
CANONICAL_VARIETIES: dict[str, str] = {
    "carbernet sauvignon": "Cabernet Sauvignon",
    "cabernet sauvingon": "Cabernet Sauvignon",
    "cabernet sauvignon": "Cabernet Sauvignon",
    "cabernet franc": "Cabernet Franc",
    "sauvignon blanc": "Sauvignon Blanc",
    "chardonay": "Chardonnay",
    "chardonnay": "Chardonnay",
    "riesling": "Riesling",
    "reisling": "Riesling",
    "pinot noir": "Pinot Noir",
    "pinot nior": "Pinot Noir",
    "merlot": "Merlot",
    "malbec": "Malbec",
    "syrah": "Syrah",
    "shiraz": "Syrah",
    "tempranillo": "Tempranillo",
    "sangiovese": "Sangiovese",
    "nebbiolo": "Nebbiolo",
    "primitivo": "Primitivo",
    "zinfandel": "Zinfandel",
    "furmint": "Furmint",
    "semillon": "Sémillon",
    "sémillon": "Sémillon",
    "muscat de frontignan": "Muscat de Frontignan",
    "gewurztraminer": "Gewürztraminer",
    "gewürztraminer": "Gewürztraminer",
    "viognier": "Viognier",
    "aged tawny port": "Aged Tawny Port",
    # 맥주 스타일
    "lager": "Lager",
    "pilsener": "Pilsner",
    "pilsner": "Pilsner",
    "ipa": "IPA",
    "pale ale": "Pale Ale",
    "light ale": "Light Ale",
    "stout": "Stout",
    "porter": "Porter",
    "weissbier": "Weissbier",
    "hefeweizen": "Hefeweizen",
    "dunkelweizen": "Dunkelweizen",
    "witbier": "Witbier",
    "belgian white ale": "Belgian White Ale",
    "abbey ale": "Abbey Ale",
    "trappist ale": "Trappist Ale",
    "dubbel": "Dubbel",
    "tripel": "Tripel",
    "quadrupel": "Quadrupel",
    # 브랜디 등급
    "cognac": "Cognac",
    "armagnac": "Armagnac",
    "calvados": "Calvados",
    # 백주 향형
    "농향형": "농향형",
    "장향형": "장향형",
    "청향형": "청향형",
    "겸향형": "겸향형",
    "미향형": "미향형",
}

_WHITESPACE = re.compile(r"[\s\u3000]+")


@dataclass(frozen=True, slots=True)
class VarietyResolution:
    """품종 한 건의 정규화 결과."""

    raw: str
    name: str
    canonical: bool


def normalize_variety(raw: str) -> VarietyResolution | None:
    """품종 한 건을 정규화한다. 사전에 없으면 표기만 다듬어 그대로 보존한다."""
    text = _WHITESPACE.sub(" ", raw.strip())
    if not text:
        return None
    canonical = CANONICAL_VARIETIES.get(text.lower())
    if canonical is not None:
        return VarietyResolution(raw=text, name=canonical, canonical=True)
    return VarietyResolution(raw=text, name=text, canonical=False)


def normalize_varieties(values: list[str]) -> list[VarietyResolution]:
    """다중 품종을 정규화하고 중복을 제거한다. 입력 순서를 유지한다."""
    seen: set[str] = set()
    resolved: list[VarietyResolution] = []
    for value in values:
        item = normalize_variety(value)
        if item is None or item.name in seen:
            continue
        seen.add(item.name)
        resolved.append(item)
    return resolved
