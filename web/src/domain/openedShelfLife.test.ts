import { describe, expect, it } from "vitest";
import { daysSince, openedShelfLife } from "@/domain/openedShelfLife";

describe("openedShelfLife", () => {
  it("주종 이름으로 권장 기간을 고르고 증류주는 알리지 않는다", () => {
    expect(openedShelfLife(["와인", "레드와인"])?.days).toBe(7);
    expect(openedShelfLife(["전통주", "막걸리"])?.days).toBe(3);
    expect(openedShelfLife(["양주", "위스키"])).toBeNull();
    expect(openedShelfLife([])).toBeNull();
  });

  it("이름에 '와인'이 든 주정강화 와인은 일반 와인보다 긴 기간을 쓴다", () => {
    // 기본 주종 트리의 실제 이름들이다. 와인 규칙(7일)에 먼저 걸리면 셰리를 일주일 만에 경고한다.
    for (const name of ["주정강화와인", "셰리와인", "마데이라와인"]) {
      expect(openedShelfLife(["와인", name])?.days).toBe(90);
    }
    expect(openedShelfLife(["와인", "레드와인"])?.days).toBe(7);
  });

  it("개봉일부터 지난 날을 센다", () => {
    expect(daysSince("2026-10-01", "2026-10-05")).toBe(4);
    expect(daysSince("2026-10-06", "2026-10-05")).toBe(0);
  });
});
