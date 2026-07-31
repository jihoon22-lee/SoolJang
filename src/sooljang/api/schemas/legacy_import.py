"""레거시 임포트 API 스키마."""

from decimal import Decimal

from pydantic import BaseModel, Field


class ImportBlockInfo(BaseModel):
    """블록 분리 결과. 통계 블록이 제외되었는지 사용자가 확인할 수 있어야 한다."""

    record_count: int
    skipped_blank_lines: list[int] = Field(
        default_factory=list, description="데이터 중간의 빈 행. 종료로 오인하지 않고 통과한 위치"
    )
    total_row_lines: list[int] = Field(default_factory=list, description="배제한 합계행 위치")
    excluded_line_count: int = Field(default=0, description="통계 블록 등 배제한 행 수")


class ImportTotals(BaseModel):
    """적재될 총계. 엑셀 합계행과 대조하는 근거다."""

    products: int
    source_rows: int
    skus: int
    purchases: int
    bottles: int
    vendors: int
    categories: int
    varieties: int
    list_amount: Decimal
    paid_amount: Decimal
    volume_ml: int


class ImportReview(BaseModel):
    """사용자가 확인해야 하는 항목."""

    merge_group_count: int = Field(
        default=0, description="같은 제품으로 판정되어 합쳐질 행 묶음 수"
    )
    merge_examples: list[list[int]] = Field(
        default_factory=list, description="합쳐질 행 번호 예시 (최대 10건)"
    )
    split_vendor_rows: list[int] = Field(
        default_factory=list, description="구매처를 여러 건으로 나눈 행"
    )
    unsplit_vendor_rows: list[int] = Field(
        default_factory=list,
        description="구매처가 여러 곳이었으나 병수를 나눌 수 없어 단일 구매 건으로 적재할 행. "
        "나중에 구매 건 분할로 쪼갤 수 있다",
    )
    warning_summary: list[tuple[str, int]] = Field(
        default_factory=list, description="경고를 종류별로 묶은 개수"
    )


class ImportAnalysis(BaseModel):
    """dry-run 미리보기 응답.

    실제 적재 전에 무엇이 생기고 무엇이 문제인지 먼저 보여준다. 미리보기 없이 넣으면 잘못된
    매핑을 되돌리기 어렵다.
    """

    block: ImportBlockInfo
    totals: ImportTotals
    review: ImportReview
    sample: list[ImportSampleRow] = Field(
        default_factory=list, description="정규화 결과 표본 (최대 5건)"
    )


class ImportSampleRow(BaseModel):
    """정규화 결과 표본 한 건."""

    line_number: int
    name: str
    vintage: int | None
    volume_ml: int | None
    abv: Decimal | None
    category_path: list[str]
    varieties: list[str]
    unit_list_price: Decimal | None
    unit_paid_price: Decimal | None
    quantity: int
    vendors: list[str]


class ImportCommitResult(BaseModel):
    """실제 적재 결과. dry-run 예상과 같은 항목을 센다."""

    products_created: int
    products_reused: int
    skus_created: int
    purchases_created: int
    purchases_skipped: int = Field(
        default=0, description="이미 적재된 구매 건. 재실행 시 중복을 만들지 않는다"
    )
    bottles_created: int
    categories_created: int
    vendors_created: int
    varieties_created: int
    failed_rows: list[tuple[int, str]] = Field(default_factory=list)


ImportAnalysis.model_rebuild()
