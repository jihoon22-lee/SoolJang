import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/sync/db";
import { SyncStatusBadge } from "@/sync/SyncStatusBadge";
import { SyncStatusProvider } from "@/sync/SyncStatusProvider";
import { authenticatedRoutes, renderWithQuery, stubRoutes } from "@/testing";

const NOW = "2026-01-01T00:00:00Z";

beforeEach(async () => {
  await db.open();
  vi.stubGlobal("navigator", { ...navigator, onLine: true });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.conflict_log.clear();
  await db.outbox.clear();
  await db.vendor.clear();
});

function renderBadge() {
  return renderWithQuery(
    <SyncStatusProvider>
      <SyncStatusBadge />
    </SyncStatusProvider>,
  );
}

describe("SyncStatusBadge", () => {
  it("대기·실패·충돌이 없으면 최신 상태를 보여준다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/sync/batch", method: "POST", body: { stopped: false, results: [] } },
      { match: "/sync", method: "GET", body: { changes: {}, next_cursor: null, has_more: false } },
    ]);

    renderBadge();

    expect(await screen.findByRole("button", { name: "최신 상태" })).toBeInTheDocument();
  });

  it("충돌이 없을 때 배지를 누르면 즉시 동기화를 시도한다", async () => {
    const { calls } = stubRoutes([
      ...authenticatedRoutes(),
      { match: "/sync/batch", method: "POST", body: { stopped: false, results: [] } },
      { match: "/sync", method: "GET", body: { changes: {}, next_cursor: null, has_more: false } },
    ]);

    renderBadge();
    calls.length = 0;
    await userEvent.click(await screen.findByRole("button", { name: "최신 상태" }));

    // outbox 가 비어 있으면 flushOutbox 는 아무것도 보내지 않는다 — pullDeltas 의
    // GET /sync 호출로 "동기화를 실제로 시도했는지" 를 확인한다.
    await waitFor(() => {
      expect(calls.some((call) => call.method === "GET" && call.url.includes("/sync"))).toBe(true);
    });
  });

  it("오프라인이고 대기 중인 작업이 있으면 대기 건수를 보여준다", async () => {
    vi.stubGlobal("navigator", { ...navigator, onLine: false });
    await db.outbox.put({
      idempotency_key: "op1",
      entity: "vendor",
      op: "create",
      entity_id: "v1",
      fields: { name: "대기 중 구매처" },
      created_at: NOW,
      status: "pending",
      error: null,
    });

    renderBadge();

    expect(await screen.findByRole("button", { name: "오프라인 (대기 1건)" })).toBeInTheDocument();
  });

  it("온라인인데 outbox 를 못 보냈으면 최신 상태라고 하지 않는다", async () => {
    // flushOutbox 자체가 네트워크 오류 등으로 실패해도(예: 500) 로컬 항목은 여전히
    // pending 으로 남는다 — 이 경우 badge 가 "최신 상태" 라고 하면 사용자가 실제로
    // 반영됐다고 오해한다.
    await db.outbox.put({
      idempotency_key: "op1",
      entity: "vendor",
      op: "create",
      entity_id: "v1",
      fields: { name: "동기화 안 된 구매처" },
      created_at: NOW,
      status: "pending",
      error: null,
    });
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/sync/batch", method: "POST", status: 500, body: { detail: "서버 오류" } },
      { match: "/sync", method: "GET", body: { changes: {}, next_cursor: null, has_more: false } },
    ]);

    renderBadge();

    const badge = await screen.findByRole("button", { name: "동기화 대기 1건" });
    expect(badge.className).toContain("sync-status-warn");
  });

  it("충돌이 있으면 배지에 건수를 보여주고, 눌러서 패널을 열 수 있다", async () => {
    await db.conflict_log.put({
      id: "c1",
      user_id: "u1",
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      entity: "category",
      entity_id: "cat1",
      server_updated_at: NOW,
      client_updated_at: NOW,
      client_snapshot: { name: "내가 바꾸려던 이름" },
      idempotency_key: "op1",
    });
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/sync/batch", method: "POST", body: { stopped: false, results: [] } },
      { match: "/sync", method: "GET", body: { changes: {}, next_cursor: null, has_more: false } },
    ]);

    renderBadge();

    const badge = await screen.findByRole("button", { name: "충돌 1건" });
    await userEvent.click(badge);

    expect(await screen.findByRole("dialog", { name: "동기화 문제" })).toBeInTheDocument();
    // SyncIssuesPanel 은 열리자마자 자체 useLiveQuery 를 새로 구독한다 — 첫 계산이 비동기로
    // 끝나므로 동기 getByText 가 아니라 findByText 로 기다려야 한다.
    expect(await screen.findByText(/내가 바꾸려던 이름/)).toBeInTheDocument();
  });

  it("확인을 누르면 서버에 알리고 목록에서 사라진다", async () => {
    await db.conflict_log.put({
      id: "c1",
      user_id: "u1",
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      entity: "category",
      entity_id: "cat1",
      server_updated_at: NOW,
      client_updated_at: NOW,
      client_snapshot: { name: "내가 바꾸려던 이름" },
      idempotency_key: "op1",
    });
    const { calls } = stubRoutes([
      ...authenticatedRoutes(),
      { match: "/sync/batch", method: "POST", body: { stopped: false, results: [] } },
      { match: "/sync", method: "GET", body: { changes: {}, next_cursor: null, has_more: false } },
      { match: "/sync/conflicts/c1:resolve", method: "POST", status: 204, body: null },
    ]);

    renderBadge();
    await userEvent.click(await screen.findByRole("button", { name: "충돌 1건" }));
    await userEvent.click(await screen.findByRole("button", { name: "확인" }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes(":resolve"))).toBe(true);
    });
    expect(await screen.findByText("확인할 문제가 없습니다.")).toBeInTheDocument();
    expect((await db.conflict_log.get("c1"))?.deleted_at).not.toBeNull();
  });

  it("실패한 항목이 있으면 배지에 표시하고, 패널에서 건너뛰면 사라진다", async () => {
    await db.vendor.put({
      id: "v1",
      user_id: "u1",
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      name: "실패한 구매처",
      kind: "other",
      url: null,
      note: null,
      purchase_count: 0,
    });
    await db.outbox.put({
      idempotency_key: "op1",
      entity: "vendor",
      op: "create",
      entity_id: "v1",
      fields: { name: "실패한 구매처" },
      created_at: NOW,
      status: "failed",
      error: "이미 존재하는 값이거나 제약 조건을 위반했습니다",
    });
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/sync/batch", method: "POST", body: { stopped: false, results: [] } },
      { match: "/sync", method: "GET", body: { changes: {}, next_cursor: null, has_more: false } },
    ]);

    renderBadge();

    const badge = await screen.findByRole("button", { name: "동기화 실패 1건" });
    expect(badge.className).toContain("sync-status-danger");
    await userEvent.click(badge);

    expect(await screen.findByRole("dialog", { name: "동기화 문제" })).toBeInTheDocument();
    expect(screen.getByText("구매처 · 실패한 구매처")).toBeInTheDocument();
    expect(screen.getByText("이미 존재하는 값이거나 제약 조건을 위반했습니다")).toBeInTheDocument();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "건너뛰기" }));

    await waitFor(async () => {
      expect(await db.outbox.get("op1")).toBeUndefined();
    });
    // create 실패는 로컬에 남아 있던 낙관적 행(가짜 구매처)도 함께 지운다.
    expect(await db.vendor.get("v1")).toBeUndefined();
    expect(await screen.findByText("확인할 문제가 없습니다.")).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
