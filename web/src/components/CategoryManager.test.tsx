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

const IDLE = { isPending: false, isSuccess: false, variables: undefined, error: null };

/**
 * 주종 이름은 트리와 각 select 의 option 에 여러 번 나타난다(예: 최상위 주종은 자기 이름이
 * 그대로 다른 행의 이동 대상 option 텍스트로도 쓰인다). 행을 찾을 때는 그 행 자신의
 * 이름 버튼(`.category-name-button`)으로 범위를 좁힌다.
 */
function rowOf(name: string): HTMLElement {
  return screen
    .getByText(name, { selector: ".category-row .category-name-button" })
    .closest(".category-row") as HTMLElement;
}

/**
 * 행의 이름을 눌러 관리 액션(이름 변경/이동/병합/삭제)을 펼친다. 전역에 한 번에 한 행만
 * 펼쳐지므로(사용자 요청 — 모든 행에 버튼이 항상 나열되던 걸 정리했다), 액션 버튼을 다루는
 * 테스트는 먼저 이 헬퍼로 대상 행을 펼친 뒤 진행한다.
 */
async function selectRow(name: string): Promise<HTMLElement> {
  const toggle = screen.getByRole("button", { name: `${name} 관리 펼치기` });
  await userEvent.click(toggle);
  return toggle.closest(".category-row") as HTMLElement;
}

const handlers = () => ({
  offline: false,
  createBusy: false,
  createError: null,
  resetSeedBusy: false,
  resetSeedError: null,
  renameStatus: IDLE,
  reparentStatus: IDLE,
  mergeStatus: IDLE,
  removeStatus: IDLE,
  onCreate: vi.fn(),
  onRename: vi.fn(),
  onReparent: vi.fn(),
  onMerge: vi.fn(),
  onDelete: vi.fn(),
  onResetSeed: vi.fn(),
});

describe("CategoryManager", () => {
  it("깊이 상한을 안내해 어디까지 세분화할 수 있는지 알려준다", () => {
    render(<CategoryManager tree={tree([])} {...handlers()} />);

    expect(screen.getByText(/상한 8/)).toBeInTheDocument();
  });

  it("삭제해도 술이 지워지지 않음을 명시한다", () => {
    render(<CategoryManager tree={tree([])} {...handlers()} />);

    expect(screen.getByText(/소속된 술은 지워지지 않습니다/)).toBeInTheDocument();
  });

  it("비어 있으면 복원이나 추가를 안내한다", () => {
    render(<CategoryManager tree={tree([])} {...handlers()} />);

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

    render(<CategoryManager tree={tree(items)} {...handlers()} />);

    expect(within(rowOf("와인")).getByText("와인")).toBeInTheDocument();
    expect(within(rowOf("레드와인")).getByText("레드와인")).toBeInTheDocument();
  });

  it("술이 많은 상위 주종이 위로 오도록 내림차순 정렬한다", () => {
    const items = [
      node({ id: "beer", name: "맥주", descendant_product_count: 5 }),
      node({ id: "whisky", name: "위스키", descendant_product_count: 40 }),
      node({ id: "wine", name: "와인", descendant_product_count: 20 }),
    ];

    const { container } = render(<CategoryManager tree={tree(items)} {...handlers()} />);

    const names = [...container.querySelectorAll(".category-row .category-name-button")].map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["위스키", "와인", "맥주"]);
  });

  it("하위 주종도 같은 규칙(제품 수 내림차순)으로 정렬한다", () => {
    const items = [
      node({ id: "wine", name: "와인" }),
      node({
        id: "sparkling",
        name: "스파클링",
        parent_id: "wine",
        depth: 2,
        path: ["와인", "스파클링"],
        descendant_product_count: 2,
      }),
      node({
        id: "red",
        name: "레드",
        parent_id: "wine",
        depth: 2,
        path: ["와인", "레드"],
        descendant_product_count: 15,
      }),
    ];

    const { container } = render(<CategoryManager tree={tree(items)} {...handlers()} />);

    const names = [...container.querySelectorAll(".category-row .category-name-button")].map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["와인", "레드", "스파클링"]);
  });

  it("하위가 있는 항목만 접기/펼치기 토글을 보여준다", () => {
    const items = [
      node({ id: "wine", name: "와인" }),
      node({
        id: "red",
        name: "레드와인",
        parent_id: "wine",
        depth: 2,
        path: ["와인", "레드와인"],
      }),
      node({ id: "beer", name: "맥주" }),
    ];

    render(<CategoryManager tree={tree(items)} {...handlers()} />);

    expect(within(rowOf("와인")).getByRole("button", { name: /하위 목록/ })).toBeInTheDocument();
    expect(
      within(rowOf("맥주")).queryByRole("button", { name: /하위 목록/ }),
    ).not.toBeInTheDocument();
  });

  it("접으면 하위 항목이 화면에서 사라지고 다시 펼치면 돌아온다", async () => {
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

    render(<CategoryManager tree={tree(items)} {...handlers()} />);

    const toggle = within(rowOf("와인")).getByRole("button", { name: "와인 하위 목록 접기" });
    await userEvent.click(toggle);

    expect(
      screen.queryByText("레드와인", { selector: ".category-row .category-name-button" }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "와인 하위 목록 펼치기" }));

    expect(
      screen.getByText("레드와인", { selector: ".category-row .category-name-button" }),
    ).toBeInTheDocument();
  });

  it("주종 추가 폼은 기본 접힘이고 버튼으로 펼치고 접을 수 있다", async () => {
    render(<CategoryManager tree={tree([])} {...handlers()} />);

    expect(screen.queryByLabelText("이름")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "+ 주종 추가" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(toggle);
    expect(screen.getByLabelText("이름")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "닫기" })).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByLabelText("이름")).not.toBeInTheDocument();
  });

  it("이름과 상위를 지정해 추가한다", async () => {
    const spies = handlers();
    const items = [node({ id: "wine", name: "와인" })];
    render(<CategoryManager tree={tree(items)} {...spies} />);

    await userEvent.click(screen.getByRole("button", { name: "+ 주종 추가" }));
    await userEvent.type(screen.getByLabelText("이름"), "로제와인");
    await userEvent.selectOptions(screen.getByLabelText("상위 주종"), "wine");
    await userEvent.click(screen.getByRole("button", { name: "추가" }));

    expect(spies.onCreate).toHaveBeenCalledWith("로제와인", "wine");
  });

  it("최상위로도 추가할 수 있다", async () => {
    const spies = handlers();
    render(<CategoryManager tree={tree([])} {...spies} />);

    await userEvent.click(screen.getByRole("button", { name: "+ 주종 추가" }));
    await userEvent.type(screen.getByLabelText("이름"), "새 최상위");
    await userEvent.click(screen.getByRole("button", { name: "추가" }));

    expect(spies.onCreate).toHaveBeenCalledWith("새 최상위", null);
  });

  it("이름을 변경한다", async () => {
    const spies = handlers();
    const items = [node({ id: "sake", name: "사케" })];
    render(<CategoryManager tree={tree(items)} {...spies} />);

    await selectRow("사케");
    await userEvent.click(screen.getByRole("button", { name: "이름 변경" }));
    const input = screen.getByLabelText("사케 새 이름");
    await userEvent.clear(input);
    await userEvent.type(input, "니혼슈");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(spies.onRename).toHaveBeenCalledWith("sake", "니혼슈");
  });

  it("이동은 대상 선택 후 확인을 눌러야 실행된다", async () => {
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
    render(<CategoryManager tree={tree(items)} {...spies} />);

    const row = await selectRow("스위트와인");
    await userEvent.click(within(row).getByRole("button", { name: "이동" }));
    expect(spies.onReparent).not.toHaveBeenCalled();

    await userEvent.selectOptions(
      within(row).getByLabelText("스위트와인 을 옮길 상위 주종"),
      "other",
    );
    await userEvent.click(within(row).getByRole("button", { name: "이동 확인" }));

    expect(spies.onReparent).toHaveBeenCalledWith("sweet", "other");
  });

  it("바꾸지 않고는 이동을 확인할 수 없다", async () => {
    const spies = handlers();
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
    render(<CategoryManager tree={tree(items)} {...spies} />);

    const row = await selectRow("스위트와인");
    await userEvent.click(within(row).getByRole("button", { name: "이동" }));

    expect(within(row).getByRole("button", { name: "이동 확인" })).toBeDisabled();
  });

  it("자기 자신과 후손은 이동 대상에서 제외한다", async () => {
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

    render(<CategoryManager tree={tree(items)} {...handlers()} />);

    const row = await selectRow("와인");
    await userEvent.click(within(row).getByRole("button", { name: "이동" }));
    const select = within(row).getByLabelText("와인 을 옮길 상위 주종");
    const options = within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).not.toContain("와인");
    expect(options).not.toContain("와인 › 스위트와인");
  });

  it("병합은 영향 범위를 보여준 뒤 확인해야 실행된다", async () => {
    const spies = handlers();
    const items = [
      node({ id: "dup", name: "중복", descendant_product_count: 4 }),
      node({ id: "keep", name: "정식" }),
    ];
    render(<CategoryManager tree={tree(items)} {...spies} />);

    const row = await selectRow("중복");
    await userEvent.click(within(row).getByRole("button", { name: "병합" }));
    expect(spies.onMerge).not.toHaveBeenCalled();
    expect(within(row).getByRole("button", { name: "병합 확인" })).toBeDisabled();

    await userEvent.selectOptions(within(row).getByLabelText("중복 을 합칠 주종"), "keep");

    expect(
      within(row).getByText(/중복\(제품 4종\)을 정식 로 합치고 삭제합니다/),
    ).toBeInTheDocument();

    await userEvent.click(within(row).getByRole("button", { name: "병합 확인" }));

    expect(spies.onMerge).toHaveBeenCalledWith("dup", "keep");
  });

  it("병합할 다른 주종이 없으면 병합 버튼을 비활성화한다", async () => {
    const items = [node({ id: "only", name: "유일" })];
    render(<CategoryManager tree={tree(items)} {...handlers()} />);

    const row = await selectRow("유일");
    expect(within(row).getByRole("button", { name: "병합" })).toBeDisabled();
  });

  it("비어 있는 주종은 확인 후 바로 삭제한다", async () => {
    const spies = handlers();
    const items = [node({ id: "empty", name: "빈 주종" })];
    render(<CategoryManager tree={tree(items)} {...spies} />);

    await selectRow("빈 주종");
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
    render(<CategoryManager tree={tree(items)} {...spies} />);

    const parentRow = await selectRow("부모");
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
    render(<CategoryManager tree={tree(items)} {...spies} />);

    const row = await selectRow("제품 있음");
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
    render(<CategoryManager tree={tree([])} {...spies} />);

    expect(screen.getByText(/이름을 바꾼 주종은 그대로 유지/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "기본 주종 복원" }));

    expect(spies.onResetSeed).toHaveBeenCalled();
  });

  it("제품 수를 배지로 보여준다", () => {
    const items = [node({ id: "c", name: "위스키", descendant_product_count: 12 })];

    render(<CategoryManager tree={tree(items)} {...handlers()} />);

    expect(screen.getByText("12종")).toBeInTheDocument();
  });

  it("기본 시드 항목을 표시한다", () => {
    const items = [node({ id: "c", name: "맥주", is_seeded: true })];

    render(<CategoryManager tree={tree(items)} {...handlers()} />);

    expect(screen.getByText("기본")).toBeInTheDocument();
  });

  it("처리 중인 행만 잠그고 다른 행은 그대로 둔다", async () => {
    const items = [node({ id: "a", name: "와인" }), node({ id: "b", name: "맥주" })];

    render(
      <CategoryManager
        tree={tree(items)}
        {...handlers()}
        renameStatus={{ isPending: true, isSuccess: false, variables: { id: "a" }, error: null }}
      />,
    );

    const wineRow = await selectRow("와인");
    expect(within(wineRow).getByRole("button", { name: "이름 변경" })).toBeDisabled();

    // 한 번에 한 행만 펼쳐지므로("맥주"를 펼치면 "와인"은 자동으로 접힌다), 두 상태를
    // 동시에가 아니라 순서대로 확인한다.
    const beerRow = await selectRow("맥주");
    expect(within(beerRow).getByRole("button", { name: "이름 변경" })).not.toBeDisabled();
  });

  it("처리 중인 행은 이동·병합·삭제도 함께 잠긴다", async () => {
    const items = [node({ id: "a", name: "와인" }), node({ id: "b", name: "맥주" })];

    render(
      <CategoryManager
        tree={tree(items)}
        {...handlers()}
        mergeStatus={{ isPending: true, isSuccess: false, variables: { id: "a" }, error: null }}
      />,
    );

    const row = await selectRow("와인");
    expect(within(row).getByRole("button", { name: "이동" })).toBeDisabled();
    expect(within(row).getByRole("button", { name: "병합" })).toBeDisabled();
    expect(within(row).getByRole("button", { name: "삭제" })).toBeDisabled();
  });

  it("오프라인에서는 이동·병합·삭제·기본값 복원을 막고 이유를 안내한다", async () => {
    const items = [node({ id: "c", name: "와인" })];
    const spies = handlers();

    render(<CategoryManager tree={tree(items)} {...spies} offline />);

    expect(screen.getByRole("button", { name: "기본 주종 복원" })).toBeDisabled();
    expect(screen.getByText(/오프라인에서는 사용할 수 없습니다/)).toBeInTheDocument();
    const row = await selectRow("와인");
    expect(within(row).getByRole("button", { name: "이동" })).toBeDisabled();
    expect(within(row).getByRole("button", { name: "병합" })).toBeDisabled();
    expect(within(row).getByRole("button", { name: "삭제" })).toBeDisabled();
    // 추가·이름 변경은 outbox 를 타므로 오프라인에서도 계속 쓸 수 있어야 한다.
    await userEvent.click(screen.getByRole("button", { name: "+ 주종 추가" }));
    await userEvent.type(screen.getByLabelText("이름"), "새 주종");
    expect(screen.getByRole("button", { name: "추가" })).not.toBeDisabled();
    expect(within(row).getByRole("button", { name: "이름 변경" })).not.toBeDisabled();
  });

  it("행의 오류를 그 행에 표시한다", () => {
    const items = [node({ id: "a", name: "와인" }), node({ id: "b", name: "맥주" })];

    render(
      <CategoryManager
        tree={tree(items)}
        {...handlers()}
        removeStatus={{
          isPending: false,
          isSuccess: false,
          variables: { id: "a" },
          error: new Error("하위 카테고리 2개가 있습니다"),
        }}
      />,
    );

    const wineRow = rowOf("와인").closest("li") as HTMLElement;
    expect(within(wineRow).getByRole("alert")).toHaveTextContent("하위 카테고리 2개가 있습니다");
    const beerRow = rowOf("맥주").closest("li") as HTMLElement;
    expect(within(beerRow).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("주종 추가 실패를 폼 근처에 알린다", async () => {
    render(
      <CategoryManager
        tree={tree([])}
        {...handlers()}
        createError={new Error("이름이 이미 있습니다")}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "+ 주종 추가" }));

    expect(screen.getByRole("alert")).toHaveTextContent("이름이 이미 있습니다");
  });

  it("기본 주종 복원 실패를 알린다", () => {
    render(
      <CategoryManager
        tree={tree([])}
        {...handlers()}
        resetSeedError={new Error("복원할 수 없습니다")}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("복원할 수 없습니다");
  });
});
