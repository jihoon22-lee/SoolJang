import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tastingsApi } from "@/api/client";
import type { ContextualTasting, TastingFilters, TastingSummary } from "@/api/types";
import { ProductTastingHistory } from "@/components/ProductTastingHistory";
import { activateDatabase, db } from "@/sync/db";
import { getLocalTasting, getLocalTastingHistory } from "@/sync/tastingHistory";

vi.mock("@/sync/tastingHistory", () => ({
  getLocalTasting: vi.fn(),
  getLocalTastingHistory: vi.fn(),
}));
const TIME = "2026-01-01T00:00:00Z";
let rows: ContextualTasting[];
let page: ReturnType<typeof vi.spyOn>,
  summary: ReturnType<typeof vi.spyOn>,
  get: ReturnType<typeof vi.spyOn>;
const onCorrect = vi.fn();
it("병 연결 없는 시음에도 수정과 삭제를 제공한다", async () => {
  rows = [{ ...item(1), bottle_id: null, bottle: null, purchase: null }];
  view();
  expect(await screen.findByRole("button", { name: "수정" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "삭제" })).toBeEnabled();
});
function item(index: number): ContextualTasting {
  const sku = index % 2 ? "sku500" : "sku750",
    bottle = `bottle-${index % 2}`;
  return {
    id: `t${String(index).padStart(4, "0")}`,
    updated_at: TIME,
    bottle_id: bottle,
    sku_id: sku,
    tasted_on: index % 3 ? "2026-01-10" : "2026-01-05",
    poured_ml: 10,
    rating: "4.0",
    nose: `향-${index}`,
    palate: null,
    finish: null,
    note: `기록-${index}`,
    place: null,
    companions: null,
    context: {
      product_id: "p1",
      product_name: "합성 제품",
      vintage: 2021,
      age_years: null,
      abv: "40",
      sku_id: sku,
      volume_ml: index % 2 ? 500 : 750,
    },
    purchase: {
      id: `purchase-${index % 2}`,
      updated_at: TIME,
      sku_id: sku,
      purchased_on: "2026-01-01",
      vendor_id: null,
      vendor_name: "합성 구매처",
      quantity: 1,
    },
    bottle: {
      id: bottle,
      revision: "r1",
      purchase_id: `purchase-${index % 2}`,
      label_no: 1,
      status: "finished",
      remaining_ml: 0,
      opened_on: "2026-01-01",
      finished_on: "2026-01-10",
      deleted_at: null,
    },
  };
}
function filterRows(filters: TastingFilters) {
  return rows.filter(
    (item) =>
      (!filters.sku_id || item.sku_id === filters.sku_id) &&
      (!filters.bottle_id || item.bottle_id === filters.bottle_id) &&
      (!filters.tasted_on_min || item.tasted_on >= filters.tasted_on_min) &&
      (!filters.tasted_on_max || item.tasted_on <= filters.tasted_on_max),
  );
}
function summarize(items: ContextualTasting[]): TastingSummary {
  return {
    session_count: items.length,
    rated_count: items.length,
    average_rating: "4.0",
    first_rating: "4.0",
    latest_rating: "4.0",
    rating_change: "0.0",
    total_poured_ml: items.length * 10,
    first_tasted_on: "2026-01-05",
    latest_tasted_on: "2026-01-10",
  };
}
function view(
  options: { offline?: boolean; selectedTastingId?: string; selectedSkuId?: string } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const props = {
    productId: "p1",
    offline: options.offline ?? false,
    selectedTastingId: options.selectedTastingId,
    selectedSkuId: options.selectedSkuId,
    onCorrect,
  };
  const rendered = render(
    <QueryClientProvider client={client}>
      <ProductTastingHistory {...props} />
    </QueryClientProvider>,
  );
  return {
    ...rendered,
    client,
    changeTarget: (selectedTastingId: string) =>
      rendered.rerender(
        <QueryClientProvider client={client}>
          <ProductTastingHistory {...props} selectedTastingId={selectedTastingId} />
        </QueryClientProvider>,
      ),
    changeOffline: (offline: boolean) =>
      rendered.rerender(
        <QueryClientProvider client={client}>
          <ProductTastingHistory {...props} offline={offline} />
        </QueryClientProvider>,
      ),
  };
}
beforeEach(async () => {
  localStorage.clear();
  await activateDatabase("u1");
  vi.clearAllMocks();
  rows = Array.from({ length: 55 }, (_, index) => item(55 - index));
  page = vi.spyOn(tastingsApi, "page").mockImplementation(async (params) => {
    const all = filterRows(params),
      offset = Number(params.cursor ?? 0),
      items = all.slice(offset, offset + 50);
    return {
      items,
      next_cursor: offset + items.length < all.length ? String(offset + items.length) : null,
    };
  });
  summary = vi
    .spyOn(tastingsApi, "summary")
    .mockImplementation(async (filters) => summarize(filterRows(filters)));
  get = vi.spyOn(tastingsApi, "get").mockImplementation(async (id) => {
    const found = rows.find((item) => item.id === id);
    if (!found) throw new Error("없음");
    return found;
  });
  vi.mocked(getLocalTastingHistory).mockImplementation(async (filters) => {
    const items = filterRows(filters);
    return { items, summary: summarize(items) };
  });
  vi.mocked(getLocalTasting).mockImplementation(
    async (id) => rows.find((item) => item.id === id) ?? null,
  );
});
afterEach(async () => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
});

it("규격·병·기간 조건을 같은 목록과 요약에 전달하고 50건 뒤까지 중복 없이 읽는다", async () => {
  view();
  await screen.findByText("기록-55");
  expect(screen.getAllByText(/^기록-/)).toHaveLength(50);
  await userEvent.click(screen.getByRole("button", { name: "이전 기록 더 보기" }));
  await waitFor(() => expect(screen.getAllByText(/^기록-/)).toHaveLength(55));
  await userEvent.selectOptions(screen.getByLabelText("시음 규격"), "sku500");
  await userEvent.selectOptions(screen.getByLabelText("시음 병"), "bottle-1");
  await userEvent.type(screen.getByLabelText("시음 시작일"), "2026-01-08");
  await userEvent.type(screen.getByLabelText("시음 종료일"), "2026-01-12");
  await waitFor(() =>
    expect(page).toHaveBeenLastCalledWith(
      expect.objectContaining({
        product_id: "p1",
        sku_id: "sku500",
        bottle_id: "bottle-1",
        tasted_on_min: "2026-01-08",
        tasted_on_max: "2026-01-12",
        cursor: null,
        limit: 50,
      }),
      expect.any(AbortSignal),
    ),
  );
  expect(summary).toHaveBeenLastCalledWith(
    expect.objectContaining({
      product_id: "p1",
      sku_id: "sku500",
      bottle_id: "bottle-1",
      tasted_on_min: "2026-01-08",
      tasted_on_max: "2026-01-12",
    }),
    expect.any(AbortSignal),
  );
});

it("50건 밖의 선택 기록을 단일 조회해 바로 표시·초점 이동하고 페이지를 읽으면 중복하지 않는다", async () => {
  view({ selectedTastingId: "t0001" });
  const selected = await screen.findByText("기록-1");
  await waitFor(() => expect(selected.closest("li")).toHaveFocus());
  expect(get).toHaveBeenCalledWith("t0001", expect.any(AbortSignal));
  expect(screen.getAllByText(/^기록-/)).toHaveLength(51);
  expect(screen.getByText(/현재 페이지 밖에 있어 따로 표시/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "이전 기록 더 보기" }));
  await waitFor(() => expect(screen.getAllByText(/^기록-/)).toHaveLength(55));
  expect(screen.getAllByText("기록-1")).toHaveLength(1);
});

it("추가 페이지 실패와 재시도 중 이미 읽은 50건을 보존한다", async () => {
  view();
  await screen.findByText("기록-55");
  page.mockRejectedValueOnce(new Error("추가 실패"));
  await userEvent.click(screen.getByRole("button", { name: "이전 기록 더 보기" }));
  await screen.findByText(/이전 기록을 더 불러오지 못했습니다/);
  expect(screen.getAllByText(/^기록-/)).toHaveLength(50);
  await userEvent.click(screen.getByRole("button", { name: "이전 기록 다시 불러오기" }));
  await waitFor(() => expect(screen.getAllByText(/^기록-/)).toHaveLength(55));
});

it("갱신 실패에도 목록과 요약을 유지하며 최초 실패에서는 재조회할 수 있다", async () => {
  page.mockRejectedValueOnce(new Error("최초 실패"));
  view();
  await screen.findByText("시음 기록을 불러오지 못했습니다.");
  await userEvent.click(screen.getByRole("button", { name: "시음 이력 새로고침" }));
  await screen.findByText("기록-55");
  page.mockRejectedValueOnce(new Error("갱신 실패"));
  summary.mockRejectedValueOnce(new Error("요약 실패"));
  await userEvent.click(screen.getByRole("button", { name: "시음 이력 새로고침" }));
  await screen.findByText(/최신 기록을 확인하지 못했습니다/);
  expect(screen.getAllByText(/^기록-/)).toHaveLength(50);
  expect(screen.getByText("55회")).toBeVisible();
});

it("오프라인은 기기에 저장된 전체 기록을 페이지로 읽고 정정 초안을 열 수 있다", async () => {
  onlineManager.setOnline(false);
  view({ offline: true, selectedTastingId: "t0001" });
  await screen.findByText("기록-55");
  await screen.findByText("기록-1");
  expect(screen.getByText(/기기에 저장된 시음 기록입니다/)).toBeVisible();
  expect(page).not.toHaveBeenCalled();
  expect(summary).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "이전 기록 더 보기" }));
  await waitFor(() => expect(screen.getAllByText(/^기록-/)).toHaveLength(55));
  await userEvent.click(screen.getAllByRole("button", { name: "수정" })[0] as HTMLElement);
  expect(onCorrect).toHaveBeenCalledWith(expect.objectContaining({ id: "t0055" }));
});

it("선택 기록 조회 실패가 이미 읽은 목록을 숨기지 않는다", async () => {
  view({ selectedTastingId: "missing" });
  await screen.findByText(/선택한 시음을 확인하지 못했습니다/);
  expect(screen.getAllByText(/^기록-/)).toHaveLength(50);
});

it("이전 선택 기록의 늦은 응답이 새 선택 기록을 덮지 않는다", async () => {
  let resolve!: (record: ContextualTasting) => void;
  get.mockImplementationOnce(
    () =>
      new Promise<ContextualTasting>((done) => {
        resolve = done;
      }),
  );
  const rendered = view({ selectedTastingId: "t0001" });
  await screen.findByText("기록-55");
  rendered.changeTarget("t0002");
  const second = await screen.findByText("기록-2");
  await waitFor(() => expect(second.closest("li")).toHaveFocus());
  await act(async () => resolve(item(1)));
  expect(second.closest("li")).toHaveFocus();
  expect(screen.queryByText("기록-1")).not.toBeInTheDocument();
});

it("오프라인 로컬 재조회 실패에도 이미 읽은 기록을 보존한다", async () => {
  view({ offline: true });
  await screen.findByText("기록-55");
  vi.mocked(getLocalTastingHistory).mockRejectedValue(new Error("로컬 읽기 실패"));
  await userEvent.click(screen.getByRole("button", { name: "시음 이력 새로고침" }));
  await screen.findByText("기기의 시음 기록을 불러오지 못했습니다.");
  expect(screen.getAllByText(/^기록-/)).toHaveLength(50);
  expect(screen.getByText("55회")).toBeVisible();
});

it("다른 규격 링크로 다시 들어오면 저장된 조회 규격보다 명시된 링크의 규격을 우선한다", async () => {
  const first = view();
  await screen.findByText("기록-55");
  await userEvent.selectOptions(screen.getByLabelText("시음 규격"), "sku500");
  first.unmount();
  view({ selectedSkuId: "sku750" });
  await waitFor(() => expect(screen.getByLabelText("시음 규격")).toHaveValue("sku750"));
  await waitFor(() =>
    expect(page).toHaveBeenLastCalledWith(
      expect.objectContaining({ sku_id: "sku750" }),
      expect.any(AbortSignal),
    ),
  );
});

it("실제 연결이 끊겨도 50건 밖 선택 기록을 로컬에서 다시 읽고 새로고침한다", async () => {
  const rendered = view({ selectedTastingId: "t0001" });
  await screen.findByText("기록-1");
  await act(async () => {
    onlineManager.setOnline(false);
    rendered.changeOffline(true);
  });
  await waitFor(() => expect(getLocalTasting).toHaveBeenCalledWith("t0001"));
  expect(await screen.findByText("기록-1")).toBeVisible();
  expect(screen.getAllByText(/^기록-/)).toHaveLength(51);
  const reads = vi.mocked(getLocalTasting).mock.calls.length;
  await userEvent.click(screen.getByRole("button", { name: "시음 이력 새로고침" }));
  await waitFor(() => expect(vi.mocked(getLocalTasting).mock.calls.length).toBeGreaterThan(reads));
  expect(screen.getByText("기록-1")).toBeVisible();
});
it("같은 화면에서 새 시음이 동기화되면 서버 목록과 요약을 갱신한다", async () => {
  await db.sync_meta.put({ key: "cursor", value: "before" });
  view();
  await screen.findByText("기록-55");
  rows.unshift(item(56));
  await act(async () => {
    await db.sync_meta.put({ key: "cursor", value: "after" });
  });
  expect(await screen.findByText("기록-56")).toBeInTheDocument();
  expect(await screen.findByText("56회")).toBeInTheDocument();
});
