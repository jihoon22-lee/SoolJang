"""레거시 엑셀 시트 파싱.

단일 시트에 술 정리 테이블과 통계 테이블이 섞여 있는 구조를 다룬다. 사양과 실측 근거는
`docs/legacy-schema.md` 에 있다.

    from sooljang.infrastructure.legacy import parse_sheet

    report = parse_sheet(Path("alcohol.csv"))
    print(report.record_count, report.total_purchased)
"""

from sooljang.infrastructure.legacy.blocks import (
    MAIN_HEADER,
    BlockSplitResult,
    ClassifiedRow,
    LegacySheetError,
    RowKind,
    load_main_block,
    read_rows,
    split_main_block,
)
from sooljang.infrastructure.legacy.categories import (
    DEFAULT_CATEGORY_PATHS,
    DEFAULT_ROOT_CATEGORIES,
    MAX_CATEGORY_DEPTH,
    UNCLASSIFIED_ROOT,
    CategoryResolution,
    default_seed_paths,
    forward_fill_categories,
    resolve_category,
)
from sooljang.infrastructure.legacy.normalize import (
    ExternalRatingValue,
    ForeignPrice,
    extract_vintage,
    normalize_name_for_matching,
    parse_abv,
    parse_external_ratings,
    parse_foreign_price,
    parse_money,
    parse_rating,
    parse_volume_ml,
)
from sooljang.infrastructure.legacy.records import (
    LegacyRecord,
    ParseReport,
    build_records,
    parse_rows,
    parse_sheet,
)
from sooljang.infrastructure.legacy.varieties import (
    CANONICAL_VARIETIES,
    VarietyResolution,
    normalize_varieties,
)

__all__ = [
    "CANONICAL_VARIETIES",
    "DEFAULT_CATEGORY_PATHS",
    "DEFAULT_ROOT_CATEGORIES",
    "MAIN_HEADER",
    "MAX_CATEGORY_DEPTH",
    "UNCLASSIFIED_ROOT",
    "BlockSplitResult",
    "CategoryResolution",
    "ClassifiedRow",
    "ExternalRatingValue",
    "ForeignPrice",
    "LegacyRecord",
    "LegacySheetError",
    "ParseReport",
    "RowKind",
    "VarietyResolution",
    "build_records",
    "default_seed_paths",
    "extract_vintage",
    "forward_fill_categories",
    "load_main_block",
    "normalize_name_for_matching",
    "normalize_varieties",
    "parse_abv",
    "parse_external_ratings",
    "parse_foreign_price",
    "parse_money",
    "parse_rating",
    "parse_rows",
    "parse_sheet",
    "parse_volume_ml",
    "read_rows",
    "resolve_category",
    "split_main_block",
]
