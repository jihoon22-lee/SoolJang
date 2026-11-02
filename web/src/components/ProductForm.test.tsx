import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import type { CategoryNode, ProblemDetail } from "@/api/types";
import { ProductForm } from "@/components/ProductForm";
import { todayLocal } from "@/format";
import { hasDirtyForms } from "@/sync/update";

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

/** 접힌 "더 입력" 영역. */
function moreSection(): HTMLDetailsElement {
  return screen
    .getByText("더 입력", { exact: false, selector: "summary" })
    .closest("details") as HTMLDetailsElement;
}

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

  it("병수가 정수가 아니면 막는다", async () => {
    // 실사용 중 발견된 결함: 병수에 "2.5" 를 입력하면 낙관적으로 만드는 병 id 개수(2개)
    // 와 서버에 보내는 quantity(2.5)가 어긋나 오프라인 동기화 큐가 영구히 막혔다.
    const { onSubmit } = setup();

    await userEvent.type(screen.getByLabelText("이름 *"), "가상 위스키");
    await userEvent.type(screen.getByLabelText("용량 (ml)"), "700");
    await userEvent.type(screen.getByLabelText("병수"), "2.5");
    await userEvent.click(screen.getByRole("button", { name: "등록" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("병수는 1 이상의 정수를 입력하세요");
  });

  it("용량이 정수가 아니면 막는다", async () => {
    const { onSubmit } = setup();

    await userEvent.type(screen.getByLabelText("이름 *"), "가상 위스키");
    await userEvent.type(screen.getByLabelText("용량 (ml)"), "700.5");
    await userEvent.click(screen.getByRole("button", { name: "등록" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("용량(ml)은 1 이상의 정수를 입력하세요");
  });

  it("병수·용량이 정수면 정상 제출된다", async () => {
    const { onSubmit } = setup();

    await userEvent.type(screen.getByLabelText("이름 *"), "가상 위스키");
    await userEvent.type(screen.getByLabelText("용량 (ml)"), "700");
    await userEvent.type(screen.getByLabelText("병수"), "2");
    await userEvent.click(screen.getByRole("button", { name: "등록" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: "2", volumeMl: "700" }),
    );
  });

  it("주종을 계층 경로로 고를 수 있다", async () => {
    const { onSubmit } = setup();

    await userEvent.type(screen.getByLabelText("이름 *"), "가상 위스키");
    await userEvent.selectOptions(screen.getByLabelText("주종"), "single-malt");
    await userEvent.click(screen.getByRole("button", { name: "등록" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ categoryId: "single-malt" }));
  });

  it("새 술 폼은 이름·주종·용량·도수와 구매 칸을 먼저 보이고 나머지는 '더 입력'에 접는다", () => {
    setup();

    const more = moreSection();
    expect(more).not.toHaveAttribute("open");
    for (const label of ["이름 *", "주종", "용량 (ml)", "도수 (%)", "병수", "구매일", "구매처"])
      expect(more).not.toContainElement(screen.getByLabelText(label));
    for (const label of ["빈티지", "숙성 연수", "생산자", "원어명", "메모"])
      expect(more).toContainElement(screen.getByLabelText(label));
    expect(within(more).getByRole("group", { name: /내 평점/ })).toBeInTheDocument();
  });

  it("내 평점은 0점 없이 별로 고르고 작성 중으로 표시한다", async () => {
    const { onSubmit } = setup();
    await userEvent.type(screen.getByLabelText("이름 *"), "가상 위스키");
    await userEvent.click(within(moreSection()).getByText("더 입력", { exact: false }));
    const rating = screen.getByRole("group", { name: /내 평점/ });

    // 제품 평점은 0.5~6이라 0점이 없다. 미평가는 "평점 없음"이다(D268).
    expect(within(rating).queryByRole("button", { name: "0점" })).not.toBeInTheDocument();
    expect(hasDirtyForms()).toBe(false);
    await userEvent.click(within(rating).getByRole("button", { name: "5점" }));
    await userEvent.click(within(rating).getByRole("button", { name: "5점" }));
    expect(hasDirtyForms()).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "등록" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ personalRating: "4.5" }));
  });

  it("수정 모드는 접지 않고 기존 평점을 건드리지 않으면 그대로 보낸다", async () => {
    const { onSubmit } = setup({
      mode: "edit",
      initialValues: { name: "가상 위스키", personalRating: "4.3" },
    });

    expect(screen.queryByText("더 입력", { exact: false })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: /내 평점 \(4\.3 \/ 6\)/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ personalRating: "4.3" }));
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
    // 오류가 난 칸이 접혀 있으면 보이지 않으므로 펼친다.
    expect(moreSection()).toHaveAttribute("open");
    expect(screen.getByRole("group", { name: /내 평점/ })).toHaveAccessibleDescription(
      "6 이하여야 합니다",
    );
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

    const today = todayLocal();
    expect(screen.getByLabelText("구매일")).toHaveValue(today);
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
    expect(await screen.findByText(/이미 등록한 술입니다/)).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", {
        name: /글렌알라키 12년.*판본 정보 미기록.*이 술에 구매 추가/,
      }),
    );
    // 그 술의 구매 추가 폼을 연 상세로 간다(D268).
    expect(onSelectExisting).toHaveBeenCalledWith("p1", {
      addPurchase: true,
      purchaseHandoff: expect.objectContaining({ volumeMl: "", matchingSkus: 0 }),
    });
  });

  it("이 술에 구매 추가는 적은 구매 칸과 새 술 초안을 넘기고 용량이 맞는 규격 하나만 고른다", async () => {
    const onSelectExisting = vi.fn();
    setup({
      existingProducts: [
        {
          id: "p1",
          name: "글렌알라키 12년",
          skus: [
            { id: "s7", volume_ml: 700 },
            { id: "s5", volume_ml: 500 },
          ],
        } as never,
      ],
      onSelectExisting,
    });

    await userEvent.type(screen.getByLabelText("이름 *"), "글렌알라키 12년");
    await userEvent.type(screen.getByLabelText("용량 (ml)"), "700");
    await userEvent.type(screen.getByLabelText("병수"), "2");
    await userEvent.type(screen.getByLabelText("병당 실구매가 (원)"), "50000");
    await userEvent.click(
      await screen.findByRole("button", { name: /글렌알라키 12년.*이 술에 구매 추가/ }),
    );

    // 구매 칸은 그 술의 구매 추가 폼이 이어 쓰고, 새 술 초안은 구매를 저장한 뒤 정리한다(D273).
    expect(onSelectExisting).toHaveBeenCalledWith("p1", {
      skuId: "s7",
      addPurchase: true,
      purchaseHandoff: expect.objectContaining({
        quantity: "2",
        unitPaidPrice: "50000",
        unitListPrice: "",
        purchasedOn: todayLocal(),
        volumeMl: "700",
        matchingSkus: 1,
        draft: expect.objectContaining({ entries: expect.any(Array) }),
      }),
    });
  });

  it("부분 일치나 다른 이름은 중복으로 경고하지 않는다", async () => {
    setup({ existingProducts: [{ id: "p1", name: "글렌알라키 12년" }] });

    await userEvent.type(screen.getByLabelText("이름 *"), "글렌알라키");
    expect(screen.queryByText(/이미 등록한 술입니다/)).not.toBeInTheDocument();
  });

  it("수정 모드에서는 중복 경고를 하지 않는다", async () => {
    setup({
      mode: "edit",
      initialValues: { name: "글렌알라키 12년" },
      existingProducts: [{ id: "p1", name: "글렌알라키 12년" }],
    });

    expect(screen.queryByText(/이미 등록한 술입니다/)).not.toBeInTheDocument();
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

it("동일 이름의 빈티지·도수 후보를 구분하고 입력 용량과 일치한 SKU만 전달한다", async () => {
  const onSelectExisting = vi.fn();
  setup({
    initialValues: { name: "합성 판본", volumeMl: "750", vintage: "2022", abv: "43" },
    existingProducts: [
      {
        id: "edition20",
        name: "합성 판본",
        vintage: 2020,
        abv: "40",
        age_years: null,
        skus: [
          { id: "sku20", volume_ml: 750, barcode: null, barcode_type: null, package_note: null },
        ],
      },
      {
        id: "edition21",
        name: "합성 판본",
        vintage: 2021,
        abv: "46",
        age_years: "12",
        skus: [
          { id: "sku21", volume_ml: 750, barcode: null, barcode_type: null, package_note: null },
        ],
      },
    ],
    onSelectExisting,
  });
  const candidates = screen.getByRole("list", { name: "기존 제품 후보" });
  expect(
    within(candidates).getByRole("button", { name: /2020 빈티지.*40%.*750ml/ }),
  ).toBeInTheDocument();
  const next = within(candidates).getByRole("button", {
    name: /2021 빈티지.*12년 숙성.*46%.*750ml/,
  });
  expect(screen.getByRole("button", { name: "등록" })).toBeEnabled();
  await userEvent.click(next);
  expect(onSelectExisting).toHaveBeenCalledWith("edition21", {
    skuId: "sku21",
    addPurchase: true,
    purchaseHandoff: expect.objectContaining({ volumeMl: "750", matchingSkus: 1 }),
  });
  // 미리 채운 빈티지가 접힌 칸에 숨지 않게 펼쳐 둔다.
  expect(moreSection()).toHaveAttribute("open");
  expect(screen.getByLabelText("빈티지")).toHaveValue(2022);
});

it("확인한 검색 별칭을 입력하고 20개를 초과한 입력은 저장 전에 알린다", async () => {
  const { onSubmit } = setup();
  await userEvent.type(screen.getByLabelText("이름 *"), "GlenAllachie 12");
  await userEvent.click(within(moreSection()).getByText("더 입력", { exact: false }));
  await userEvent.type(screen.getByLabelText("원어명"), "The GlenAllachie");
  await userEvent.type(
    screen.getByLabelText(/^검색 별칭/),
    Array.from({ length: 21 }, (_, i) => `별칭${i}`).join(","),
  );
  // 접어 둔 채 제출해도 오류 칸을 펼쳐 초점을 옮긴다.
  await userEvent.click(within(moreSection()).getByText("더 입력", { exact: false }));
  expect(moreSection()).not.toHaveAttribute("open");
  await userEvent.click(screen.getByRole("button", { name: "등록" }));
  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("최대 20개");
  expect(moreSection()).toHaveAttribute("open");
  expect(screen.getByLabelText(/^검색 별칭/)).toHaveFocus();
  await userEvent.clear(screen.getByLabelText(/^검색 별칭/));
  await userEvent.type(screen.getByLabelText(/^검색 별칭/), "글렌알라키,내 셰리");
  await userEvent.click(screen.getByRole("button", { name: "등록" }));
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ nameEn: "The GlenAllachie", searchAliases: "글렌알라키,내 셰리" }),
  );
});

it("수정 초안은 URL 해시가 아니라 제품 id로 저장해 상세 안 이동 뒤에도 같은 키로 정리된다", async () => {
  const { activateDatabase, lockDatabase } = await import("@/sync/db");
  const { clearFormDraft } = await import("@/sync/drafts");
  await activateDatabase("form-owner");
  window.location.hash = "#products/p1?tasting=t1";
  setup({ mode: "edit", draftKey: "product:edit:p1", initialValues: { name: "원래 이름" } });

  await userEvent.type(screen.getByLabelText("이름 *"), " 수정");
  window.location.hash = "#products/p1?bottle=b1";

  const keys = Object.keys(window.localStorage);
  expect(keys.some((key) => key.endsWith(":product:edit:p1"))).toBe(true);
  expect(keys.some((key) => key.includes("#products"))).toBe(false);
  clearFormDraft("product:edit:p1");
  expect(Object.keys(window.localStorage).some((key) => key.includes("product:edit"))).toBe(false);
  lockDatabase();
  window.location.hash = "";
});

it("저장 중에는 제품 정보와 구매 입력을 바꾸지 못한다", async () => {
  setup({ submitting: true, initialValues: { name: "저장 중인 제품", note: "제출한 메모" } });
  for (const label of ["이름 *", "메모", "용량 (ml)", "병수"])
    expect(screen.getByLabelText(label)).toBeDisabled();
  await userEvent.type(screen.getByLabelText("메모"), " 추가 입력");
  expect(screen.getByLabelText("메모")).toHaveValue("제출한 메모");
});
