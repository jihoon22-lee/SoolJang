import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CategoryNode, ProductFilters, Vendor } from "@/api/types";
import { ProductFilterPanel } from "@/components/ProductFilterPanel";

afterEach(() => {
  window.localStorage.clear();
});

const categories: CategoryNode[] = [
  {
    id: "c1",
    parent_id: null,
    name: "위스키",
    depth: 1,
    path: ["위스키"],
    is_seeded: true,
    sort_order: 0,
    product_count: 1,
    descendant_product_count: 1,
  },
];

const vendors: Vendor[] = [
  {
    id: "v1",
    name: "이마트",
    kind: "mart",
    url: null,
    note: null,
    purchase_count: 1,
    total_spend: "10000.00",
  },
];

function renderPanel(overrides: Partial<{ filters: ProductFilters }> = {}) {
  return render(
    <ProductFilterPanel
      filters={overrides.filters ?? { sort: "name", order: "asc" }}
      categories={categories}
      vendors={vendors}
      onChange={vi.fn()}
      onReset={vi.fn()}
      expanded={true}
      onExpandedChange={vi.fn()}
      stockFirst={true}
      onStockFirstChange={vi.fn()}
    />,
  );
}

describe("ProductFilterPanel", () => {
  it("기본 순서로는 상시 필드 7개가 바로 보이고, 나머지는 '더 많은 필터' 안에 있다", () => {
    renderPanel();

    // 상시 표시: 이름 검색·주종·도수·내 평점·재고·정렬·재고 우선순위 체크박스.
    expect(screen.getByLabelText("이름 검색")).toBeInTheDocument();
    expect(screen.getByLabelText("주종")).toBeInTheDocument();

    const details = screen.getByText("더 많은 필터").closest("details") as HTMLElement;
    expect(within(details).getByLabelText("국가")).toBeInTheDocument();
    expect(within(details).getByLabelText("구매처")).toBeInTheDocument();
    // "국가" 는 접힌 쪽에만 있고, 상시 표시 쪽에는 없어야 한다(중복 렌더 방지 확인).
    expect(screen.getAllByLabelText("국가")).toHaveLength(1);
  });

  it("'필터 순서 편집' 을 누르면 필드 입력 대신 순서 목록이 나타난다", async () => {
    renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "필터 순서 편집" }));

    expect(screen.queryByLabelText("이름 검색")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "국가 위로 이동" })).toBeInTheDocument();
  });

  it("맨 위 항목은 위로 이동이, 맨 아래 항목은 아래로 이동이 비활성화된다", async () => {
    renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "필터 순서 편집" }));

    expect(screen.getByRole("button", { name: "이름 검색 위로 이동" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "구매일 아래로 이동" })).toBeDisabled();
  });

  it("항목을 경계 너머로 올리면 '더 많은 필터' 에서 상시 표시로 넘어온다", async () => {
    renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "필터 순서 편집" }));
    // "국가" 는 기본 순서에서 상시 표시 바로 다음(8번째, 접힌 영역의 첫 항목)이다 —
    // 한 번만 위로 옮기면 경계를 넘어 상시 표시로 승격된다.
    await userEvent.click(screen.getByRole("button", { name: "국가 위로 이동" }));
    await userEvent.click(screen.getByRole("button", { name: "완료" }));

    expect(screen.getByLabelText("국가")).toBeInTheDocument();
    const details = screen.getByText("더 많은 필터").closest("details") as HTMLElement;
    expect(within(details).queryByLabelText("국가")).toBeNull();
    // 자리를 내준 "재고 있는 술 먼저" 는 반대로 접힌 쪽으로 밀려난다.
    expect(
      within(details).getByRole("checkbox", { name: /재고 있는 술 먼저/ }),
    ).toBeInTheDocument();
  });

  it("'기본 순서로' 를 누르면 바뀐 순서가 초기화된다", async () => {
    renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "필터 순서 편집" }));
    await userEvent.click(screen.getByRole("button", { name: "국가 위로 이동" }));
    await userEvent.click(screen.getByRole("button", { name: "기본 순서로" }));
    await userEvent.click(screen.getByRole("button", { name: "완료" }));

    const details = screen.getByText("더 많은 필터").closest("details") as HTMLElement;
    expect(within(details).getByLabelText("국가")).toBeInTheDocument();
  });

  it("순서 변경은 localStorage 에 저장되어 재마운트해도 유지된다", async () => {
    const { unmount } = renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "필터 순서 편집" }));
    await userEvent.click(screen.getByRole("button", { name: "국가 위로 이동" }));
    await userEvent.click(screen.getByRole("button", { name: "완료" }));
    unmount();

    renderPanel();

    expect(screen.getByLabelText("국가")).toBeInTheDocument();
  });
});
