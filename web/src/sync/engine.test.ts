import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/sync/db";
import { syncEngine } from "@/sync/engine";
import { enqueue } from "@/sync/outbox";
import { authenticatedRoutes, stubRoutes } from "@/testing";

beforeEach(async () => {
  await db.open();
  vi.stubGlobal("navigator", { ...navigator, onLine: true });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.outbox.clear();
  await db.vendor.clear();
  await db.conflict_log.clear();
  await db.sync_meta.clear();
});

describe("syncEngine.triggerSync — outbox 전송", () => {
  it("성공한 작업은 큐에서 제거되고 스냅샷이 로컬 미러에 반영된다", async () => {
    await enqueue({
      entity: "vendor",
      op: "create",
      entityId: "v1",
      fields: { name: "새 구매처" },
    });

    stubRoutes([
      ...authenticatedRoutes(),
      {
        match: "/sync/batch",
        method: "POST",
        body: {
          stopped: false,
          results: [
            {
              idempotency_key: (await db.outbox.toArray())[0]?.idempotency_key,
              status: "applied",
              detail: null,
              snapshot: {
                id: "v1",
                user_id: "u1",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
                deleted_at: null,
                name: "새 구매처",
              },
            },
          ],
        },
      },
      { match: "/sync", method: "GET", body: { changes: {}, next_cursor: null, has_more: false } },
    ]);

    await syncEngine.triggerSync();

    expect(await db.outbox.count()).toBe(0);
    const vendor = await db.vendor.get("v1");
    expect(vendor?.updated_at).toBe("2026-01-01T00:00:00Z");
  });

  it("실패한 작업 이후는 큐에 남고, 실패 작업은 status=failed 로 표시된다", async () => {
    const key1 = await enqueue({ entity: "vendor", op: "create", entityId: "v1", fields: {} });
    const key2 = await enqueue({ entity: "vendor", op: "create", entityId: "v2", fields: {} });

    stubRoutes([
      ...authenticatedRoutes(),
      {
        match: "/sync/batch",
        method: "POST",
        body: {
          stopped: true,
          results: [{ idempotency_key: key1, status: "failed", detail: "실패", snapshot: null }],
        },
      },
    ]);

    await syncEngine.triggerSync();

    const failed = await db.outbox.get(key1);
    expect(failed?.status).toBe("failed");
    const stillPending = await db.outbox.get(key2);
    expect(stillPending?.status).toBe("pending");
  });
});

describe("syncEngine.triggerSync — 델타 풀", () => {
  it("풀 응답을 로컬 미러에 병합한다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/sync/batch", method: "POST", body: { stopped: false, results: [] } },
      {
        match: "/sync",
        method: "GET",
        body: {
          changes: {
            vendor: [
              {
                id: "v9",
                user_id: "u1",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
                deleted_at: null,
                name: "서버에서 온 구매처",
              },
            ],
          },
          next_cursor: "abc",
          has_more: false,
        },
      },
    ]);

    await syncEngine.triggerSync();

    const vendor = await db.vendor.get("v9");
    expect(vendor?.name).toBe("서버에서 온 구매처");
    const cursor = await db.sync_meta.get("cursor");
    expect(cursor?.value).toBe("abc");
  });

  it("대기 중인 outbox 항목이 있는 행은 풀로 덮어쓰지 않는다", async () => {
    await db.vendor.put({
      id: "v1",
      user_id: "u1",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      deleted_at: null,
      name: "로컬에서 아직 안 보낸 이름",
    });
    await enqueue({
      entity: "vendor",
      op: "update",
      entityId: "v1",
      fields: { name: "로컬에서 아직 안 보낸 이름" },
    });

    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/sync/batch", method: "POST", body: { stopped: false, results: [] } },
      {
        match: "/sync",
        method: "GET",
        body: {
          changes: {
            vendor: [
              {
                id: "v1",
                user_id: "u1",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
                deleted_at: null,
                name: "스테일한 서버 값",
              },
            ],
          },
          next_cursor: null,
          has_more: false,
        },
      },
    ]);

    await syncEngine.triggerSync();

    const vendor = await db.vendor.get("v1");
    expect(vendor?.name).toBe("로컬에서 아직 안 보낸 이름");
  });
});

describe("syncEngine.triggerSync — 동시 트리거", () => {
  it("동기화 중에 트리거가 또 오면 버리지 않고, 끝난 뒤 한 번 더 돈다", async () => {
    // 클로저 안에서만 채워지는 값을 재할당 `let` 대신 컨테이너 객체로 들고 있는다 —
    // TS 가 재할당을 놓치고 `never` 로 좁혀 버리는 걸 피한다.
    const pullGate: { resolve: (() => void) | null } = { resolve: null };
    let pullCallCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          });

        if (url.includes("/sync/batch") && method === "POST") {
          return json({ stopped: false, results: [] });
        }
        if (url.includes("/sync") && method === "GET") {
          pullCallCount += 1;
          if (pullCallCount === 1) {
            // 이 테스트가 명시적으로 풀어 줄 때까지 첫 번째 풀을 붙잡아 둬 "동기화가
            // 아직 진행 중"인 상태를 만든다.
            await new Promise<void>((resolve) => {
              pullGate.resolve = resolve;
            });
          }
          return json({ changes: {}, next_cursor: null, has_more: false });
        }
        throw new Error(`예상하지 못한 요청: ${method} ${url}`);
      }),
    );

    const firstSync = syncEngine.triggerSync();
    // 첫 번째 풀이 실제로 걸려 멈출 때까지 이벤트 루프를 한 틱 양보한다.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pullGate.resolve).not.toBeNull();

    // 아직 첫 회차가 안 끝났다 — 조용히 버려지지 않고 dirty 로만 표시돼야 한다.
    await syncEngine.triggerSync();
    expect(pullCallCount).toBe(1);

    pullGate.resolve?.();
    await firstSync;

    // finally 에서 dirty 를 보고 자동으로 한 번 더 돈다 — fire-and-forget 이라 한 틱
    // 더 기다려야 두 번째 풀 호출이 실제로 일어난다.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pullCallCount).toBe(2);
  });
});
