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

  it("평점 없음으로 지운다", async () => {
    renderWithQuery(<Harness initial="5.0" />);

    expect(screen.getByText("(5 / 6)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "평점 없음" }));
    expect(screen.getByText("(없음)")).toBeInTheDocument();
  });
});
