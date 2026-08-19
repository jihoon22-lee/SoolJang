"""번들 프리셋 카탈로그 검증(Task 34 PR5). 네트워크 불필요 — 프리셋 오타가 사용자에게
배포되는 것을 CI 에서 막는다."""

import json

import pytest

from sooljang.infrastructure.external.presets import PRESET_CATALOG, get_preset


def test_카탈로그가_비어있지_않다() -> None:
    assert len(PRESET_CATALOG) > 0


@pytest.mark.parametrize("preset", PRESET_CATALOG, ids=lambda p: p.key)
def test_프리셋_기본_필드가_채워져_있다(preset) -> None:  # noqa: ANN001
    assert preset.key
    assert preset.name
    assert preset.base_url.startswith(("http://", "https://"))
    assert preset.description
    assert preset.version >= 1


@pytest.mark.parametrize("preset", PRESET_CATALOG, ids=lambda p: p.key)
def test_adapter_spec가_JSON_직렬화_가능하다(preset) -> None:  # noqa: ANN001
    # DB JSONB 컬럼에 그대로 들어갈 값이라 왕복이 보장돼야 한다.
    json.dumps(preset.adapter_spec)


@pytest.mark.parametrize("preset", PRESET_CATALOG, ids=lambda p: p.key)
def test_adapter_spec에_search가_있다(preset) -> None:  # noqa: ANN001
    assert isinstance(preset.adapter_spec.get("search"), dict)
    assert isinstance(preset.adapter_spec["search"].get("url_template"), str)


def test_키가_중복되지_않는다() -> None:
    keys = [preset.key for preset in PRESET_CATALOG]
    assert len(keys) == len(set(keys))


def test_get_preset_없는_키는_None() -> None:
    assert get_preset("존재하지-않음") is None


def test_get_preset_있는_키() -> None:
    preset = get_preset("dailyshot")
    assert preset is not None
    assert preset.name == "데일리샷"
