import { describe, expect, it } from "vitest";
import { daysSince, openedShelfLife } from "@/domain/openedShelfLife";

describe("openedShelfLife", () => {
  it("주종 이름으로 권장 기간을 고르고 증류주는 알리지 않는다", () => {
    expect(openedShelfLife(["와인", "레드와인"])?.days).toBe(7);
    expect(openedShelfLife(["전통주", "막걸리"])?.days).toBe(3);
    expect(openedShelfLife(["양주", "위스키"])).toBeNull();
    expect(openedShelfLife([])).toBeNull();
  });

  it("개봉일부터 지난 날을 센다", () => {
    expect(daysSince("2026-10-01", "2026-10-05")).toBe(4);
    expect(daysSince("2026-10-06", "2026-10-05")).toBe(0);
  });
});
