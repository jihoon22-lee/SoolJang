import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DonutChart } from "@/components/charts/DonutChart";

describe("DonutChart", () => {
  it("전체 합이 0이면 안내 문구를 보여준다", () => {
    render(
      <DonutChart
        title="병 상태"
        data={[
          { label: "미개봉", value: 0 },
          { label: "개봉", value: 0 },
        ]}
      />,
    );

    expect(screen.getByText("데이터가 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("범례와 표 대체 텍스트에 각 항목·값을 보여준다", () => {
    render(
      <DonutChart
        title="병 상태"
        data={[
          { label: "미개봉", value: 3 },
          { label: "개봉", value: 1 },
          { label: "소진", value: 0 },
        ]}
      />,
    );

    expect(screen.getByRole("img", { name: "병 상태" })).toBeInTheDocument();
    // 범례엔 값이 0인 항목도 나온다(전체를 구성하는 항목이라는 걸 알 수 있어야 한다).
    expect(document.querySelector(".donut-chart-legend")).toHaveTextContent("소진");
    const table = screen.getByRole("table");
    expect(table).toHaveTextContent("미개봉");
    expect(table).toHaveTextContent("3");
  });

  it("값이 0인 조각은 원 자체는 그리지 않는다", () => {
    const { container } = render(
      <DonutChart
        title="병 상태"
        data={[
          { label: "미개봉", value: 3 },
          { label: "소진", value: 0 },
        ]}
      />,
    );

    // 배경 원 1개 + 값이 있는 조각(미개봉) 1개 = 2개. "소진" 은 0이라 원을 그리지 않는다.
    expect(container.querySelectorAll("circle")).toHaveLength(2);
  });
});
