import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { TastingFields, type TastingFieldValues } from "@/components/TastingFields";

const EMPTY: TastingFieldValues = {
  tastedOn: "2026-10-05",
  rating: "",
  pouredMl: "",
  nose: "",
  palate: "",
  finish: "",
  place: "",
  companions: "",
};

function Harness({ remainingMl }: { remainingMl?: number | null }) {
  const [values, setValues] = useState(EMPTY);
  return (
    <>
      <TastingFields
        values={values}
        onChange={(patch) => setValues((prev) => ({ ...prev, ...patch }))}
        remainingMl={remainingMl}
      />
      <output data-testid="poured">{values.pouredMl}</output>
    </>
  );
}

describe("TastingFields", () => {
  it("남은 양을 알면 한 번에 다 마신 양을 고를 수 있고 소진된다고 알린다", async () => {
    render(<Harness remainingMl={500} />);

    await userEvent.click(screen.getByRole("button", { name: "남은 양 전부(500ml)" }));

    expect(screen.getByTestId("poured")).toHaveTextContent("500");
    expect(screen.getByText(/다 마신 것으로\(소진\) 기록합니다/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "150ml" })).toBeEnabled();
  });

  it("남은 양보다 많은 프리셋은 막고, 남은 양을 모르면 전부 버튼이 없다", () => {
    const { unmount } = render(<Harness remainingMl={40} />);
    expect(screen.getByRole("button", { name: "50ml" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "남은 양 전부(40ml)" })).toBeInTheDocument();
    unmount();

    render(<Harness remainingMl={null} />);
    expect(screen.queryByRole("button", { name: /남은 양 전부/ })).not.toBeInTheDocument();
  });
});
