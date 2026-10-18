import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, tastingsApi } from "@/api/client";
import type { DeletedTasting } from "@/api/types";
import { DeletedTastings } from "@/components/DeletedTastings";
import { ToastProvider } from "@/components/Toast";
import { activateDatabase, db } from "@/sync/db";
import { syncEngine } from "@/sync/engine";

const deleted: DeletedTasting = {
  id: "t-deleted",
  updated_at: "2026-10-02T00:00:00Z",
  deleted_at: "2026-10-02T00:00:00Z",
  bottle_id: "b1",
  sku_id: "s1",
  tasted_on: "2026-10-01",
  poured_ml: 30,
  rating: "4.0",
  note: null,
  nose: null,
  palate: null,
  finish: null,
  place: null,
  companions: null,
  context: {
    product_id: "p1",
    product_name: "합성 위스키",
    vintage: null,
    age_years: null,
    abv: "40",
    sku_id: "s1",
    volume_ml: 700,
  },
  purchase: null,
  bottle: null,
};

beforeEach(async () => {
  await activateDatabase("trash-owner");
  vi.spyOn(syncEngine, "triggerSync").mockResolvedValue();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
});

function view(online = true) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ToastProvider>
        <DeletedTastings online={online} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

it("최근 삭제한 시음을 보여 주고 삭제 시점 버전으로 복구한다", async () => {
  vi.spyOn(tastingsApi, "deleted").mockResolvedValueOnce([deleted]).mockResolvedValue([]);
  const restore = vi.spyOn(tastingsApi, "restore").mockResolvedValue({
    id: "t-deleted",
    updated_at: "2026-10-03T00:00:00Z",
    deleted_at: null,
  });
  view();

  expect(await screen.findByText(/^합성 위스키 · .*700ml$/)).toBeInTheDocument();
  expect(screen.getByText(/2026-10-01 마심 · 4.0점 · 30ml/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "복구" }));

  await waitFor(() =>
    expect(restore).toHaveBeenCalledWith("t-deleted", {
      request_id: expect.any(String),
      expected_updated_at: "2026-10-02T00:00:00Z",
    }),
  );
  expect(await screen.findByText(/시음 기록을 복구했습니다/)).toBeInTheDocument();
  expect(await screen.findByText("최근 삭제한 시음이 없습니다.")).toBeInTheDocument();
});

it("일시 실패한 복구를 다시 누르면 같은 요청 id로 보내 중복 반영을 막는다", async () => {
  vi.spyOn(tastingsApi, "deleted").mockResolvedValue([deleted]);
  const restore = vi
    .spyOn(tastingsApi, "restore")
    .mockRejectedValueOnce(new Error("네트워크 오류"))
    .mockResolvedValue({ id: "t-deleted", updated_at: "2026-10-03T00:00:00Z", deleted_at: null });
  view();

  await userEvent.click(await screen.findByRole("button", { name: "복구" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("네트워크 오류");
  await userEvent.click(screen.getByRole("button", { name: "복구" }));

  await waitFor(() => expect(restore).toHaveBeenCalledTimes(2));
  const [first, second] = restore.mock.calls;
  expect(second?.[1].request_id).toBe(first?.[1].request_id);
});

it("버전 충돌이면 오류를 알리고 다음 복구는 새 요청으로 보낸다", async () => {
  vi.spyOn(tastingsApi, "deleted").mockResolvedValue([deleted]);
  const restore = vi
    .spyOn(tastingsApi, "restore")
    .mockRejectedValueOnce(new ApiError(409, "시음 기록이 변경되었습니다"))
    .mockResolvedValue({ id: "t-deleted", updated_at: "2026-10-03T00:00:00Z", deleted_at: null });
  view();

  await userEvent.click(await screen.findByRole("button", { name: "복구" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("시음 기록이 변경되었습니다");
  await userEvent.click(screen.getByRole("button", { name: "복구" }));

  await waitFor(() => expect(restore).toHaveBeenCalledTimes(2));
  const [first, second] = restore.mock.calls;
  expect(second?.[1].request_id).not.toBe(first?.[1].request_id);
});

it("오프라인이면 목록을 부르지 않고 온라인에서 확인하라고 안내한다", () => {
  const list = vi.spyOn(tastingsApi, "deleted");
  view(false);

  expect(screen.getByText("온라인에서 확인할 수 있습니다.")).toBeInTheDocument();
  expect(list).not.toHaveBeenCalled();
});
