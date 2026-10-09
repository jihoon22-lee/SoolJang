import { describe, expect, it, vi } from "vitest";
import { downloadCsv, toCsv } from "@/csvExport";

describe("toCsv", () => {
  it("쉼표·따옴표·줄바꿈을 감싸고 수식처럼 보이는 칸은 실행되지 않게 한다", () => {
    const csv = toCsv(
      ["이름", "메모"],
      [
        ['샤토 "가상", 2019', "첫 줄\n둘째 줄"],
        ['=HYPERLINK("x")', null],
        [-3, 42],
      ],
    );

    expect(csv.split("\r\n")).toEqual([
      "이름,메모",
      '"샤토 ""가상"", 2019","첫 줄\n둘째 줄"',
      '"\'=HYPERLINK(""x"")",',
      "-3,42",
    ]);
  });
});

describe("downloadCsv", () => {
  it("UTF-8 BOM 을 붙인 파일로 내려받는다", async () => {
    const created: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      created.push(blob as Blob);
      return "blob:test";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    downloadCsv("술장.csv", ["이름"], [["위스키"]]);

    expect(click).toHaveBeenCalledOnce();
    const buffer = await new Promise<ArrayBuffer>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(created[0] as Blob);
    });
    const bytes = new Uint8Array(buffer);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    vi.restoreAllMocks();
  });
});

it("조건 구매 가격과 전체 재고 원가는 다른 열로 내보낸다", async () => {
  const { productCsvData } = await import("@/csvExport");
  const product: import("@/api/types").Product = {
    id: "p",
    name_en: null,
    category_id: null,
    producer_id: null,
    producer_name: null,
    country: null,
    region: null,
    age_years: null,
    note: null,
    varieties: [],
    skus: [],
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    name: "제품 A",
    category_path: [],
    vintage: null,
    abv: null,
    personal_rating: null,
    metrics: {
      consumed_count: 1,
      unopened_count: 1,
      opened_count: 0,
      gifted_count: 0,
      sold_count: 0,
      price_per_100ml_paid: "2666.67",
      list_total: "30000.00",
      paid_total: "30000.00",
      discount_rate: "0.0000",
      total_volume_ml: 1125,
      value_for_money: null,
      in_stock_count: 1,
      purchased_count: 2,
      avg_list_price: "15000.00",
      avg_paid_price: "15000.00",
      inventory_value_at_cost: "24000.00",
      price_per_100ml: "2666.67",
    },
    filtered_stock_count: 1,
    filtered_prices: {
      total_volume_ml: 750,
      list_total: "24000.00",
      paid_total: "24000.00",
      price_per_100ml_paid: "3200.00",
      discount_rate: "0.0000",
      purchased_count: 1,
      avg_list_price: "24000.00",
      avg_paid_price: "24000.00",
      price_per_100ml: "3200.00",
    },
  };
  const data = productCsvData([product]);
  const record = Object.fromEntries(
    data.header.map((header, index) => [header, data.rows[0]?.[index]]),
  );
  expect(record).toMatchObject({
    "전체 구매(병)": 2,
    "조건 구매(병)": 1,
    "조건 평균 실구매가": "24000.00",
    "전체 재고 원가": "24000.00",
    "조건 100ml당(정가)": "3200.00",
  });
});
