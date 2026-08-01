import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CategoryNode, CategoryTree } from "@/api/types";
import { CategoryManager } from "@/components/CategoryManager";

function node(overrides: Partial<CategoryNode> & { id: string; name: string }): CategoryNode {
  return {
    parent_id: null,
    depth: 1,
    path: [overrides.name],
    is_seeded: false,
    sort_order: 0,
    product_count: 0,
    descendant_product_count: 0,
    ...overrides,
  };
}

function tree(items: CategoryNode[]): CategoryTree {
  return {
    items,
    max_depth: Math.max(0, ...items.map((item) => item.depth)),
    depth_limit: 8,
  };
}

/**
 * 주종 이름은 트리와 각 select 의 option 에 여러 번 나타난다. 행을 찾을 때는 그 행에만
 * 존재하는 "상위 주종 변경" 라벨을 기준으로 삼는다.
 */
function rowOf(name: string): HTMLElement {
  const control = screen.getByLabelText(`${name} 상위 주종 변경`);
  return control.closest(".category-row") as HTMLElement;
}

const handlers = () => ({
  offline: false,
  onCreate: vi.fn(),
  onRename: vi.fn(),
  onReparent: vi.fn(),
  onMerge: vi.fn(),
  onDelete: vi.fn(),
  onResetSeed: vi.fn(),
});

describe("CategoryManager", () => {
  it("깊이 상한을 안내해 어디까지 세분화할 수 있는지 알려준다", () => {
    render(<CategoryManager tree={tree([])} busy={false} error={null} {...handlers()} />);

    expect(screen.getByText(/상한 8/)).toBeInTheDocument();
  });

  it("삭제해도 술이 지워지지 않음을 명시한다", () => {
    render(<CategoryManager tree={tree([])} busy={false} error={null} {...handlers()} />);

    expect(screen.getByText(/소속된 술은 지워지지 않습니다/)).toBeInTheDocument();
  });

  it("비어 있으면 복원이나 추가를 안내한다", () => {
    render(<CategoryManager tree={tree([])} busy={false} error={null} {...handlers()} />);

    expect(screen.getByRole("status")).toHaveTextContent("등록된 주종이 없습니다");
  });

  it("최상위와 하위 주종을 계층으로 렌더한다", () => {
    const items = [
      node({ id: "wine", name: "와인" }),
      node({
        id: "red",
        name: "레드와인",
        parent_id: "wine",
        depth: 2,
        path: ["와인", "레드와인"],
      }),
    ];

    render(<CategoryManager tree={tree(items)} busy={false} error={null} {...handlers()} />);

    expect(within(rowOf("와인")).getByText("와인")).toBeInTheDocument();
    expect(within(rowOf("레드와인")).getByText("레드와인")).toBeInTheDocument();
  });

  it("이름과 상위를 지정해 추가한다", async () => {
    const spies = handlers();
    const items = [node({ id: "wine", name: "와인" })];
    render(<CategoryManager tree={tree(items)} busy={false} error={null} {...spies} />);

    await userEvent.type(screen.getByLabelText("이름"), "로제와인");
    await userEvent.selectOptions(screen.getByLabelText("상위 주종"), "wine");
    await userEvent.click(screen.getByRole("button", { name: "추가" }));

    expect(spies.onCreate).toHaveBeenCalledWith("로제와인", "wine");
  });

  it("최상위로도 추가할 수 있다", async () => {
    const spies = handlers();
    render(<CategoryManager tree={tree([])} busy={false} error={null} {...spies} />);

    await userEvent.type(screen.getByLabelText("이름"), "새 최상위");
    await userEvent.click(screen.getByRole("button", { name: "추가" }));

    expect(spies.onCreate).toHaveBeenCalledWith("새 최상위", null);
  });

  it("이름을 변경한다", async () => {
    const spies = handlers();
    const items = [node({ id: "sake", name: "사케" })];
    render(<CategoryManager tree={tree(items)} busy={false} error={null} {...spies} />);

    await userEvent.click(screen.getByRole("button", { name: "이름 변경" }));
    const input = screen.getByLabelText("사케 새 이름");
    await userEvent.clear(input);
    await userEvent.type(input, "니혼슈");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(spies.onRename).toHaveBeenCalledWith("sake", "니혼슈");
  });

  it("상위 주종을 바꿔 서브트리를 이동한다", async () => {
    const spies = handlers();
    const items = [
      node({ id: "wine", name: "와인" }),
      node({ id: "other", name: "기타" }),
      node({
        id: "sweet",
        name: "스위트와인",
        parent_id: "wine",
        depth: 2,
        path: ["와인", "스위트와인"],
      }),
    ];
    render(<CategoryManager tree={tree(items)} busy={false} error={null} {...spies} />);

    await userEvent.selectOptions(screen.getByLabelText("스위트와인 상위 주종 변경"), "other");

    expect(spies.onReparent).toHaveBeenCalledWith("sweet", "other");
  });

  it("자기 자신과 후손은 이동 대상에서 제외한다", () => {
    // 순환이 생기면 서버가 거부하지만, 애초에 고를 수 없게 하는 것이 낫다.
    const items = [
      node({ id: "wine", name: "와인" }),
      node({
        id: "sweet",
        name: "스위트와인",
        parent_id: "wine",
        depth: 2,
        path: ["와인", "스위트와인"],
      }),
    ];

    render(<CategoryManager tree={tree(items)} busy={false} error={null} {...handlers()} />);

    const select = screen.getByLabelText("와인 상위 주종 변경");
    const options = within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).not.toContain("와인");
    expect(options).not.toContain("와인 › 스위트와인");
  });

  it("다른 주종으로 병합한다", async () => {
    const spies = handlers();
    const items = [node({ id: "dup", name: "중복" }), node({ id: "keep", name: "정식" })];
    render(<CategoryManager tree={tree(items)} busy={false} error={null} {...spies} />);

    await userEvent.selectOptions(screen.getByLabelText("중복 을 다른 주종으로 병합"), "keep");

    expect(spies.onMerge).toHaveBeenCalledWith("dup", "keep");
  });

  it("비어 있는 주종은 확인 후 바로 삭제한다", async () => {
    const spies = handlers();
    const items = [node({ id: "empty", name: "빈 주종" })];
    render(<CategoryManager tree={tree(items)} busy={false} error={null} {...spies} />);

    await userEvent.click(screen.getByRole("button", { name: "삭제" }));
    await userEvent.click(screen.getByRole("button", { name: "정말 삭제" }));

    expect(spies.onDelete).toHaveBeenCalledWith("empty", "reject");
  });

  it("하위가 있으면 상위로 올리는 선택지를 준다", async () => {
    const spies = handlers();
    const items = [
      node({ id: "parent", name: "부모" }),
      node({ id: "child", name: "자식", parent_id: "parent", depth: 2, path: ["부모", "자식"] }),
    ];
    render(<CategoryManager tree={tree(items)} busy={false} error={null} {...spies} />);

    const parentRow = rowOf("부모");
    await userEvent.click(within(parentRow).getByRole("button", { name: "삭제" }));
    await userEvent.click(
      within(parentRow).getByRole("button", { name: "하위를 상위로 올리고 삭제" }),
    );

    expect(spies.onDelete).toHaveBeenCalledWith("parent", "promote_children");
  });

  it("소속 제품이 있으면 옮길 주종을 고르게 한다", async () => {
    const spies = handlers();
    const items = [
      node({
        id: "withProducts",
        name: "제품 있음",
        product_count: 3,
        descendant_product_count: 3,
      }),
      node({ id: "target", name: "옮길 곳" }),
    ];
    render(<CategoryManager tree={tree(items)} busy={false} error={null} {...spies} />);

    const row = rowOf("제품 있음");
    await userEvent.click(within(row).getByRole("button", { name: "삭제" }));

    const moveButton = within(row).getByRole("button", { name: "옮기고 삭제" });
    // 옮길 곳을 고르기 전에는 삭제할 수 없다.
    expect(moveButton).toBeDisabled();

    await userEvent.selectOptions(
      within(row).getByLabelText("제품 있음 의 술을 옮길 주종"),
      "target",
    );
    await userEvent.click(moveButton);

    expect(spies.onDelete).toHaveBeenCalledWith("withProducts", "reassign", "target");
  });

  it("기본 주종 복원이 사용자 편집을 지우지 않음을 안내한다", async () => {
    const spies = handlers();
    render(<CategoryManager tree={tree([])} busy={false} error={null} {...spies} />);

    expect(screen.getByText(/이름을 바꾼 주종은 그대로 유지/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "기본 주종 복원" }));

    expect(spies.onResetSeed).toHaveBeenCalled();
  });

  it("제품 수를 배지로 보여준다", () => {
    const items = [node({ id: "c", name: "위스키", descendant_product_count: 12 })];

    render(<CategoryManager tree={tree(items)} busy={false} error={null} {...handlers()} />);

    expect(screen.getByText("12종")).toBeInTheDocument();
  });

  it("기본 시드 항목을 표시한다", () => {
    const items = [node({ id: "c", name: "맥주", is_seeded: true })];

    render(<CategoryManager tree={tree(items)} busy={false} error={null} {...handlers()} />);

    expect(screen.getByText("기본")).toBeInTheDocument();
  });

  it("처리 중에는 조작을 막는다", () => {
    const items = [node({ id: "c", name: "와인" })];

    render(<CategoryManager tree={tree(items)} busy error={null} {...handlers()} />);

    expect(screen.getByRole("button", { name: "이름 변경" })).toBeDisabled();
  });

  it("오프라인에서는 이동·병합·삭제·기본값 복원을 막고 이유를 안내한다", async () => {
    const items = [node({ id: "c", name: "와인" })];
    const spies = handlers();

    render(<CategoryManager tree={tree(items)} busy={false} error={null} {...spies} offline />);

    expect(screen.getByRole("button", { name: "기본 주종 복원" })).toBeDisabled();
    expect(screen.getByText(/오프라인에서는 사용할 수 없습니다/)).toBeInTheDocument();
    const row = rowOf("와인");
    expect(within(row).getByLabelText("와인 상위 주종 변경")).toBeDisabled();
    expect(within(row).getByLabelText("와인 을 다른 주종으로 병합")).toBeDisabled();
    expect(within(row).getByRole("button", { name: "삭제" })).toBeDisabled();
    // 추가·이름 변경은 outbox 를 타므로 오프라인에서도 계속 쓸 수 있어야 한다.
    await userEvent.type(screen.getByLabelText("이름"), "새 주종");
    expect(screen.getByRole("button", { name: "추가" })).not.toBeDisabled();
    expect(within(row).getByRole("button", { name: "이름 변경" })).not.toBeDisabled();
  });

  it("오류를 alert 로 알린다", () => {
    render(
      <CategoryManager
        tree={tree([])}
        busy={false}
        error={new Error("하위 카테고리 2개가 있습니다")}
        {...handlers()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("하위 카테고리 2개가 있습니다");
  });
});
