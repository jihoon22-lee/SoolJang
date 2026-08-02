import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import type { CategoryNode, ProblemDetail } from "@/api/types";
import { ProductForm } from "@/components/ProductForm";

afterEach(() => {
  window.localStorage.clear();
});

const categories: CategoryNode[] = [
  {
    id: "single-malt",
    parent_id: null,
    name: "싱글몰트 위스키",
    depth: 3,
    path: ["양주", "위스키", "싱글몰트 위스키"],
    is_seeded: true,
    sort_order: 0,
    product_count: 0,
    descendant_product_count: 0,
  },
];

function setup(overrides: Partial<Parameters<typeof ProductForm>[0]> = {}) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(
    <ProductForm
      categories={categories}
      submitting={false}
      error={null}
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onSubmit, onCancel };
}

describe("ProductForm", () => {
  it("제품과 구매 정보를 한 폼에서 입력한다", () => {
    // 4계층 구조는 정확성을 위해 필요하지만 매번 세 화면을 거치면 기록을 안 하게 된다.
    setup();

    expect(screen.getByLabelText("이름 *")).toBeInTheDocument();
    expect(screen.getByLabelText("용량 (ml)")).toBeInTheDocument();
    expect(screen.getByLabelText("병수")).toBeInTheDocument();
    expect(screen.getByLabelText("병당 실구매가 (원)")).toBeInTheDocument();
  });

  it("구매 정보가 선택임을 안내한다", () => {
    setup();

    expect(screen.getByText(/구매 정보 \(선택\)/)).toBeInTheDocument();
  });

  it("이름만으로 제출할 수 있다", async () => {
    const { onSubmit } = setup();

    await userEvent.type(screen.getByLabelText("이름 *"), "가상 위스키");
    await userEvent.click(screen.getByRole("button", { name: "등록" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: "가상 위스키" }));
  });

  it("공백만 입력하면 제출을 막고 이유를 알린다", async () => {
    // 빈 문자열은 required 속성이 막는다. 공백만 넣은 경우는 브라우저 검증을 통과하므로
    // 애플리케이션이 직접 걸러야 한다.
    const { onSubmit } = setup();

    await userEvent.type(screen.getByLabelText("이름 *"), "   ");
    await userEvent.click(screen.getByRole("button", { name: "등록" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("이름을 입력하세요");
  });

  it("병수를 넣었는데 용량이 없으면 막는다", async () => {
    // 용량이 없으면 규격을 만들 수 없어 구매 건을 붙일 대상이 없다.
    const { onSubmit } = setup();

    await userEvent.type(screen.getByLabelText("이름 *"), "가상 위스키");
    await userEvent.type(screen.getByLabelText("병수"), "2");
    await userEvent.click(screen.getByRole("button", { name: "등록" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("용량이 필요합니다");
  });

  it("주종을 계층 경로로 고를 수 있다", async () => {
    const { onSubmit } = setup();

    await userEvent.type(screen.getByLabelText("이름 *"), "가상 위스키");
    await userEvent.selectOptions(screen.getByLabelText("주종"), "single-malt");
    await userEvent.click(screen.getByRole("button", { name: "등록" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ categoryId: "single-malt" }));
  });

  it("평점 상한을 6으로 제한한다", () => {
    setup();

    expect(screen.getByLabelText("내 평점 (0.5~6)")).toHaveAttribute("max", "6");
  });

  it("서버 필드 오류를 해당 입력에 표시한다", () => {
    const problem: ProblemDetail = {
      type: "https://sooljang.local/errors/validation",
      title: "요청 값이 올바르지 않습니다",
      status: 422,
      detail: "입력값을 확인하세요",
      instance: "/api/v1/products",
      errors: [{ field: "personal_rating", code: "less_than_equal", message: "6 이하여야 합니다" }],
    };
    setup({ error: new ApiError(422, "입력값을 확인하세요", problem) });

    expect(screen.getByRole("alert")).toHaveTextContent("입력값을 확인하세요");
    expect(screen.getByText("6 이하여야 합니다")).toBeInTheDocument();
  });

  it("저장 중에는 버튼을 막는다", () => {
    setup({ submitting: true });

    expect(screen.getByRole("button", { name: "저장 중…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "취소" })).toBeDisabled();
  });

  it("취소를 알린다", async () => {
    const { onCancel } = setup();

    await userEvent.click(screen.getByRole("button", { name: "취소" }));

    expect(onCancel).toHaveBeenCalled();
  });

  it("구매일은 오늘로 미리 채워진다", () => {
    setup();

    const today = new Date().toISOString().slice(0, 10);
    expect(screen.getByLabelText("구매일")).toHaveValue(today);
  });

  it("구매처는 직전에 쓴 값으로 미리 채워진다", () => {
    window.localStorage.setItem("sooljang:last-vendor-name", "이마트");

    setup();

    expect(screen.getByLabelText("구매처")).toHaveValue("이마트");
  });

  it("이름 자동완성 후보를 순위대로 보여준다", async () => {
    setup({
      existingProducts: [
        { id: "p1", name: "글렌알라키 12년" },
        { id: "p2", name: "글렌고인 15년" },
        { id: "p3", name: "발베니 12년" },
      ],
    });

    await userEvent.type(screen.getByLabelText("이름 *"), "글렌");

    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["글렌고인 15년", "글렌알라키 12년"]);
  });

  it("정확히 일치하는 이름이 있으면 중복 등록을 경고한다", async () => {
    const onSelectExisting = vi.fn();
    setup({
      existingProducts: [{ id: "p1", name: "글렌알라키 12년" }],
      onSelectExisting,
    });

    await userEvent.type(screen.getByLabelText("이름 *"), "글렌알라키 12년");
    expect(await screen.findByText(/이미 등록된 술입니다/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "구매 이력 추가하시겠어요?" }));
    expect(onSelectExisting).toHaveBeenCalledWith("p1");
  });

  it("부분 일치나 다른 이름은 중복으로 경고하지 않는다", async () => {
    setup({ existingProducts: [{ id: "p1", name: "글렌알라키 12년" }] });

    await userEvent.type(screen.getByLabelText("이름 *"), "글렌알라키");
    expect(screen.queryByText(/이미 등록된 술입니다/)).not.toBeInTheDocument();
  });

  it("수정 모드에서는 중복 경고를 하지 않는다", async () => {
    setup({
      mode: "edit",
      initialValues: { name: "글렌알라키 12년" },
      existingProducts: [{ id: "p1", name: "글렌알라키 12년" }],
    });

    expect(screen.queryByText(/이미 등록된 술입니다/)).not.toBeInTheDocument();
  });

  it("구매처 자동완성 후보를 보여준다", async () => {
    setup({ vendorNames: ["이마트", "이마트 트레이더스", "코스트코"] });

    await userEvent.type(screen.getByLabelText("구매처"), "이마트");

    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["이마트", "이마트 트레이더스"]);
  });

  it("모든 입력에 라벨이 연결되어 있다", () => {
    setup();

    for (const input of screen.getAllByRole("textbox")) {
      expect(input).toHaveAccessibleName();
    }
    for (const input of screen.getAllByRole("spinbutton")) {
      expect(input).toHaveAccessibleName();
    }
    for (const select of screen.getAllByRole("combobox")) {
      expect(select).toHaveAccessibleName();
    }
  });
});
