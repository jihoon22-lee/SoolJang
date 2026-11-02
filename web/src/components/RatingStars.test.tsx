import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { RatingStars } from "@/components/RatingStars";
import { renderWithQuery } from "@/testing";

function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <RatingStars value={value} onChange={setValue} />
      <output data-testid="value">{value}</output>
    </>
  );
}

describe("RatingStars", () => {
  it("별을 누르면 그 점수, 같은 별을 다시 누르면 반 점 내린다", async () => {
    renderWithQuery(<Harness />);

    await userEvent.click(screen.getByRole("button", { name: "4점" }));
    expect(screen.getByTestId("value")).toHaveTextContent("4.0");
    await userEvent.click(screen.getByRole("button", { name: "4점" }));
    expect(screen.getByTestId("value")).toHaveTextContent("3.5");
    expect(screen.getByRole("button", { name: "4점" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "5점" })).toHaveAttribute("aria-pressed", "false");
  });

  it("별 여섯 개를 먼저 한 묶음으로 두고 0점과 평점 없음은 그 뒤에 둔다", () => {
    renderWithQuery(<Harness />);

    // 좁은 정정 폼(360px)에서도 별 줄이 끊기지 않게 보조 선택을 뒤 묶음으로 뺀다. 초점 순서도 같다.
    expect(
      screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label") ?? button.textContent),
    ).toEqual(["1점", "2점", "3점", "4점", "5점", "6점", "0점", "평점 없음"]);
  });

  it("평점 없음으로 지운다", async () => {
    renderWithQuery(<Harness initial="5.0" />);

    expect(screen.getByText("(5 / 6)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "평점 없음" }));
    expect(screen.getByText("(없음)")).toBeInTheDocument();
  });
});
