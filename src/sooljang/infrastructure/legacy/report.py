"""레거시 시트 파싱 결과를 요약 출력한다.

Task 6 의 데모 경로이며, Task 11(임포터) 의 dry-run 미리보기가 같은 리포트를 재사용한다.

    uv run python -m sooljang.infrastructure.legacy.report /mnt/e/alcohol.csv
    uv run python -m sooljang.infrastructure.legacy.report /mnt/e/alcohol.csv --warnings
"""

import argparse
import sys
from pathlib import Path

from sooljang.infrastructure.legacy.blocks import LegacySheetError
from sooljang.infrastructure.legacy.records import ParseReport, parse_sheet


def _format_summary(report: ParseReport) -> list[str]:
    block = report.block
    assert block is not None

    lines = [
        "본 테이블 분리 결과",
        f"  레코드            {report.record_count:,}건",
        f"  통과한 빈 행      {len(block.skipped_blank_lines)}개 {block.skipped_blank_lines or ''}",
        f"  배제한 합계행     {len(block.total_row_lines)}개 {block.total_row_lines or ''}",
        f"  배제한 행         {len(block.excluded_lines)}개 (통계 블록 등)",
        "",
        "집계",
        f"  구매 / 소비 / 재고   {report.total_purchased:,} / "
        f"{report.total_consumed:,} / {report.total_in_stock:,}병",
        f"  미개봉 / 개봉        {report.total_unopened:,} / {report.total_opened:,}병",
        f"  정가 총액            {report.total_list_amount:,.0f}원",
        f"  실구매 총액          {report.total_paid_amount:,.0f}원",
        f"  총 용량              {report.total_volume_ml:,}ml",
        f"  고유 구매처          {len(report.unique_vendors)}곳",
        "",
        "확인이 필요한 항목",
        f"  구매처 여러 곳       {len(report.multi_vendor_records)}행 (구매 건 분할 후보)",
        f"  주종 사전 미등록     {len(report.unmatched_categories)}종 "
        f"{sorted(report.unmatched_categories) or ''}",
        f"  경고                 {len(report.warnings)}건",
    ]
    return lines


def _format_samples(report: ParseReport, count: int) -> list[str]:
    lines = ["", f"정규화 샘플 (앞 {count}건)"]
    for record in report.records[:count]:
        varieties = ", ".join(item.name for item in record.varieties) or "-"
        category = " > ".join(record.category.path) if record.category else "-"
        ratings = (
            ", ".join(
                f"{rating.value}{f'({rating.source_code})' if rating.source_code else ''}"
                for rating in record.external_ratings
            )
            or "-"
        )
        lines.extend(
            [
                f"  [{record.line_number}행] {record.name}",
                f"    주종     {category}",
                f"    빈티지   {record.vintage or '-'}   용량 {record.volume_ml or '-'}ml"
                f"   도수 {record.abv or '-'}%",
                f"    품종     {varieties}",
                f"    총액     정가 {record.list_total or '-'} / 실구매 {record.paid_total or '-'}",
                f"    병당가   정가 {record.unit_list_price or '-'} / "
                f"실구매 {record.unit_paid_price or '-'}",
                f"    병수     구매 {record.purchased_count} 소비 {record.consumed_count} "
                f"재고 {record.in_stock_count}"
                f" (미개봉 {record.unopened_count} 개봉 {record.opened_count})",
                f"    구매처   {', '.join(record.vendors) or '-'}",
                f"    평점     내 {record.personal_rating or '-'} / 외부 {ratings}",
            ]
        )
        if record.foreign_price is not None:
            lines.append(
                f"    외화     {record.foreign_price.currency} {record.foreign_price.amount}"
                f" (환율 {record.foreign_price.fx_rate})"
            )
        if record.warnings:
            lines.extend(f"    경고     {warning}" for warning in record.warnings)
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="레거시 시트 파싱 결과를 요약 출력한다")
    parser.add_argument("path", type=Path, help="CP949 로 저장된 CSV 경로")
    parser.add_argument("--samples", type=int, default=3, help="출력할 정규화 샘플 수")
    parser.add_argument("--warnings", action="store_true", help="경고 전체를 출력한다")
    args = parser.parse_args(argv)

    try:
        report = parse_sheet(args.path)
    except LegacySheetError as error:
        print(f"시트를 해석할 수 없습니다: {error}", file=sys.stderr)
        return 1
    except (OSError, UnicodeDecodeError) as error:
        print(f"파일을 읽을 수 없습니다: {error}", file=sys.stderr)
        return 1

    output = _format_summary(report)
    if args.samples > 0:
        output.extend(_format_samples(report, args.samples))
    if args.warnings and report.warnings:
        output.extend(["", "경고 전체"])
        output.extend(f"  {warning}" for warning in report.warnings)

    print("\n".join(output))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
