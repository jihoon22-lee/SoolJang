import { type InfiniteData, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bottle, ContextualTasting, Tasting, TastingPage, TastingSummary } from "@/api/types";
import { BottlePanel } from "@/components/BottlePanel";
import { activateDatabase, db } from "@/sync/db";

const NOW = "2026-01-01T00:00:00Z";
const target: Bottle = {
  id: "b1",
  purchase_id: "pu1",
  label_no: 1,
  status: "open",
  opened_on: "2026-01-01",
  finished_on: null,
  remaining_ml: 700,
  storage_location: null,
  note: null,
};
const pageKey = ["bottles", target.id, "tastings", "pages"];
const summaryKey = ["tastings", "summary", target.id];
function tasting(id: string): ContextualTasting {
  return {
    id,
    bottle_id: "b1",
    sku_id: "sku1",
    tasted_on: "2026-01-10",
    poured_ml: 10,
    rating: "4.0",
    nose: `노트 ${id}`,
    palate: null,
    finish: null,
    note: null,
    place: null,
    companions: null,
    updated_at: NOW,
    context: {
      product_id: "p1",
      product_name: "합성 술",
      sku_id: "sku1",
      volume_ml: 700,
      vintage: null,
      age_years: null,
      abv: null,
    },
    bottle: null,
    purchase: null,
  };
}
function token(item: Tasting) {
  return `${item.tasted_on}|${item.id}`;
}
function response(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function server(count: number) {
  const state = {
    items: Array.from({ length: count }, (_, index) =>
      tasting(`t-${String(count - index).padStart(4, "0")}`),
    ),
    failures: new Map<string | null, number>(),
    deleteFailure: false,
    pageGate: null as Promise<void> | null,
    pages: [] as { cursor: string | null; limit: number }[],
    summaries: 0,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname.endsWith("/tastings/page")) {
        const cursor = url.searchParams.get("cursor");
        const limit = Number(url.searchParams.get("limit"));
        state.pages.push({ cursor, limit });
        if ((state.failures.get(cursor) ?? 0) > 0) {
          state.failures.set(cursor, (state.failures.get(cursor) ?? 0) - 1);
          return response({ detail: "합성 페이지 조회 실패" }, 500);
        }
        if (state.pageGate) await state.pageGate;
        const rows = state.items.filter((item) => cursor === null || token(item) < cursor);
        const items = rows.slice(0, limit);
        return response({
          items,
          next_cursor: rows.length > limit ? token(items[items.length - 1] as Tasting) : null,
        });
      }
      if (url.pathname.endsWith("/tastings/summary")) {
        state.summaries += 1;
        return response({
          session_count: state.items.length,
          rated_count: state.items.length,
          average_rating: "4.0",
          first_rating: "4.0",
          latest_rating: "4.0",
          rating_change: "0.0",
          total_poured_ml: state.items.length * 10,
          first_tasted_on: "2026-01-10",
          latest_tasted_on: "2026-01-10",
        });
      }
      if (init?.method === "DELETE") {
        if (state.deleteFailure) return response({ detail: "합성 삭제 실패" }, 500);
        state.items = state.items.filter((item) => item.id !== url.pathname.split("/").at(-1));
        return response({
          id: url.pathname.split("/").at(-1),
          updated_at: "2026-01-02T00:00:00Z",
          deleted_at: "2026-01-02T00:00:00Z",
        });
      }
      return response([], 200);
    }),
  );
  return state;
}
function view() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  const rendered = render(
    <QueryClientProvider client={client}>
      <BottlePanel bottle={target} />
    </QueryClientProvider>,
  );
  return { client, ...rendered };
}
function cached(client: QueryClient) {
  return client.getQueryData<InfiniteData<TastingPage, string | null>>(pageKey);
}
function shownNotes() {
  return screen.queryAllByText(/^향: 노트 t-/);
}
async function loadAll(total: number) {
  await waitFor(() => expect(shownNotes()).toHaveLength(Math.min(50, total)));
  for (let visible = 50; visible < total; visible += 50) {
    await userEvent.click(screen.getByRole("button", { name: "이전 기록 더 보기" }));
    await waitFor(() => expect(shownNotes()).toHaveLength(Math.min(total, visible + 50)));
  }
}

beforeEach(async () => {
  localStorage.clear();
  await activateDatabase("u1");
  const base = { user_id: "u1", created_at: NOW, updated_at: NOW, deleted_at: null };
  await db.sku.put({ ...base, id: "sku1", product_id: "p1", volume_ml: 700 });
  await db.purchase.put({ ...base, id: "pu1", sku_id: "sku1" });
  await db.bottle.put({ ...base, ...target });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
});

it.each([
  51, 200,
])("같은 날짜의 %i건을 50건씩 커서로 받아 빠짐·중복 없이 보여준다", async (total) => {
  const state = server(total);
  const { client } = view();
  await loadAll(total);
  expect(screen.queryByRole("button", { name: "이전 기록 더 보기" })).not.toBeInTheDocument();
  expect(state.pages.every((page) => page.limit === 50)).toBe(true);
  expect(state.pages.map((page) => page.cursor)).toEqual([
    null,
    ...state.items.filter((_, index) => (index + 1) % 50 === 0 && index + 1 < total).map(token),
  ]);
  expect(cached(client)?.pages.flatMap((page) => page.items.map((item) => item.id))).toEqual(
    state.items.map((item) => item.id),
  );
  expect(new Set(shownNotes().map((element) => element.textContent)).size).toBe(total);
}, 20_000); // 200건 렌더링·4페이지 왕복은 coverage 계측에서 기본 5초를 넘긴다.

it("첫 페이지 오류는 재시도 후 실제 query cache에 기록을 채운다", async () => {
  const state = server(51);
  state.failures.set(null, 1);
  const { client } = view();
  expect(await screen.findByRole("alert")).toHaveTextContent("시음 기록을 불러오지 못했습니다");
  expect(cached(client)).toBeUndefined();
  await userEvent.click(screen.getByRole("button", { name: "시음 기록 다시 불러오기" }));
  await waitFor(() => expect(shownNotes()).toHaveLength(50));
  expect(cached(client)?.pages).toHaveLength(1);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("추가 페이지 실패 시 기존 50건을 유지하고 같은 커서로 재시도한다", async () => {
  const state = server(51);
  const cursor = token(state.items[49] as Tasting);
  state.failures.set(cursor, 1);
  const { client } = view();
  await waitFor(() => expect(shownNotes()).toHaveLength(50));
  await userEvent.click(screen.getByRole("button", { name: "이전 기록 더 보기" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("이전 기록을 더 불러오지 못했습니다");
  expect(shownNotes()).toHaveLength(50);
  expect(cached(client)?.pages).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "시음 기록 다시 불러오기" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "이전 기록 다시 불러오기" }));
  await waitFor(() => expect(shownNotes()).toHaveLength(51));
  expect(state.pages.map((page) => page.cursor)).toEqual([null, cursor, cursor]);
  expect(cached(client)?.pages).toHaveLength(2);
});

it("삭제 뒤 전체 페이지와 요약을 다시 받고 오래된 마지막 페이지를 cache에 남기지 않는다", async () => {
  const state = server(51);
  const { client } = view();
  await loadAll(51);
  let release = () => {};
  state.pageGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const removed = state.items[0] as Tasting;
  const item = screen.getByText(`향: ${removed.nose}`).closest("li");
  if (!item) throw new Error("시음 행이 없습니다");
  await userEvent.click(within(item).getByRole("button", { name: "삭제" }));
  await userEvent.click(within(item).getByRole("button", { name: "시음 기록 삭제" }));
  await waitFor(() => expect(state.pages).toHaveLength(3));
  expect(screen.queryByText(`향: ${removed.nose}`)).not.toBeInTheDocument();
  await act(async () => release());
  await waitFor(() => expect(screen.queryByText(`향: ${removed.nose}`)).not.toBeInTheDocument());
  expect(shownNotes()).toHaveLength(50);
  expect(cached(client)?.pages).toHaveLength(1);
  expect(cached(client)?.pageParams).toEqual([null]);
  expect(client.getQueryData<TastingSummary>(summaryKey)?.session_count).toBe(50);
  expect(state.summaries).toBe(2);
});

it("서버가 삭제를 거부하면 현재 이력·페이지·요약을 유지하고 오류를 알린다", async () => {
  const state = server(51);
  state.deleteFailure = true;
  const { client } = view();
  await loadAll(51);
  await userEvent.click(screen.getAllByRole("button", { name: "삭제" })[0] as HTMLElement);
  await userEvent.click(screen.getByRole("button", { name: "시음 기록 삭제" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 500");
  expect(shownNotes()).toHaveLength(51);
  expect(cached(client)?.pages).toHaveLength(2);
  expect(client.getQueryData<TastingSummary>(summaryKey)?.session_count).toBe(51);
  expect(state.pages).toHaveLength(2);
});

it("새 시음이 서버에 반영되어 outbox에서 빠진 뒤 전체 페이지와 요약을 갱신한다", async () => {
  const state = server(51);
  const { client } = view();
  await loadAll(51);
  await userEvent.click(screen.getByText(/자세히 기록/, { selector: "summary" }));
  await userEvent.type(screen.getByLabelText("향"), "새 시음 노트");
  await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));
  await waitFor(async () => expect(await db.outbox.count()).toBe(1));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(client.getQueryData<TastingSummary>(summaryKey)?.session_count).toBe(51);
  const [entry] = await db.outbox.toArray();
  if (!entry) throw new Error("추가한 시음 명령이 없습니다");
  state.items.unshift({
    ...tasting(entry.entity_id),
    tasted_on: String(entry.fields.tasted_on),
    nose: "새 시음 노트",
  });
  await act(async () => {
    await db.outbox.delete(entry.idempotency_key);
  });
  expect(await screen.findByText("향: 새 시음 노트")).toBeInTheDocument();
  await waitFor(() =>
    expect(client.getQueryData<TastingSummary>(summaryKey)?.session_count).toBe(52),
  );
  expect(cached(client)?.pages.flatMap((page) => page.items)).toHaveLength(52);
  expect(cached(client)?.pageParams[1]).toBe(token(state.items[49] as Tasting));
});

it("실패해 outbox에 남은 시음을 서버 이력이나 요약에 더하지 않는다", async () => {
  const state = server(51);
  const { client } = view();
  await loadAll(51);
  await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));
  await waitFor(async () => expect(await db.outbox.count()).toBe(1));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  const [entry] = await db.outbox.toArray();
  if (!entry) throw new Error("시음 명령이 없습니다");
  await act(async () => {
    await db.outbox.update(entry.idempotency_key, { status: "failed", error: "합성 실패" });
  });
  expect(cached(client)?.pages.flatMap((page) => page.items)).toHaveLength(51);
  expect(client.getQueryData<TastingSummary>(summaryKey)?.session_count).toBe(51);
  expect(state.items).toHaveLength(51);
});

it("이미 읽은 페이지를 갱신하다 실패해도 내역을 유지하고 전체 목록을 재시도한다", async () => {
  const state = server(51);
  const { client } = view();
  await loadAll(51);
  state.failures.set(null, 1);
  await act(async () => {
    await client.invalidateQueries({ queryKey: pageKey });
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "최신 시음 기록을 확인하지 못했습니다",
  );
  expect(shownNotes()).toHaveLength(51);
  expect(cached(client)?.pages).toHaveLength(2);
  await userEvent.click(screen.getByRole("button", { name: "목록 새로고침" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(cached(client)?.pages.flatMap((page) => page.items.map((item) => item.id))).toEqual(
    state.items.map((item) => item.id),
  );
});

it("계정이 바뀐 뒤 이전 outbox가 제거되어도 새 계정에서 이전 병을 재조회하지 않는다", async () => {
  await db.outbox.put({
    idempotency_key: "waiting",
    entity: "tasting_session",
    entity_id: "pending-tasting",
    user_id: "u1",
    op: "action",
    action: "record_tasting",
    fields: { bottle_id: target.id },
    created_at: NOW,
    status: "pending",
    error: null,
  });
  const state = server(51);
  const { client, unmount } = view();
  await loadAll(51);
  const previousStore = db;
  await act(async () => {
    await activateDatabase("pagination-other");
    await previousStore.outbox.delete("waiting");
    // Dexie가 commit 뒤 예약한 live query 알림까지 처리한다.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(state.pages).toHaveLength(2);
  expect(state.summaries).toBe(1);
  expect(client.isFetching()).toBe(0);
  unmount();
  await previousStore.transaction("rw", previousStore.tables, async () => {
    for (const table of previousStore.tables) await table.clear();
  });
});
