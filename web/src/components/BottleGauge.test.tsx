import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BottleGauge, bottleFill } from "@/components/BottleGauge";

describe("병 잔량 게이지", () => {
  it("잔량을 모르면 빈 병이 아니라 미기록으로 구분한다", () => {
    expect(bottleFill("open", null, 700)).toEqual({ kind: "unknown" });
    // 용량을 모르거나 0이면 비율을 낼 수 없다.
    expect(bottleFill("open", 300, null)).toEqual({ kind: "unknown" });
    expect(bottleFill("open", 300, 0)).toEqual({ kind: "unknown" });
  });

  it("미개봉은 가득, 다 따른 개봉 병은 비어 있고 넘친 기록은 가득으로 맞춘다", () => {
    expect(bottleFill("unopened", null, null)).toEqual({ kind: "known", ratio: 1 });
    expect(bottleFill("open", 0, 700)).toEqual({ kind: "known", ratio: 0 });
    expect(bottleFill("open", 350, 700)).toEqual({ kind: "known", ratio: 0.5 });
    expect(bottleFill("open", 900, 700)).toEqual({ kind: "known", ratio: 1 });
  });

  it("그림은 보조 기술에 숨기고 미기록은 채움 없이 빗금 상태로 그린다", () => {
    const { container, rerender } = render(
      <BottleGauge status="open" remainingMl={175} volumeMl={700} />,
    );
    const gauge = container.querySelector(".bottle-gauge");
    expect(gauge).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".bottle-gauge-fill")).toHaveStyle({ height: "25%" });

    rerender(<BottleGauge status="open" remainingMl={null} volumeMl={700} />);
    expect(container.querySelector(".bottle-gauge")).toHaveClass("bottle-gauge--unknown");
    expect(container.querySelector(".bottle-gauge-fill")).toBeNull();
  });
});
