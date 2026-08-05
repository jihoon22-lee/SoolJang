import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BarChart } from "@/components/charts/BarChart";

describe("BarChart", () => {
  it("데이터가 없으면 안내 문구를 보여준다", () => {
    render(<BarChart title="주종별 병수" data={[]} />);

    expect(screen.getByText("데이터가 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("role=img 접근성 이름과 표 대체 텍스트를 함께 제공한다", () => {
    render(
      <BarChart
        title="주종별 병수"
        data={[
          { label: "위스키", value: 75 },
          { label: "와인", value: 110 },
        ]}
      />,
    );

    expect(screen.getByRole("img", { name: "주종별 병수" })).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(table).toHaveTextContent("위스키");
    expect(table).toHaveTextContent("75");
    expect(table).toHaveTextContent("와인");
    expect(table).toHaveTextContent("110");
  });

  it("가장 큰 값이 막대 폭 100%을 채운다", () => {
    const { container } = render(
      <BarChart
        title="주종별 병수"
        data={[
          { label: "위스키", value: 25 },
          { label: "와인", value: 100 },
        ]}
      />,
    );

    const rects = container.querySelectorAll("rect");
    expect(rects[0]).toHaveAttribute("width", "25");
    expect(rects[1]).toHaveAttribute("width", "100");
  });

  it("onSelect 가 있으면 라벨이 버튼이 되어 클릭을 전달한다", async () => {
    const onSelect = vi.fn();
    render(<BarChart title="주종별 병수" data={[{ label: "위스키", value: 75, onSelect }]} />);

    await userEvent.click(screen.getByRole("button", { name: "위스키" }));

    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("formatValue 로 값 표시를 바꿀 수 있다", () => {
    render(
      <BarChart
        title="주종별 총액"
        data={[{ label: "위스키", value: 12345 }]}
        formatValue={(value) => `${value.toLocaleString("ko-KR")}원`}
      />,
    );

    expect(screen.getAllByText("12,345원")).toHaveLength(2);
  });
});
