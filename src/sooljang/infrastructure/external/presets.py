"""번들 소스 프리셋 카탈로그(Task 34 PR5).

사이트마다 `adapter_spec` JSON 원문을 직접 쓰는 등록 방식(Task 18)은 정확하지만 사용자가
셀렉터 문법을 알아야 한다. 프리셋은 이미 검증된 스펙을 이름 하나로 골라 쓸 수 있게 한다 —
사이트 개편으로 스펙이 바뀌면 **앱 업데이트로 프리셋 버전을 올리는 것만으로 갱신**된다
(`application/external_sources.py::sync_presets` 가 `spec_overridden=False` 인 소스를
최신 버전으로 맞춘다).

계획서 초안은 `presets/*.yaml` 파일 + 로더였다 — 이 모듈은 대신 타입이 있는 Python
데이터클래스로 카탈로그를 직접 선언한다. 새 의존성(PyYAML)이 필요 없고, 프리셋 모양이
스키마 검증 없이도 정적으로 보장된다(오타는 타입 오류가 된다). "번들된 프리셋을 스키마
검증하는 CI 가드"라는 목표는 `tests/infrastructure/external/test_presets.py` 가
`PRESET_CATALOG` 를 순회하며 확인하는 것으로 대체했다.
"""

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True, slots=True)
class SourcePreset:
    """카탈로그에 실린 프리셋 하나."""

    key: str
    name: str
    base_url: str
    description: str
    #: 이 프리셋이 어울리는 주종 힌트(화면 표시용). 자동으로 카테고리를 지정하지는 않는다
    #: — 프리셋을 고른 사용자가 적용 주종을 직접 선택한다.
    category_hint: str | None
    #: 이 프리셋으로 소스를 등록하려면 자격 증명(API 키 등) 입력이 필요한지.
    requires_credentials: bool
    #: 프리셋 버전. 올릴 때마다 `spec_overridden=False` 인 기존 소스가 자동으로 이 스펙으로
    #: 갱신된다(`sync_presets`).
    version: int
    #: `docs/architecture.md` §7.2 v2 스키마와 같은 모양.
    adapter_spec: dict[str, Any] = field(default_factory=dict)


#: 데일리샷 프리셋(사용자 제공 원본, plan-external-v2.md PR5 절 "데일리샷 프리셋 원본"
#: 참조). `result_fields` 를 표준 키(Task 34 PR3: `price_krw`·`rating`·`rating_scale`·
#: `review_count`)로 매핑했다 — 원본은 한글 키(`가격`·`평점`·`리뷰수`)라 비교 뷰에 안
#: 잡혔다. `rating_scale` 은 원본에 없었고 D147 실측(평점 4.9)으로 5점 만점을 상수로 둔다.
#:
#: `base_url` 이 `https://dailyshot.co`(검색 자체는 `api.dailyshot.co`)인 이유는
#: `_same_host` 가 검색 결과 링크(`dailyshot.co/m/item/...`)와 비교하기 때문이다 — 두
#: 호스트가 다른 문제와 그로 인해 robots.txt 가 엉뚱한 호스트에서 확인되던 버그(발견 4)는
#: `adapter.py::_allowed` 가 매번 **실제 요청 대상 호스트**의 robots.txt 를 보도록 고쳐
#: 해결했다(D187) — 프리셋에 별도 필드를 두지 않아도 된다.
_DAILYSHOT = SourcePreset(
    key="dailyshot",
    name="데일리샷",
    base_url="https://dailyshot.co",
    description="국내 주류 커머스. 검색 결과에 가격·평점이 함께 온다.",
    category_hint=None,
    requires_credentials=False,
    version=1,
    adapter_spec={
        "version": 1,
        "format": "json",
        "search": {
            "item": "results",
            "fields": {
                "url": {"url_template": "https://dailyshot.co/m/item/{top_product_id}?item={id}"},
                "name": {"path": "name"},
            },
            "url_template": "https://api.dailyshot.co/items/search/?q={query}",
            "result_fields": {
                "price_krw": {"path": "price"},
                "rating": {"path": "review_rate"},
                "rating_scale": {"const": 5},
                "review_count": {"path": "review_count"},
            },
        },
    },
)

#: 등록 순서가 화면 표시 순서다.
PRESET_CATALOG: tuple[SourcePreset, ...] = (_DAILYSHOT,)

_PRESETS_BY_KEY: dict[str, SourcePreset] = {preset.key: preset for preset in PRESET_CATALOG}


def get_preset(key: str) -> SourcePreset | None:
    return _PRESETS_BY_KEY.get(key)
