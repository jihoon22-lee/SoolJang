"""레거시 `종류` 값을 주종 계층으로 매핑한다.

**여기 정의된 계층은 고정 분류가 아니라 기본 시드다.** 사용자는 최상위부터 말단까지 어느
깊이에서든 카테고리를 추가·이름 변경·이동·순서 변경·삭제·병합할 수 있다
(`docs/architecture.md` §2.3 `category`). 이 모듈의 역할은 두 가지로 한정된다.

1. 최초 시드로 넣을 기본 계층을 제공한다
2. 레거시 임포트에서 `종류` 문자열을 그 계층의 경로로 해석한다

사전에 없는 값은 버리지 않고 `미분류` 아래에 그대로 만든다. 임포트가 데이터를 조용히 잃는
것보다, 사용자가 나중에 옮길 수 있게 보존하는 것이 낫다.

기본 계층은 레거시 통계 블록의 롤업에서 도출했다(`docs/legacy-schema.md` §4.4). 최상위는
맥주·와인·양주·전통주·사케 5개이며, 롤업 병수 합계가 1,078 로 시트 합계행과 일치해 실제
사용 중인 분류임을 확인했다.

`종류` 컬럼은 결측이 아니라 **그룹 구분자**다. 각 주종 그룹의 첫 행에만 값이 있고 나머지는
비어 있어, forward-fill 로 복원해야 한다(§4.3).
"""

from dataclasses import dataclass

#: 계층 깊이 상한. 순환 방지와 별개로 폭주하는 중첩을 막는 안전장치다.
#: 사용자 계층에 실질적 제약이 되지 않는 값이다.
MAX_CATEGORY_DEPTH = 8

#: 레거시 `종류` 값 → 기본 시드 계층 경로.
#: 사용자가 계층을 바꾸면 이 표는 임포트 해석용 기본값으로만 남는다.
DEFAULT_CATEGORY_PATHS: dict[str, tuple[str, ...]] = {
    # 와인
    "레드와인": ("와인", "레드와인"),
    "화이트와인": ("와인", "화이트와인"),
    "로제와인": ("와인", "로제와인"),
    "스파클링와인": ("와인", "스파클링와인"),
    "오렌지와인": ("와인", "오렌지와인"),
    "토카이와인": ("와인", "스위트와인", "토카이와인"),
    "소테른/바르삭/루피악 와인": ("와인", "스위트와인", "소테른/바르삭/루피악 와인"),
    "남아공 스위트와인": ("와인", "스위트와인", "남아공 스위트와인"),
    "파시토와인": ("와인", "스위트와인", "파시토와인"),
    "리브잘트와인": ("와인", "스위트와인", "리브잘트와인"),
    "아이스와인": ("와인", "스위트와인", "아이스와인"),
    "귀부와인": ("와인", "스위트와인", "귀부와인"),
    "스위트와인": ("와인", "스위트와인"),
    "포트와인": ("와인", "주정강화와인", "포트와인"),
    "셰리와인": ("와인", "주정강화와인", "셰리와인"),
    "마데이라와인": ("와인", "주정강화와인", "마데이라와인"),
    "세투발와인": ("와인", "주정강화와인", "세투발와인"),
    "주정강화와인": ("와인", "주정강화와인"),
    # 사케
    "사케": ("사케",),
    # 전통주
    "전통주(탁주)": ("전통주", "탁주"),
    "전통주(약주)": ("전통주", "약주"),
    "전통주(증류주)": ("전통주", "증류주"),
    "전통주(리큐르)": ("전통주", "리큐르"),
    "전통주(과실주)": ("전통주", "과실주"),
    "전통주": ("전통주",),
    # 맥주 — 스타일은 variety 로 표현한다
    "맥주": ("맥주",),
    # 양주
    "싱글몰트 위스키": ("양주", "위스키", "싱글몰트 위스키"),
    "블렌디드 위스키": ("양주", "위스키", "블렌디드 위스키"),
    "버번 위스키": ("양주", "위스키", "버번 위스키"),
    "라이 위스키": ("양주", "위스키", "라이 위스키"),
    "블렌디드 몰트 위스키": ("양주", "위스키", "블렌디드 몰트 위스키"),
    "그레인 위스키": ("양주", "위스키", "그레인 위스키"),
    "위스키": ("양주", "위스키"),
    "브랜디": ("양주", "기타 양주", "브랜디"),
    "럼": ("양주", "기타 양주", "럼"),
    "데낄라": ("양주", "기타 양주", "데낄라"),
    "메즈칼": ("양주", "기타 양주", "메즈칼"),
    "진": ("양주", "기타 양주", "진"),
    "보드카": ("양주", "기타 양주", "보드카"),
    "리큐르": ("양주", "기타 양주", "리큐르"),
    "백주": ("양주", "기타 양주", "백주"),
    "기타 양주": ("양주", "기타 양주"),
    "양주": ("양주",),
}

#: 기본 시드의 최상위 주종 순서. 레거시 롤업 병수 내림차순이다.
#: 사용자가 순서를 바꾸면 `category.sort_order` 가 정답이 된다.
DEFAULT_ROOT_CATEGORIES: tuple[str, ...] = ("맥주", "와인", "양주", "전통주", "사케")

#: 매핑되지 않은 값을 담는 최상위 주종. 사용자가 UI 에서 옮길 수 있다.
UNCLASSIFIED_ROOT = "미분류"


@dataclass(frozen=True, slots=True)
class CategoryResolution:
    """`종류` 문자열의 매핑 결과."""

    raw: str
    path: tuple[str, ...]
    matched: bool

    @property
    def leaf(self) -> str:
        return self.path[-1]

    @property
    def root(self) -> str:
        return self.path[0]

    @property
    def depth(self) -> int:
        return len(self.path)


def resolve_category(raw: str | None) -> CategoryResolution | None:
    """`종류` 값을 기본 시드 계층의 경로로 바꾼다.

    사전에 없는 값은 버리지 않고 `미분류` 아래에 그대로 둔다. 임포트가 데이터를
    조용히 잃는 것보다, 사용자가 나중에 옮길 수 있게 보존하는 것이 낫다.
    """
    if raw is None:
        return None
    text = raw.strip()
    if not text:
        return None
    path = DEFAULT_CATEGORY_PATHS.get(text)
    if path is not None:
        return CategoryResolution(raw=text, path=path, matched=True)
    return CategoryResolution(raw=text, path=(UNCLASSIFIED_ROOT, text), matched=False)


def forward_fill_categories(values: list[str | None]) -> list[str | None]:
    """그룹 구분자로 쓰인 `종류` 값을 아래로 전파한다.

    첫 행부터 값이 있어야 전파가 완결된다. 값이 없는 선행 행은 None 으로 남고,
    상위 계층이 경고로 보고한다.
    """
    filled: list[str | None] = []
    current: str | None = None
    for value in values:
        if value is not None and value.strip():
            current = value.strip()
        filled.append(current)
    return filled


def default_seed_paths() -> list[tuple[str, ...]]:
    """최초 시드로 넣을 계층 경로 전체.

    중간 노드도 포함하고 부모가 자식보다 먼저 오도록 정렬한다. 시드 적용은 upsert 여야
    한다. 사용자가 이름을 바꾸거나 삭제한 항목을 시드가 되살리면 사용자의 편집을
    무시하는 셈이 된다.
    """
    paths: set[tuple[str, ...]] = set()
    for path in DEFAULT_CATEGORY_PATHS.values():
        for depth in range(1, len(path) + 1):
            paths.add(path[:depth])
    paths.add((UNCLASSIFIED_ROOT,))
    root_order = {name: index for index, name in enumerate(DEFAULT_ROOT_CATEGORIES)}
    return sorted(paths, key=lambda path: (len(path), root_order.get(path[0], 99), path))
