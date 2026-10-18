import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateDatabase, db, lockDatabase } from "@/sync/db";
import { quarantineContext, quarantineInvalidEntries } from "@/sync/quarantine";
import { SyncStatusBadge } from "@/sync/SyncStatusBadge";
import { SyncStatusProvider } from "@/sync/SyncStatusProvider";
import { authenticatedRoutes, renderWithQuery, stubRoutes } from "@/testing";

const NOW = "2026-01-01T00:00:00Z";

beforeEach(async () => {
  await activateDatabase("u1");
  vi.stubGlobal("navigator", { ...navigator, onLine: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await db.conflict_log.clear();
  await db.outbox.clear();
  await db.vendor.clear();
  await db.sync_meta.clear();
});

function renderBadge() {
  return renderWithQuery(
    <SyncStatusProvider userId="u1">
      <SyncStatusBadge />
    </SyncStatusProvider>,
  );
}

/** 충돌 1건을 심고, 배지가 패널을 열 수 있는 상태로 만든다. */
async function seedConflict() {
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
      user_id: "u1",
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
      user_id: "u1",
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

    const badge = await screen.findByRole("button", { name: "동기화 확인 필요" });
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

  it("확인이 서버 오류로 실패하면 알림을 보여주고 목록에 남는다(B8)", async () => {
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
      {
        match: "/sync/conflicts/c1:resolve",
        method: "POST",
        status: 500,
        body: {
          type: "https://sooljang.local/errors/internal",
          title: "서버 오류",
          status: 500,
          detail: "서버 오류",
          instance: "/api/v1/sync/conflicts/c1:resolve",
        },
      },
    ]);

    renderBadge();
    await userEvent.click(await screen.findByRole("button", { name: "충돌 1건" }));
    await userEvent.click(await screen.findByRole("button", { name: "확인" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("서버 오류");
    expect(screen.getByText(/내가 바꾸려던 이름/)).toBeInTheDocument();
    expect((await db.conflict_log.get("c1"))?.deleted_at).toBeNull();
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
      user_id: "u1",
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
    expect(await screen.findByText("구매처 · 실패한 구매처")).toBeInTheDocument();
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

  it("실패 입력 수정은 라벨 있는 값만 보이고 비운 가격은 0원이 아닌 공란으로 다시 보낸다", async () => {
    await db.outbox.put({
      idempotency_key: "op-purchase",
      user_id: "u1",
      entity: "purchase",
      op: "create",
      entity_id: "pu1",
      fields: {
        sku_id: "00000000-0000-4000-8000-000000000001",
        quantity: 2,
        unit_paid_price: 45000,
        purchased_on: "2026-01-01",
      },
      created_at: NOW,
      status: "failed",
      error: "가격을 확인해 주세요",
    });
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/sync/batch", method: "POST", body: { stopped: false, results: [] } },
      { match: "/sync", method: "GET", body: { changes: {}, next_cursor: null, has_more: false } },
    ]);
    vi.stubGlobal("navigator", { ...navigator, onLine: false });

    renderBadge();
    await userEvent.click(await screen.findByRole("button", { name: "동기화 실패 1건" }));
    await userEvent.click(await screen.findByRole("button", { name: "입력 수정" }));

    expect(screen.queryByDisplayValue("00000000-0000-4000-8000-000000000001")).toBeNull();
    expect(screen.queryByText("sku_id")).toBeNull();
    const price = screen.getByLabelText("병당 실구매가");
    expect(price).toHaveAttribute("inputmode", "decimal");
    await userEvent.clear(price);
    await userEvent.clear(screen.getByLabelText("병수"));
    await userEvent.type(screen.getByLabelText("병수"), "3");
    await userEvent.click(screen.getByRole("button", { name: "수정 후 다시 시도" }));

    await waitFor(async () => {
      const entries = await db.outbox.where("status").equals("pending").toArray();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.fields).toMatchObject({
        sku_id: "00000000-0000-4000-8000-000000000001",
        quantity: 3,
        unit_paid_price: null,
      });
    });
  });

  it("충돌 시각은 원문 ISO 대신 읽을 수 있는 현지 시각으로 보여준다", async () => {
    await seedConflict();
    renderBadge();
    await userEvent.click(await screen.findByRole("button", { name: "충돌 1건" }));

    expect(
      await screen.findByText(new RegExp(new Date(NOW).toLocaleString("ko-KR"))),
    ).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(NOW))).toBeNull();
  });

  it("패널이 열리면 포커스가 패널로 이동한다", async () => {
    await seedConflict();
    renderBadge();

    await userEvent.click(await screen.findByRole("button", { name: "충돌 1건" }));

    const dialog = await screen.findByRole("dialog", { name: "동기화 문제" });
    expect(dialog).toHaveFocus();
  });

  it("Escape 를 누르면 패널이 닫히고 배지로 포커스가 돌아온다", async () => {
    await seedConflict();
    renderBadge();

    const badge = await screen.findByRole("button", { name: "충돌 1건" });
    await userEvent.click(badge);
    await screen.findByRole("dialog", { name: "동기화 문제" });

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "동기화 문제" })).not.toBeInTheDocument();
    await waitFor(() => expect(badge).toHaveFocus());
  });

  it("패널 바깥을 클릭하면 닫힌다", async () => {
    await seedConflict();
    renderBadge();

    await userEvent.click(await screen.findByRole("button", { name: "충돌 1건" }));
    await screen.findByRole("dialog", { name: "동기화 문제" });

    await userEvent.click(document.body);

    expect(screen.queryByRole("dialog", { name: "동기화 문제" })).not.toBeInTheDocument();
  });

  it("Tab 이 패널 안에서만 순환한다(포커스 트랩)", async () => {
    await seedConflict();
    renderBadge();

    await userEvent.click(await screen.findByRole("button", { name: "충돌 1건" }));
    await screen.findByRole("dialog", { name: "동기화 문제" });

    const closeButton = screen.getByRole("button", { name: "닫기" });
    const confirmButton = screen.getByRole("button", { name: "확인" });

    // 마지막 포커스 가능 요소(확인)에서 Tab → 첫 요소(닫기)로 순환한다.
    confirmButton.focus();
    await userEvent.tab();
    expect(closeButton).toHaveFocus();

    // 첫 요소(닫기)에서 Shift+Tab → 마지막 요소(확인)로 순환한다.
    closeButton.focus();
    await userEvent.tab({ shift: true });
    expect(confirmButton).toHaveFocus();
  });
});

describe("SyncStatusBadge 대기열", () => {
  it("오프라인 대기 기록을 패널에서 목록으로 보여준다", async () => {
    vi.stubGlobal("navigator", { ...navigator, onLine: false });
    await db.outbox.put({
      idempotency_key: "op-q",
      user_id: "u1",
      entity: "vendor",
      op: "create",
      entity_id: "v1",
      fields: { name: "대기 중 구매처" },
      created_at: NOW,
      status: "pending",
      error: null,
    });

    renderBadge();
    await userEvent.click(await screen.findByRole("button", { name: "오프라인 (대기 1건)" }));

    expect(await screen.findByRole("heading", { name: "보낼 기록 1건" })).toBeInTheDocument();
    expect(screen.getByText("구매처 · 대기 중 구매처")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "지금 동기화" })).toBeDisabled();
  });

  it("대기만 있으면 문제가 아닌 상태로 부르고, 명령은 사람이 읽는 말로 보인다", async () => {
    vi.stubGlobal("navigator", { ...navigator, onLine: false });
    await db.outbox.bulkPut([
      {
        idempotency_key: "op-t",
        user_id: "u1",
        entity: "tasting_session",
        op: "action",
        action: "record_tasting",
        entity_id: "t1",
        fields: { bottle_id: "b1", tasted_on: "2026-10-05" },
        created_at: NOW,
        status: "pending",
        error: null,
      },
      {
        idempotency_key: "op-f",
        user_id: "u1",
        entity: "bottle",
        op: "action",
        action: "finish",
        entity_id: "b1",
        fields: {},
        created_at: NOW,
        status: "pending",
        error: null,
      },
    ]);

    renderBadge();
    await userEvent.click(await screen.findByRole("button", { name: "오프라인 (대기 2건)" }));

    expect(await screen.findByRole("dialog", { name: "동기화 상태" })).toBeInTheDocument();
    expect(await screen.findByText("시음 기록 · 2026-10-05")).toBeInTheDocument();
    expect(screen.getByText("병 소진")).toBeInTheDocument();
    expect(screen.queryByText(/record_tasting/)).not.toBeInTheDocument();
  });

  it("실패가 여러 건이면 모두 다시 보내기로 새 명령을 만든다", async () => {
    for (const key of ["f1", "f2"]) {
      await db.outbox.put({
        idempotency_key: key,
        user_id: "u1",
        entity: "vendor",
        op: "create",
        entity_id: `v-${key}`,
        fields: { name: `실패 ${key}` },
        created_at: NOW,
        status: "failed",
        error: "거부됨",
      });
    }
    vi.stubGlobal("navigator", { ...navigator, onLine: false });

    renderBadge();
    await userEvent.click(await screen.findByRole("button", { name: /동기화 실패 2건/ }));
    await userEvent.click(await screen.findByRole("button", { name: "모두 다시 보내기" }));

    await waitFor(async () => {
      const entries = await db.outbox.toArray();
      expect(entries.map((entry) => entry.status)).toEqual(["pending", "pending"]);
      expect(entries.some((entry) => ["f1", "f2"].includes(entry.idempotency_key))).toBe(false);
    });
  });
});

it("따로 보관한 원본은 별도로 알리고 다른 계정 내용을 빼고 내보내며 재시도·폐기는 제공하지 않는다", async () => {
  vi.stubGlobal("navigator", { ...navigator, onLine: false });
  for (const [key, owner, name] of [
    ["unknown-original", "", "내보낼 합성 입력"],
    ["foreign-original", "another-owner", "다른 계정 비공개 입력"],
  ]) {
    await db.outbox.put({
      idempotency_key: key!,
      user_id: owner!,
      entity: "vendor",
      entity_id: key!,
      op: "create",
      fields: { name },
      created_at: NOW,
      status: "pending",
      error: null,
    });
    await quarantineInvalidEntries(quarantineContext());
  }
  let exported: Blob | undefined;
  const create = vi.fn((blob: Blob) => {
    exported = blob;
    return "blob:quarantine-fixture";
  });
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = create;
      static override revokeObjectURL = revoke;
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  renderBadge();
  await userEvent.click(await screen.findByRole("button", { name: "보관한 기록 2건" }));
  expect(await screen.findByRole("heading", { name: "별도로 보관한 기록" })).toBeInTheDocument();
  expect(screen.queryByText("확인할 문제가 없습니다.")).not.toBeInTheDocument();
  expect(screen.queryByText(/다른 계정 비공개 입력/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "건너뛰기" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "입력 수정" })).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /원본.*저장/ })).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "내보낼 수 있는 원본 1건 저장" }));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  const contents = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(exported!);
  });
  expect(contents).toContain("unknown-original");
  expect(contents).toContain('"user_id": ""');
  expect(contents).not.toContain("foreign-original");
  expect(contents).not.toContain("다른 계정 비공개 입력");
  expect(revoke).toHaveBeenCalledWith("blob:quarantine-fixture");
  expect(await db.sync_meta.where("key").startsWith("quarantine:").count()).toBe(2);
});

it("받기에 실패했으면 빈 대기열 패널에서 문제가 없다고 표시하지 않는다", async () => {
  stubRoutes([
    ...authenticatedRoutes(),
    { match: "/sync", method: "GET", status: 500, body: { detail: "합성 연결 오류" } },
  ]);
  renderBadge();
  await userEvent.click(await screen.findByRole("button", { name: "동기화 확인 필요" }));
  expect(await screen.findByRole("dialog", { name: "동기화 문제" })).toBeInTheDocument();
  expect(screen.queryByText("확인할 문제가 없습니다.")).not.toBeInTheDocument();
});

it("원본 읽기 직후 로그아웃하면 내보내기 파일을 만들지 않는다", async () => {
  vi.stubGlobal("navigator", { ...navigator, onLine: false });
  await db.outbox.put({
    idempotency_key: "ownerless-key",
    user_id: "",
    entity: "vendor",
    entity_id: "ownerless-vendor",
    op: "create",
    fields: { name: "합성 입력" },
    created_at: NOW,
    status: "pending",
    error: null,
  });
  await quarantineInvalidEntries(quarantineContext());
  const quarantineModule = await import("@/sync/quarantine");
  const originalExport = quarantineModule.exportQuarantine;
  vi.spyOn(quarantineModule, "exportQuarantine").mockImplementation(async (...args) => {
    const contents = await originalExport(...args);
    lockDatabase();
    return contents;
  });
  const create = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = create;
    },
  );
  renderBadge();
  await userEvent.click(await screen.findByRole("button", { name: "보관한 기록 1건" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "내보낼 수 있는 원본 1건 저장" }),
  );
  expect(
    await screen.findByText("계정이 변경되어 저장을 중단했습니다. 다시 확인하세요"),
  ).toBeInTheDocument();
  expect(create).not.toHaveBeenCalled();
});
