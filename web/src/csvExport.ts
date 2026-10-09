import type { Product } from "@/api/types";
/**
 * CSV 내보내기. 엑셀에서 한글이 깨지지 않게 UTF-8 BOM 을 붙이고, 쉼표·따옴표·줄바꿈이 든
 * 칸은 따옴표로 감싼다. 수식으로 해석될 수 있는 칸(=, +, -, @ 로 시작)은 앞에 '를 붙여
 * 스프레드시트가 실행하지 않게 한다(CSV 수식 주입 방지).
 */

export type CsvCell = string | number | null | undefined;

function escapeCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: CsvCell[][]): string {
  return [header, ...rows].map((row) => row.map(escapeCell).join(",")).join("\r\n");
}

/** 브라우저에서 파일로 내려받는다. */
export function downloadCsv(filename: string, header: string[], rows: CsvCell[][]): void {
  const blob = new Blob(["﻿", toCsv(header, rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** 화면에서 선택한 구매 모집단과 전체 재고 원가를 열 이름으로 구분한다. */
export function productCsvData(products: Product[]): { header: string[]; rows: CsvCell[][] } {
  const scoped = products.some((product) => product.filtered_prices != null);
  return {
    header: [
      "이름",
      "주종",
      "빈티지",
      "도수(%)",
      "전체 재고(병)",
      "전체 구매(병)",
      ...(scoped ? ["조건 내 재고(병)", "조건 구매(병)"] : []),
      scoped ? "조건 평균 정가" : "평단가",
      scoped ? "조건 평균 실구매가" : "실평단가",
      "전체 재고 원가",
      scoped ? "조건 100ml당(정가)" : "100ml당(정가)",
      "내 평점",
    ],
    rows: products.map((product) => {
      const prices = product.filtered_prices ?? product.metrics;
      return [
        product.name,
        product.category_path.join(" > "),
        product.vintage,
        product.abv,
        product.metrics.in_stock_count,
        product.metrics.purchased_count,
        ...(scoped
          ? [product.filtered_stock_count ?? product.metrics.in_stock_count, prices.purchased_count]
          : []),
        prices.avg_list_price,
        prices.avg_paid_price,
        product.metrics.inventory_value_at_cost,
        prices.price_per_100ml,
        product.personal_rating,
      ];
    }),
  };
}
