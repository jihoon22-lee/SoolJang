import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, tastingsApi } from "@/api/client";
import type { ContextualTasting } from "@/api/types";
import { TastingRow } from "@/components/TastingRow";
import { ToastProvider } from "@/components/Toast";
import { activateDatabase, db } from "@/sync/db";
import { syncEngine } from "@/sync/engine";

const record: ContextualTasting = {
  id: "t",
  updated_at: "2026-01-01T00:00:00Z",
  bottle_id: null,
  sku_id: "s",
  tasted_on: "2026-01-01",
  poured_ml: 50,
  rating: "0.0",
  note: "처음 메모",
  nose: null,
  palate: null,
  finish: null,
  place: null,
  companions: null,
  context: {
    product_id: "p",
    product_name: "합성 위스키",
    vintage: null,
    age_years: null,
    abv: "40",
    sku_id: "s",
    volume_ml: 700,
  },
  purchase: null,
  bottle: null,
};
const deletedAt = "2026-01-02T00:00:00Z";
beforeEach(async () => {
  await activateDatabase("row-owner");
  vi.spyOn(syncEngine, "triggerSync").mockResolvedValue();
  await db.tasting_session.put({
    ...record,
    user_id: "row-owner",
    created_at: record.updated_at,
    deleted_at: null,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
});
function view() {
  const onDeleted = vi.fn();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ToastProvider>
        <TastingRow item={record} offline={false} onCorrect={vi.fn()} onDeleted={onDeleted} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onDeleted };
}
it("병 없는 기록도 삭제 후 같은 ID로 복구하며 표시 버전을 확인한다", async () => {
  const remove = vi
    .spyOn(tastingsApi, "remove")
    .mockResolvedValue({ id: "t", updated_at: deletedAt, deleted_at: deletedAt });
  const restore = vi
    .spyOn(tastingsApi, "restore")
    .mockResolvedValue({ id: "t", updated_at: "2026-01-03T00:00:00Z", deleted_at: null });
  const { onDeleted } = view();
  await userEvent.click(screen.getByRole("button", { name: "삭제" }));
  expect(screen.getByText(/병의 잔량은 바뀌지 않습니다/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "시음 기록 삭제" }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(record));
  expect(remove).toHaveBeenCalledWith(
    "t",
    expect.objectContaining({ expected_updated_at: record.updated_at }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "기록 복구" }));
  await waitFor(() =>
    expect(restore).toHaveBeenCalledWith(
      "t",
      expect.objectContaining({ expected_updated_at: deletedAt }),
    ),
  );
  await waitFor(() => expect(screen.getByText("처음 메모")).toBeInTheDocument());
});
it("오래된 기록의 삭제가 거부되면 최신 내용을 명시적으로 다시 확인한다", async () => {
  const remove = vi
    .spyOn(tastingsApi, "remove")
    .mockRejectedValueOnce(new ApiError(409, "다른 기기에서 수정됐습니다"))
    .mockResolvedValue({ id: "t", updated_at: deletedAt, deleted_at: deletedAt });
  vi.spyOn(tastingsApi, "get").mockResolvedValue({
    ...record,
    updated_at: "2026-01-01T12:00:00Z",
    note: "새 메모",
  });
  view();
  await userEvent.click(screen.getByRole("button", { name: "삭제" }));
  await userEvent.click(screen.getByRole("button", { name: "시음 기록 삭제" }));
  await userEvent.click(await screen.findByRole("button", { name: "최신 기록 다시 확인" }));
  expect(await screen.findByText("새 메모")).toBeInTheDocument();
  expect(remove).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "시음 기록 삭제" }));
  await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
  expect(remove.mock.calls[1]?.[1].expected_updated_at).toBe("2026-01-01T12:00:00Z");
});

it("복구한 행에 최신 기록이 도착하면 새 메모와 버전으로 수정한다", async () => {
  vi.spyOn(tastingsApi, "remove").mockResolvedValue({
    id: "t",
    updated_at: deletedAt,
    deleted_at: deletedAt,
  });
  vi.spyOn(tastingsApi, "restore").mockResolvedValue({
    id: "t",
    updated_at: "2026-01-03T00:00:00.000001Z",
    deleted_at: null,
  });
  const onCorrect = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const row = (item: ContextualTasting) => (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <TastingRow item={item} offline={false} onCorrect={onCorrect} />
      </ToastProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(row(record));
  await userEvent.click(screen.getByRole("button", { name: "삭제" }));
  await userEvent.click(screen.getByRole("button", { name: "시음 기록 삭제" }));
  await userEvent.click(await screen.findByRole("button", { name: "기록 복구" }));
  await screen.findByText("처음 메모");
  const latest = {
    ...record,
    updated_at: "2026-01-03T00:00:00.000002Z",
    note: "다른 기기 최신 메모",
  };
  rerender(row(latest));
  expect(screen.getByText("다른 기기 최신 메모")).toBeInTheDocument();
  expect(screen.queryByText("처음 메모")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "수정" }));
  expect(onCorrect).toHaveBeenCalledWith(latest);
});
