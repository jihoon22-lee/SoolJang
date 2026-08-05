import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LineChart } from "@/components/charts/LineChart";

describe("LineChart", () => {
  it("데이터가 없으면 안내 문구를 보여준다", () => {
    render(<LineChart title="월별 구매 병수" data={[]} />);

    expect(screen.getByText("데이터가 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("점이 적으면 x축 라벨을 전부 보여준다", () => {
    render(
      <LineChart
        title="월별 구매 병수"
        data={[
          { label: "2026-01", value: 3 },
          { label: "2026-02", value: 5 },
        ]}
      />,
    );

    expect(screen.getByRole("img", { name: "월별 구매 병수" })).toBeInTheDocument();
    const labels = document.querySelector(".line-chart-labels") as HTMLElement;
    expect(within(labels).getByText("2026-01")).not.toHaveClass("sr-only");
    expect(within(labels).getByText("2026-02")).not.toHaveClass("sr-only");
  });

  it("점이 13개를 넘으면 한 칸씩 걸러 라벨을 숨긴다(화면에서만 — 표엔 그대로 남는다)", () => {
    const data = Array.from({ length: 13 }, (_, i) => ({
      label: `2026-${String(i + 1).padStart(2, "0")}`,
      value: i,
    }));

    render(<LineChart title="월별 구매 병수" data={data} />);

    const labels = document.querySelector(".line-chart-labels") as HTMLElement;
    // 첫 라벨(짝수 인덱스 0)은 보이고, 두 번째 라벨(홀수 인덱스 1)은 화면에서 숨겨진다.
    expect(within(labels).getByText("2026-01")).not.toHaveClass("sr-only");
    expect(within(labels).getByText("2026-02")).toHaveClass("sr-only");
    // 숨겨진 라벨도 표 대체 텍스트엔 그대로 남아 정보 손실이 없다.
    const table = screen.getByRole("table");
    expect(table).toHaveTextContent("2026-02");
  });
});
