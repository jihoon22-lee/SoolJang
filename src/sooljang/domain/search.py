"""확인된 이름을 연결하는 순수 검색 규칙. 제품 동일성 판정에는 사용하지 않는다."""

import json
import re
import unicodedata
from importlib.resources import files
from typing import TypedDict


class BrandAliases(TypedDict):
    canonical: str
    aliases: list[str]
    scope: str
    source_url: str
    checked_on: str


ALIASES: list[BrandAliases] = json.loads(
    files("sooljang.domain").joinpath("search_aliases.json").read_text(encoding="utf-8")
)
_CHOSUNG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"


def normalize_search_text(value: str) -> str:
    """Unicode·악센트·구두점·숙성 표기를 검색용으로만 정규화한다."""
    value = unicodedata.normalize("NFKC", value).lower()
    decomposed: list[str] = []
    latin_base = False
    for character in unicodedata.normalize("NFD", value):
        is_mark = unicodedata.category(character).startswith("M")
        if not is_mark:
            latin_base = "LATIN" in unicodedata.name(character, "")
        if not (is_mark and latin_base):
            decomposed.append(character)
    value = "".join(decomposed)
    value = unicodedata.normalize("NFC", value)
    value = re.sub(r"(\d+)\s*(?:years?\s*old|years?|yo|yr|y|년)(?![a-z])", r"\1", value)
    value = re.sub(r"(\d+(?:\.\d+)?)\s*l\b", lambda m: f"{float(m[1]) * 1000:g}ml", value)
    value = re.sub(r"[^\w\s]", " ", value).replace("_", " ")
    return " ".join(value.split())


def _alias_pattern(alias: str) -> re.Pattern[str]:
    needle = r"\s*".join(re.escape(part) for part in normalize_search_text(alias).split())
    return re.compile(r"(?<![a-z가-힣])" + needle + r"(?![a-z가-힣])")


# Compile the immutable dictionary once, not for every product/keystroke.
_ALIAS_RULES = tuple(
    (_alias_pattern(alias), normalize_search_text(entry["canonical"]))
    for entry in ALIASES
    for alias in sorted(entry["aliases"], key=len, reverse=True)
)


def _canonical(value: str) -> str:
    value = normalize_search_text(value)
    for pattern, canonical in _ALIAS_RULES:
        value = pattern.sub(canonical, value)
    return value


def _chosung(value: str) -> str:
    return "".join(
        _CHOSUNG[(ord(c) - 0xAC00) // 588] if 0xAC00 <= ord(c) <= 0xD7A3 else c for c in value
    )


def matches_query(name: str, query: str) -> bool:
    """별칭·초성을 지원하되 질의의 숫자와 판본 토큰을 버리지 않는다."""
    if not query.strip():
        return True
    if all(c in _CHOSUNG for c in query.strip()):
        values = [name]
        canonical = _canonical(name)
        for entry in ALIASES:
            key = normalize_search_text(str(entry["canonical"]))
            if key in canonical:
                values.extend(canonical.replace(key, str(alias)) for alias in entry["aliases"])
        return any(query.strip() in _chosung(value) for value in values)
    haystack, needle = _canonical(name), _canonical(query)
    if not set(re.findall(r"\d+", needle)).issubset(re.findall(r"\d+", haystack)):
        return False
    return query.strip().lower() in name.lower() or needle.replace(" ", "") in haystack.replace(
        " ", ""
    )


def expand_search_queries(query: str) -> list[str]:
    """원 질의와 확인한 이름의 반대 언어 표기, 최대 2개. 알 수 없는 이름은 추측하지 않는다."""
    original = query.strip()
    if not original:
        return []
    for entry in ALIASES:
        for alias in sorted(entry["aliases"], key=len, reverse=True):
            target = entry["canonical"] if re.search(r"[가-힣]", alias) else entry["aliases"][0]
            # Only replace the known brand span. Edition, units and punctuation stay verbatim.
            needle = r"\s*".join(re.escape(part) for part in alias.split())
            needle = needle.replace("’", "['’]")
            expanded = re.sub(
                r"(?<![a-z가-힣])" + needle + r"(?![a-z가-힣])",
                target,
                original,
                flags=re.IGNORECASE,
            )
            if expanded != original:
                return [original, expanded]
    return [original]
