"""레거시 임포트 라우터.

`:analyze` 로 먼저 보고 `:commit` 으로 넣는다. 두 단계가 **같은 계획**을 쓰므로 미리 본 것과
다른 결과가 나오지 않는다.
"""

from typing import Annotated

from fastapi import APIRouter, File, UploadFile, status

from sooljang.api.deps import SessionDep, UserDep
from sooljang.api.errors import ValidationFailedError
from sooljang.api.schemas.legacy_import import (
    ImportAnalysis,
    ImportBlockInfo,
    ImportCommitResult,
    ImportReview,
    ImportSampleRow,
    ImportTotals,
)
from sooljang.application.import_plan import ImportPlan, build_plan, summarize_warnings
from sooljang.application.legacy_import import apply_plan
from sooljang.infrastructure.legacy.blocks import LEGACY_ENCODING, LegacySheetError
from sooljang.infrastructure.legacy.records import parse_sheet

router = APIRouter(prefix="/imports/legacy", tags=["imports"])

#: 업로드 크기 상한. 실측 파일이 142KB 라 넉넉한 값이다.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024


async def _plan_from_upload(file: UploadFile) -> ImportPlan:
    """업로드 파일을 계획으로 바꾼다. 인코딩·구조 오류를 사용자에게 알린다."""
    raw = await file.read()
    if len(raw) == 0:
        raise ValidationFailedError("빈 파일입니다")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ValidationFailedError(
            f"파일이 너무 큽니다 ({len(raw):,} bytes). 상한은 {MAX_UPLOAD_BYTES:,} bytes 입니다"
        )

    try:
        report = parse_sheet(raw)
    except UnicodeDecodeError as error:
        raise ValidationFailedError(
            f"파일을 {LEGACY_ENCODING} 로 읽을 수 없습니다. 엑셀에서 CSV 로 저장한 파일인지 "
            "확인하세요"
        ) from error
    except LegacySheetError as error:
        raise ValidationFailedError(str(error)) from error

    return build_plan(report)


def _to_analysis(
    plan: ImportPlan, *, skipped: list[int], totals_lines: list[int], excluded: int
) -> ImportAnalysis:
    return ImportAnalysis(
        block=ImportBlockInfo(
            record_count=plan.source_row_count,
            skipped_blank_lines=skipped,
            total_row_lines=totals_lines,
            excluded_line_count=excluded,
        ),
        totals=ImportTotals(
            products=plan.product_count,
            source_rows=plan.source_row_count,
            skus=plan.sku_count,
            purchases=plan.purchase_count,
            bottles=plan.bottle_count,
            vendors=len(plan.vendor_names),
            categories=len(plan.category_paths),
            varieties=len(plan.variety_names),
            list_amount=plan.total_list_amount,
            paid_amount=plan.total_paid_amount,
            volume_ml=plan.total_volume_ml,
        ),
        review=ImportReview(
            merge_group_count=len(plan.merge_groups),
            merge_examples=[lines for lines in list(plan.merge_groups.values())[:10]],
            split_vendor_rows=plan.split_vendor_rows,
            unsplit_vendor_rows=plan.unsplit_vendor_rows,
            warning_summary=summarize_warnings(plan),
        ),
        sample=[
            ImportSampleRow(
                line_number=product.line_number,
                name=product.name,
                vintage=product.vintage,
                volume_ml=product.volume_ml,
                abv=product.abv,
                category_path=list(product.category_path),
                varieties=list(product.variety_names),
                unit_list_price=product.purchases[0].unit_list_price if product.purchases else None,
                unit_paid_price=product.purchases[0].unit_paid_price if product.purchases else None,
                quantity=product.total_quantity,
                vendors=[
                    purchase.vendor_name for purchase in product.purchases if purchase.vendor_name
                ],
            )
            for product in plan.products[:5]
        ],
    )


@router.post(
    ":analyze",
    response_model=ImportAnalysis,
    summary="레거시 시트 분석 (dry-run)",
)
async def analyze(
    file: Annotated[UploadFile, File(description="CP949 로 저장된 CSV")],
) -> ImportAnalysis:
    """업로드한 시트를 분석해 적재될 내용을 미리 보여준다. **DB 를 건드리지 않는다.**

    단일 시트에 통계 블록이 섞여 있으므로, 어떤 행을 통과했고 어떤 행을 배제했는지 함께
    보고한다. 사용자가 블록 분리가 제대로 됐는지 확인할 수 있어야 한다.
    """
    raw = await file.read()
    await file.seek(0)
    plan = await _plan_from_upload(file)

    # 블록 정보는 파싱 리포트에 있다. 계획을 다시 만들지 않고 한 번 더 파싱해 꺼낸다.
    report = parse_sheet(raw)
    block = report.block
    return _to_analysis(
        plan,
        skipped=list(block.skipped_blank_lines) if block else [],
        totals_lines=list(block.total_row_lines) if block else [],
        excluded=len(block.excluded_lines) if block else 0,
    )


@router.post(
    ":commit",
    response_model=ImportCommitResult,
    status_code=status.HTTP_201_CREATED,
    summary="레거시 시트 적재",
)
async def commit(
    session: SessionDep,
    user_id: UserDep,
    file: Annotated[UploadFile, File(description="CP949 로 저장된 CSV")],
) -> ImportCommitResult:
    """분석한 내용을 실제로 적재한다.

    재실행해도 중복이 생기지 않는다. 이미 적재된 구매 건은 `purchases_skipped` 로 보고한다.
    한 행이 실패해도 나머지는 적재하고 실패 행을 리포트에 남긴다. 한 행의 문제로 전체를
    되돌리면 429행 중 428행이 정상인데도 아무것도 얻지 못한다.
    """
    plan = await _plan_from_upload(file)
    result = await apply_plan(session, user_id=user_id, plan=plan)
    return ImportCommitResult(
        products_created=result.products_created,
        products_reused=result.products_reused,
        skus_created=result.skus_created,
        purchases_created=result.purchases_created,
        purchases_skipped=result.purchases_skipped,
        bottles_created=result.bottles_created,
        categories_created=result.categories_created,
        vendors_created=result.vendors_created,
        varieties_created=result.varieties_created,
        failed_rows=result.failed_rows,
    )
