import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AutocompleteInput } from "@/components/AutocompleteInput";

function Harness({
  suggestions,
  onSelect,
}: {
  suggestions: string[];
  onSelect?: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <AutocompleteInput
      id="test-input"
      value={value}
      onChange={setValue}
      suggestions={suggestions.filter((s) => s.includes(value))}
      onSelect={onSelect}
    />
  );
}

describe("AutocompleteInput", () => {
  it("입력하면 후보 목록을 보여준다", async () => {
    render(<Harness suggestions={["글렌고인", "글렌알라키", "발베니"]} />);

    await userEvent.type(screen.getByRole("combobox"), "글렌");

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("일치하는 후보가 없으면 목록을 보여주지 않는다", async () => {
    render(<Harness suggestions={["글렌고인"]} />);

    await userEvent.type(screen.getByRole("combobox"), "없음");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("↓ 로 후보를 옮기고 aria-activedescendant 를 갱신한다", async () => {
    render(<Harness suggestions={["글렌고인", "글렌알라키"]} />);
    const input = screen.getByRole("combobox");

    await userEvent.type(input, "글렌");
    await userEvent.keyboard("{ArrowDown}");

    expect(input).toHaveAttribute("aria-activedescendant", "test-input-option-0");
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", "test-input-option-1");
  });

  it("↑ 는 첫 항목에서 마지막 항목으로 순환한다", async () => {
    render(<Harness suggestions={["글렌고인", "글렌알라키"]} />);
    const input = screen.getByRole("combobox");

    await userEvent.type(input, "글렌");
    await userEvent.keyboard("{ArrowUp}");

    expect(input).toHaveAttribute("aria-activedescendant", "test-input-option-1");
  });

  it("Enter 로 강조된 후보를 선택한다", async () => {
    const onSelect = vi.fn();
    render(<Harness suggestions={["글렌고인", "글렌알라키"]} onSelect={onSelect} />);
    const input = screen.getByRole("combobox");

    await userEvent.type(input, "글렌");
    await userEvent.keyboard("{ArrowDown}{Enter}");

    expect(onSelect).toHaveBeenCalledWith("글렌고인");
    expect(input).toHaveValue("글렌고인");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Esc 로 목록을 닫는다", async () => {
    render(<Harness suggestions={["글렌고인"]} />);
    const input = screen.getByRole("combobox");

    await userEvent.type(input, "글렌");
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("후보를 클릭하면 선택된다", async () => {
    const onSelect = vi.fn();
    render(<Harness suggestions={["글렌고인", "글렌알라키"]} onSelect={onSelect} />);

    await userEvent.type(screen.getByRole("combobox"), "글렌");
    await userEvent.click(screen.getByRole("option", { name: "글렌알라키" }));

    expect(onSelect).toHaveBeenCalledWith("글렌알라키");
    expect(screen.getByRole("combobox")).toHaveValue("글렌알라키");
  });

  it("aria-expanded 는 목록이 펼쳐진 상태를 그대로 반영한다", async () => {
    render(<Harness suggestions={["글렌고인"]} />);
    const input = screen.getByRole("combobox");

    expect(input).toHaveAttribute("aria-expanded", "false");
    await userEvent.type(input, "글렌");
    expect(input).toHaveAttribute("aria-expanded", "true");
  });
});
