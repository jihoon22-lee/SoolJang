import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activateDatabase, db } from "@/sync/db";
import { syncEngine } from "@/sync/engine";
import { enqueue } from "@/sync/outbox";
import { authenticatedRoutes, stubRoutes } from "@/testing";

beforeEach(async () => {
  await activateDatabase("u1");
  syncEngine.setUser("u1");
  vi.stubGlobal("navigator", { ...navigator, onLine: true });
});

afterEach(async () => {
  syncEngine.stop();
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
    // 첫 번째 풀이 실제로 걸려 멈출 때까지 기다린다. 고정된 틱 수는 CI 러너 속도에
    // 따라 불안정해(vi.waitFor 로 폴링) 실제로 멈출 때까지 기다린다.
    await vi.waitFor(() => expect(pullGate.resolve).not.toBeNull());

    // 아직 첫 회차가 안 끝났다 — 조용히 버려지지 않고 dirty 로만 표시돼야 한다.
    await syncEngine.triggerSync();
    expect(pullCallCount).toBe(1);

    pullGate.resolve?.();
    await firstSync;

    // finally 에서 dirty 를 보고 자동으로 한 번 더 돈다 — fire-and-forget 이라 그
    // 완료를 기다려야 두 번째 풀 호출이 실제로 일어난다.
    await vi.waitFor(() => expect(pullCallCount).toBe(2));
  });
});

function respond(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}
function serverRow(id: string, name = id, updatedAt = "2026-01-03T00:00:00Z") {
  return {
    id,
    user_id: "u1",
    name,
    updated_at: updatedAt,
    created_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
  };
}
function batchResult(operations: { idempotency_key: string; entity_id: string }[]) {
  return {
    stopped: false,
    results: operations.map((operation) => ({
      idempotency_key: operation.idempotency_key,
      status: "applied",
      snapshot: serverRow(operation.entity_id),
    })),
  };
}
it.each([199, 200, 201, 401])("%i개 명령을 200개 이하로 FIFO 순차 전송한다", async (count) => {
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1)
    keys.push(
      await enqueue({
        entity: "vendor",
        op: "create",
        entityId: `v${i}`,
        fields: { name: `V${i}` },
      }),
    );
  const received: string[][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input.includes("/sync/batch")) {
        const payload = JSON.parse(String(init?.body));
        expect(payload.expected_user_id).toBe("u1");
        received.push(
          payload.operations.map((op: { idempotency_key: string }) => op.idempotency_key),
        );
        return respond(batchResult(payload.operations));
      }
      return respond({ changes: {}, next_cursor: null, has_more: false });
    }),
  );
  await syncEngine.triggerSync();
  expect(received.map((batch) => batch.length)).toEqual(
    count <= 200 ? [count] : count <= 400 ? [200, count - 200] : [200, 200, 1],
  );
  expect(received.flat()).toEqual(keys);
  expect(await db.outbox.count()).toBe(0);
});
it("두 번째 배치 응답 유실 후 같은 멱등 키로 재전송한다", async () => {
  for (let i = 0; i < 201; i += 1)
    await enqueue({ entity: "vendor", op: "create", entityId: `v${i}`, fields: {} });
  const sent: string[][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (!input.includes("/sync/batch"))
        return respond({ changes: {}, next_cursor: null, has_more: false });
      const { operations } = JSON.parse(String(init?.body));
      sent.push(operations.map((op: { idempotency_key: string }) => op.idempotency_key));
      if (sent.length === 2) throw new TypeError("response lost");
      return respond(batchResult(operations));
    }),
  );
  await syncEngine.triggerSync();
  expect(await db.outbox.count()).toBe(1);
  await syncEngine.triggerSync();
  expect(sent[2]).toEqual(sent[1]);
  expect(await db.outbox.count()).toBe(0);
});
it("응답 순서가 바뀌어도 멱등 키로 올바른 행에 반영한다", async () => {
  for (const id of ["v1", "v2"])
    await enqueue({ entity: "vendor", op: "create", entityId: id, fields: {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (!input.includes("/sync/batch"))
        return respond({ changes: {}, next_cursor: null, has_more: false });
      const result = batchResult(JSON.parse(String(init?.body)).operations);
      result.results.reverse();
      return respond(result);
    }),
  );
  await syncEngine.triggerSync();
  expect((await db.vendor.get("v1"))?.name).toBe("v1");
  expect((await db.vendor.get("v2"))?.name).toBe("v2");
});
it.each([
  "missing",
  "duplicate",
  "unknown",
])("%s 응답 식별자면 대기열을 보존하고 오류를 표시한다", async (kind) => {
  await enqueue({ entity: "vendor", op: "create", entityId: "v1", fields: {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: string, init?: RequestInit) => {
      const result = batchResult(JSON.parse(String(init?.body)).operations);
      if (kind === "missing") result.results = [];
      if (kind === "duplicate" && result.results[0]) result.results.push(result.results[0]);
      if (kind === "unknown" && result.results[0]) result.results[0].idempotency_key = "unknown";
      return respond(result);
    }),
  );
  let error: string | null = null;
  const unsubscribe = syncEngine.onStateChange((state) => {
    error = state.lastError;
  });
  await syncEngine.triggerSync();
  unsubscribe();
  expect(await db.outbox.count()).toBe(1);
  expect(error).toContain("보존");
});
it("전송 중 같은 행을 다시 수정하면 오래된 snapshot을 적용하지 않고 다음 배치로 보낸다", async () => {
  await enqueue({
    entity: "vendor",
    op: "update",
    entityId: "v1",
    fields: { name: "first" },
    baseUpdatedAt: "2026-01-01T00:00:00Z",
    optimisticRow: serverRow("v1", "first"),
  });
  const names: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (!input.includes("/sync/batch"))
        return respond({ changes: {}, next_cursor: null, has_more: false });
      const { operations } = JSON.parse(String(init?.body));
      names.push(operations[0].fields.name);
      if (names.length === 1) {
        await enqueue({
          entity: "vendor",
          op: "update",
          entityId: "v1",
          fields: { name: "latest" },
          baseUpdatedAt: "2026-01-03T00:00:00Z",
          optimisticRow: serverRow("v1", "latest", "2026-01-04T00:00:00Z"),
        });
        return respond({
          stopped: false,
          results: [
            {
              idempotency_key: operations[0].idempotency_key,
              status: "applied",
              snapshot: serverRow("v1", "first"),
            },
          ],
        });
      }
      expect((await db.vendor.get("v1"))?.name).toBe("latest");
      expect(operations[0].base_updated_at).toBe("2026-01-03T00:00:00Z");
      return respond({
        stopped: false,
        results: [
          {
            idempotency_key: operations[0].idempotency_key,
            status: "applied",
            snapshot: serverRow("v1", "latest", "2026-01-05T00:00:00Z"),
          },
        ],
      });
    }),
  );
  await syncEngine.triggerSync();
  expect(names).toEqual(["first", "latest"]);
  expect((await db.vendor.get("v1"))?.name).toBe("latest");
});
it("계정 전환 뒤 늦은 batch 응답은 어느 계정 미러에도 반영하지 않는다", async () => {
  await enqueue({ entity: "vendor", op: "create", entityId: "v1", fields: {} });
  const previous = db;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      await activateDatabase("u2");
      syncEngine.setUser("u2");
      return respond(batchResult(payload.operations));
    }),
  );
  await syncEngine.triggerSync();
  expect(await previous.outbox.count()).toBe(1);
  expect(await db.vendor.get("v1")).toBeUndefined();
  expect(await previous.vendor.get("v1")).toBeUndefined();
  await previous.outbox.clear();
});
it("최신 서버 미러를 과거 델타로 되돌리지 않는다", async () => {
  await db.vendor.put(serverRow("v1", "latest", "2026-01-05T00:00:00Z"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      respond({
        changes: { vendor: [serverRow("v1", "stale")] },
        next_cursor: "next",
        has_more: false,
      }),
    ),
  );
  await syncEngine.triggerSync();
  expect((await db.vendor.get("v1"))?.name).toBe("latest");
});

it("같은 계정의 두 탭은 하나의 전송자만 네트워크를 사용한다", async () => {
  const { SyncEngine } = await import("@/sync/engine");
  const other = new SyncEngine();
  other.setUser("u1");
  let held = false;
  vi.stubGlobal("navigator", {
    ...navigator,
    onLine: true,
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: object | null) => Promise<void>,
      ) => {
        if (held) return callback(null);
        held = true;
        try {
          await callback({});
        } finally {
          held = false;
        }
      },
    },
  });
  const gate: { release?: () => void } = {};
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return respond({ changes: {}, next_cursor: null, has_more: false });
    }),
  );
  const running = syncEngine.triggerSync();
  await vi.waitFor(() => expect(calls).toBe(1));
  await other.triggerSync();
  expect(calls).toBe(1);
  gate.release?.();
  await running;
  other.stop();
});

it("부모 실패 이후 자식 명령은 자동 재시도하지 않는다", async () => {
  const parent = await enqueue({ entity: "vendor", op: "create", entityId: "parent", fields: {} });
  await enqueue({
    entity: "purchase",
    op: "create",
    entityId: "child",
    fields: { vendor_id: "parent" },
  });
  const fetch = vi.fn(async () =>
    respond({
      stopped: true,
      results: [
        { idempotency_key: parent, status: "failed", snapshot: null, detail: "이름이 필요합니다" },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  await syncEngine.triggerSync();
  expect(await db.outbox.count()).toBe(2);
  await syncEngine.triggerSync();
  expect(fetch).toHaveBeenCalledOnce();
});

it("페이지를 다시 열지 않아도 동기화 직전에 늦은 구버전 명령을 가져온다", async () => {
  const { SoolJangDB } = await import("@/sync/db");
  const legacy = new SoolJangDB();
  await legacy.vendor.put(serverRow("legacy-late", "구버전 탭의 새 입력"));
  await legacy.outbox.put({
    idempotency_key: "legacy-late-key",
    entity: "vendor",
    entity_id: "legacy-late",
    op: "create",
    fields: { name: "구버전 탭의 새 입력" },
    created_at: "2026-01-01",
    status: "pending",
    error: null,
  });
  const batches: string[][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (!input.includes("/sync/batch"))
        return respond({ changes: {}, next_cursor: null, has_more: false });
      const { operations } = JSON.parse(String(init?.body));
      batches.push(operations.map((op: { idempotency_key: string }) => op.idempotency_key));
      return respond(batchResult(operations));
    }),
  );
  await syncEngine.triggerSync();
  await syncEngine.triggerSync();
  expect(batches).toEqual([["legacy-late-key"]]);
  expect(await db.outbox.count()).toBe(0);
  expect(await legacy.outbox.get("legacy-late-key")).toBeDefined();
  await legacy.outbox.delete("legacy-late-key");
  await legacy.vendor.delete("legacy-late");
  legacy.close();
});
