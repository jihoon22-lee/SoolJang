import { describe, expect, it } from "vitest";
import {
  formatAbv,
  formatBottleStatus,
  formatCategoryPath,
  formatDate,
  formatDays,
  formatMoney,
  formatPercent,
  formatRating,
  formatValueForMoney,
  formatVendorKind,
  formatVolume,
  MAX_RATING,
  NO_PRICE_LABEL,
  NO_PRICE_SHORT,
} from "@/format";

describe("formatMoney", () => {
  it("금액에 천 단위 구분과 원 단위를 붙인다", () => {
    expect(formatMoney("150000.00")).toBe("150,000원");
    expect(formatMoney("3197.33")).toBe("3,197원");
  });

  it("null 은 0원이 아니라 가격 정보 없음으로 표시한다", () => {
    // 무료로 받은 술과 가격을 기록하지 않은 술을 구분해야 한다.
    expect(formatMoney(null)).toBe(NO_PRICE_LABEL);
    expect(formatMoney(null)).not.toContain("0원");
  });

  it("좁은 열에서는 짧은 표기를 쓴다", () => {
    expect(formatMoney(null, { short: true })).toBe(NO_PRICE_SHORT);
  });

  it("0원은 실제 0으로 표시한다", () => {
    // 0원은 "무료로 받았다" 는 정보다. 없음과 달라야 한다.
    expect(formatMoney("0")).toBe("0원");
  });

  it("숫자로 해석할 수 없으면 없음으로 처리한다", () => {
    expect(formatMoney("알 수 없음")).toBe(NO_PRICE_LABEL);
    expect(formatMoney("")).toBe(NO_PRICE_LABEL);
  });
});

describe("formatVolume", () => {
  it("ml 과 L 을 상황에 맞게 쓴다", () => {
    expect(formatVolume(750)).toBe("750ml");
    expect(formatVolume(1000)).toBe("1L");
    expect(formatVolume(1500)).toBe("1,500ml");
  });

  it("없으면 대시로 표시한다", () => {
    expect(formatVolume(null)).toBe("—");
  });
});

describe("formatAbv", () => {
  it("불필요한 0을 제거한다", () => {
    expect(formatAbv("46.00")).toBe("46%");
    expect(formatAbv("14.50")).toBe("14.5%");
  });

  it("없으면 대시로 표시한다", () => {
    expect(formatAbv(null)).toBe("—");
    expect(formatAbv("")).toBe("—");
  });
});

describe("formatRating", () => {
  it("6점 만점을 함께 보여준다", () => {
    // 레거시 실측이 0.5 단위 6점 만점이었다. 5점으로 오해하면 값이 낮아 보인다.
    expect(MAX_RATING).toBe(6);
    expect(formatRating("4.5")).toBe("4.5 / 6");
    expect(formatRating("6.0")).toBe("6 / 6");
  });

  it("없으면 대시로 표시한다", () => {
    expect(formatRating(null)).toBe("—");
  });
});

describe("formatPercent", () => {
  it("비율을 백분율로 바꾼다", () => {
    expect(formatPercent("0.2000")).toBe("20%");
    expect(formatPercent("0.1425")).toBe("14.3%");
  });

  it("없으면 대시로 표시한다", () => {
    expect(formatPercent(null)).toBe("—");
  });
});

describe("formatDate", () => {
  it("구매일이 없으면 미기록임을 알린다", () => {
    // 레거시에 구매일 컬럼이 없어 임포트한 기록은 날짜를 모른다.
    expect(formatDate(null)).toBe("날짜 미기록");
    expect(formatDate("2026-03-01")).toBe("2026-03-01");
  });
});

describe("formatDays", () => {
  it("반올림해 일 단위로 보여준다", () => {
    expect(formatDays("9.40")).toBe("9일");
    expect(formatDays("9.60")).toBe("10일");
  });

  it("없으면 대시로 표시한다", () => {
    expect(formatDays(null)).toBe("—");
  });
});

describe("formatValueForMoney", () => {
  it("소수 둘째 자리까지 보여준다", () => {
    expect(formatValueForMoney("0.4250")).toBe("0.43");
    expect(formatValueForMoney("1")).toBe("1");
  });

  it("없으면 대시로 표시한다", () => {
    expect(formatValueForMoney(null)).toBe("—");
  });
});

describe("formatCategoryPath", () => {
  it("계층을 구분자로 이어 붙인다", () => {
    expect(formatCategoryPath(["양주", "위스키", "싱글몰트 위스키"])).toBe(
      "양주 › 위스키 › 싱글몰트 위스키",
    );
  });

  it("비어 있으면 미분류로 표시한다", () => {
    expect(formatCategoryPath([])).toBe("미분류");
  });
});

describe("라벨 변환", () => {
  it("병 상태를 한글로 표시한다", () => {
    expect(formatBottleStatus("unopened")).toBe("미개봉");
    expect(formatBottleStatus("finished")).toBe("소진");
    expect(formatBottleStatus("gifted")).toBe("증여");
  });

  it("알 수 없는 상태는 원문을 유지한다", () => {
    expect(formatBottleStatus("mystery")).toBe("mystery");
  });

  it("구매처 종류를 한글로 표시한다", () => {
    expect(formatVendorKind("duty_free")).toBe("면세점");
    expect(formatVendorKind("bottle_shop")).toBe("주류샵");
  });
});
