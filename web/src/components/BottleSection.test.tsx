import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectionApi } from "@/api/collection";
import type { Bottle, Purchase } from "@/api/types";
import { BottleSection } from "@/components/BottleSection";
import { ToastProvider } from "@/components/Toast";
import { activateDatabase, db } from "@/sync/db";
import { renderWithQuery } from "@/testing";

const NOW = "2026-01-01T00:00:00Z";
function row(overrides: Record<string, unknown>) {
  return {
    id: "row",
    user_id: "u1",
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...overrides,
  };
}

function bottle(
  id: string,
  label: number,
  status: Bottle["status"],
  extra: Partial<Bottle> = {},
): Bottle {
  return {
    id,
    purchase_id: "pu1",
    label_no: label,
    status,
    opened_on: status === "unopened" ? null : "2026-02-01",
    finished_on: null,
    remaining_ml: status === "open" ? 300 : status === "unopened" ? null : 0,
    storage_location: null,
    note: null,
    ...extra,
  };
}

const purchase: Purchase = {
  id: "pu1",
  sku_id: "s1",
  volume_ml: 700,
  vendor_id: null,
  vendor_name: "가상마트",
  purchased_on: "2026-01-10",
  quantity: 6,
  unit_list_price: "10000.00",
  unit_paid_price: "9000.00",
  list_total: "60000.00",
  paid_total: "54000.00",
  currency: "KRW",
  fx_rate: null,
  foreign_unit_price: null,
  discount_note: null,
  import_note: null,
  bottle_count: 6,
};

async function seed(bottles: Bottle[]) {
  await db.sku.put(row({ id: "s1", product_id: "p1", volume_ml: 700 }));
  await db.purchase.put(row({ id: "pu1", sku_id: "s1", quantity: bottles.length }));
  await db.bottle.bulkPut(bottles.map((item) => row({ ...item })));
}

function renderSection(bottles: Bottle[], offline = false) {
  return renderWithQuery(
    <ToastProvider>
      <BottleSection bottles={bottles} purchases={[purchase]} offline={offline} />
    </ToastProvider>,
  );
}

beforeEach(async () => {
  localStorage.clear();
  await activateDatabase("u1");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([db.bottle.clear(), db.outbox.clear(), db.sku.clear(), db.purchase.clear()]);
});

describe("BottleSection", () => {
  it("재고 전체를 골라 한 번에 소진하고 실행 취소로 되돌린다", async () => {
    const bottles = [
      bottle("b1", 1, "unopened"),
      bottle("b2", 2, "open"),
      bottle("b3", 3, "finished"),
    ];
    await seed(bottles);
    renderSection(bottles);

    await userEvent.click(screen.getByRole("button", { name: "여러 병 선택" }));
    await userEvent.click(screen.getByRole("button", { name: "재고 전체 선택 (2)" }));
    const bar = screen.getByRole("toolbar", { name: "선택한 병 처리" });
    await userEvent.click(within(bar).getByRole("button", { name: "소진" }));

    expect(await screen.findByText("2병 소진 처리")).toBeInTheDocument();
    expect((await db.bottle.get("b1"))?.status).toBe("finished");
    expect((await db.bottle.get("b2"))?.status).toBe("finished");

    await userEvent.click(screen.getByRole("button", { name: "실행 취소" }));
    await waitFor(async () => expect((await db.bottle.get("b1"))?.status).toBe("unopened"));
    await waitFor(async () => expect((await db.bottle.get("b2"))?.remaining_ml).toBe(300));
    expect((await db.bottle.get("b2"))?.status).toBe("open");
  });

  it("할 수 없는 병이 섞이면 가능한 수를 보여주고 나머지는 건너뛴다", async () => {
    const bottles = [bottle("b1", 1, "unopened"), bottle("b2", 2, "open")];
    await seed(bottles);
    renderSection(bottles);

    await userEvent.click(screen.getByRole("button", { name: "여러 병 선택" }));
    await userEvent.click(screen.getByRole("button", { name: "재고 전체 선택 (2)" }));
    const bar = screen.getByRole("toolbar", { name: "선택한 병 처리" });
    await userEvent.click(within(bar).getByRole("button", { name: "개봉 1" }));

    expect(await screen.findByText(/1병 개봉 처리/)).toBeInTheDocument();
    expect(await db.outbox.count()).toBe(1);
  });

  it("여러 병을 날짜·메모와 함께 증여 처리한다", async () => {
    const bottles = [bottle("b1", 1, "unopened"), bottle("b2", 2, "unopened")];
    await seed(bottles);
    renderSection(bottles);

    await userEvent.click(screen.getByRole("button", { name: "여러 병 선택" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /1번 병/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /2번 병/ }));
    await userEvent.click(screen.getByRole("button", { name: "증여" }));
    await userEvent.type(screen.getByLabelText("받은 사람·메모 (선택)"), "명절 선물");
    await userEvent.click(screen.getByRole("button", { name: "증여 기록" }));

    await waitFor(async () => expect(await db.outbox.count()).toBe(2));
    const fields = (await db.outbox.toArray()).map((entry) => entry.fields.note);
    expect(fields).toEqual(["명절 선물", "명절 선물"]);
  });

  it("선택 없이 '한 병 개봉'과 '다 마심'을 바로 한다", async () => {
    const bottles = [bottle("b1", 1, "open"), bottle("b2", 2, "unopened")];
    await seed(bottles);
    renderSection(bottles);

    await userEvent.click(
      screen.getByRole("button", { name: /한 병 개봉 \(2번 · 700ml · 구매 pu1\)/ }),
    );
    await waitFor(async () => expect((await db.bottle.get("b2"))?.status).toBe("open"));
    await userEvent.click(screen.getByRole("button", { name: /개봉한 병 다 마심/ }));
    await waitFor(async () => expect((await db.bottle.get("b1"))?.status).toBe("finished"));
  });

  it("선택한 병을 보관 위치로 옮기고 실행 취소한다", async () => {
    const bottles = [bottle("b1", 1, "unopened")];
    await seed(bottles);
    vi.spyOn(collectionApi, "locations").mockResolvedValue([
      { id: "l1", name: "와인 셀러", kind: "cabinet", note: null, deleted: false, bottle_count: 0 },
    ]);
    vi.spyOn(collectionApi, "bottles").mockResolvedValue([
      {
        id: "b1",
        product_id: "p1",
        name: "술",
        label_no: 1,
        status: "unopened",
        location_id: null,
        legacy_location: null,
        bottle_code: "sooljang:bottle:b1",
      },
    ]);
    const moveMany = vi
      .spyOn(collectionApi, "moveMany")
      .mockResolvedValue({ moved: 1, unchanged: 0 });
    renderSection(bottles);

    await userEvent.click(screen.getByRole("button", { name: "여러 병 선택" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /1번 병/ }));
    await userEvent.click(screen.getByRole("button", { name: "위치 이동" }));
    await userEvent.click(await screen.findByRole("button", { name: "와인 셀러" }));

    await waitFor(() => expect(moveMany).toHaveBeenCalledWith(["b1"], "l1"));
    await userEvent.click(await screen.findByRole("button", { name: "실행 취소" }));
    await waitFor(() => expect(moveMany).toHaveBeenLastCalledWith(["b1"], null));
  });

  it("오프라인이면 위치 이동을 막고 이유를 알린다", async () => {
    const bottles = [bottle("b1", 1, "unopened")];
    await seed(bottles);
    renderSection(bottles, true);

    await userEvent.click(screen.getByRole("button", { name: "여러 병 선택" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /1번 병/ }));

    const move = screen.getByRole("button", { name: "위치 이동" });
    expect(move).toBeDisabled();
    expect(move).toHaveAttribute("title", "보관 위치는 온라인에서 옮길 수 있습니다");
  });

  it("지난 병이 많으면 접어 두고 펼칠 수 있다", async () => {
    const bottles = [
      bottle("b1", 1, "unopened"),
      ...[2, 3, 4, 5].map((label) => bottle(`f${label}`, label, "finished")),
    ];
    await seed(bottles);
    renderSection(bottles);

    expect(screen.queryByText(/^5번 병/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "지난 병 4개 보기" }));
    expect(screen.getByText(/^5번 병/)).toBeInTheDocument();
  });
});

describe("RemainingEditor (병 패널)", () => {
  it("직접 입력은 용량을 넘거나 비면 저장을 막는다", async () => {
    const { RemainingEditor } = await import("@/components/RemainingEditor");
    const target = bottle("b1", 1, "open");
    await seed([target]);
    const onSet = vi.fn();
    renderWithQuery(<RemainingEditor bottle={target} onSet={onSet} />);

    await userEvent.click(screen.getByRole("button", { name: "잔량 조정" }));
    const input = await screen.findByLabelText(/남은 양\(ml\) · 최대 700ml/);
    const save = screen.getByRole("button", { name: "저장" });
    expect(save).toBeDisabled();
    await userEvent.type(input, "800");
    expect(save).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, "120");
    await userEvent.click(save);
    expect(onSet).toHaveBeenCalledWith(120);
    await userEvent.click(screen.getByRole("button", { name: "다 마심(소진)" }));
    expect(onSet).toHaveBeenLastCalledWith(0);
  });
});

it("반복 구매의 같은 1번 병을 구매 참조로 구분하고 실제 병 ID를 넘긴다", async () => {
  const firstPurchase = { ...purchase, id: "purchase-a" };
  const secondPurchase = { ...purchase, id: "purchase-b" };
  const onSelectContext = vi.fn();
  renderWithQuery(
    <BottleSection
      bottles={[
        bottle("b-a", 1, "unopened", { purchase_id: firstPurchase.id }),
        bottle("b-b", 1, "unopened", { purchase_id: secondPurchase.id }),
      ]}
      purchases={[firstPurchase, secondPurchase]}
      offline
      selectedSkuId="s1"
      onSelectContext={onSelectContext}
    />,
  );
  const rows = screen.getAllByRole("button", { name: /^1번 병/ });
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent("700ml");
  expect(rows[0]?.textContent).not.toBe(rows[1]?.textContent);
  await userEvent.click(rows[1] as HTMLElement);
  expect(onSelectContext).toHaveBeenCalledWith({ skuId: "s1", bottleId: "b-b" });
});

it("선택한 지난 병은 접힌 과거 목록에서도 펼쳐지고 다른 규격은 실행 대상에 포함하지 않는다", () => {
  const past = Array.from({ length: 5 }, (_, i) => bottle(`past-${i}`, i + 1, "finished"));
  renderWithQuery(
    <BottleSection
      bottles={[...past, bottle("other", 1, "unopened", { purchase_id: "other-purchase" })]}
      purchases={[
        purchase,
        { ...purchase, id: "other-purchase", sku_id: "other-sku", volume_ml: 350 },
      ]}
      offline
      selectedSkuId="s1"
      selectedBottleId="past-4"
    />,
  );
  expect(screen.getByRole("button", { name: /^5번 병/ })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("개봉일")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /350ml/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /한 병 개봉/ })).not.toBeInTheDocument();
});
