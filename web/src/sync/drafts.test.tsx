import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { activateDatabase, lockDatabase } from "@/sync/db";
import {
  captureFormDraft,
  clearFormDraft,
  clearSubmittedDraft,
  draftEvents,
  finishSubmission,
  migrateFormDrafts,
  pendingSubmissionRequestId,
  saveSubmissionProgress,
  settleFailedSubmission,
  submissionRequestId,
  submissionSnapshot,
  useDraftState,
} from "@/sync/drafts";

beforeEach(async () => {
  await activateDatabase("draft-owner");
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  lockDatabase();
});
it("폼을 닫거나 저장에 실패해도 같은 탭의 입력을 다시 복원한다", () => {
  const first = renderHook(() => useDraftState("product:create", { name: "" }));
  act(() => first.result.current[1]({ name: "작성 중인 술" }));
  first.unmount();
  const reopened = renderHook(() => useDraftState("product:create", { name: "" }));
  expect(reopened.result.current[0].name).toBe("작성 중인 술");
  reopened.unmount();
  clearFormDraft("product:create");
  const saved = renderHook(() => useDraftState("product:create", { name: "" }));
  expect(saved.result.current[0].name).toBe("");
});
it("계정과 탭이 다른 임시 입력은 덮어쓰거나 보여주지 않는다", async () => {
  sessionStorage.setItem("sooljang-draft-tab", "tab-a");
  const first = renderHook(() => useDraftState("product:create", ""));
  act(() => first.result.current[1]("tab-a-input"));
  first.unmount();
  sessionStorage.setItem("sooljang-draft-tab", "tab-b");
  const second = renderHook(() => useDraftState("product:create", ""));
  expect(second.result.current[0]).toBe("");
  act(() => second.result.current[1]("tab-b-input"));
  second.unmount();
  await activateDatabase("another-owner");
  const other = renderHook(() => useDraftState("product:create", ""));
  expect(other.result.current[0]).toBe("");
  expect(Object.values(localStorage).join()).toContain("tab-a-input");
  expect(Object.values(localStorage).join()).toContain("tab-b-input");
});
it("키나 비밀번호 필드는 draft에 보관하지 않는다", () => {
  const form = renderHook(() => useDraftState("settings", { api_key: "" }));
  act(() => form.result.current[1]({ api_key: "fixture-do-not-persist" })); // scan-secrets-allow: synthetic value verifies secret omission
  expect(Object.values(localStorage).join()).not.toContain("fixture-do-not-persist");
});

it("이전 브라우저 세션의 입력은 새 탭에서 명시적으로 복원할 수 있다", async () => {
  const { recoverableDraft, restoreFormDraft } = await import("@/sync/drafts");
  sessionStorage.setItem("sooljang-draft-tab", "old-session");
  const old = renderHook(() => useDraftState("product:create", { name: "" }));
  act(() => old.result.current[1]({ name: "이전 세션의 입력" }));
  old.unmount();
  sessionStorage.clear();
  const current = renderHook(() => useDraftState("product:create", { name: "" }));
  expect(current.result.current[0].name).toBe("");
  const source = recoverableDraft("product:create");
  expect(source).toBe("old-session");
  act(() => restoreFormDraft("product:create", source ?? ""));
  expect(current.result.current[0].name).toBe("이전 세션의 입력");
  // 한 번 불러온 초안은 다시 권하지 않는다. 다시 뜨면 저장한 뒤 같은 기록을 또 등록할 수 있다.
  expect(recoverableDraft("product:create")).toBeNull();
});

it("열려 있는 다른 탭의 초안을 불러와도 그 탭의 초안은 지우지 않고, 그 탭이 고치면 다시 권한다", async () => {
  const { recoverableDraft, restoreFormDraft } = await import("@/sync/drafts");
  sessionStorage.setItem("sooljang-draft-tab", "live-tab");
  const live = renderHook(() => useDraftState("product:create", { name: "" }));
  act(() => live.result.current[1]({ name: "다른 탭에서 쓰는 중" }));
  sessionStorage.setItem("sooljang-draft-tab", "this-tab");
  const current = renderHook(() => useDraftState("product:create", { name: "" }));
  const source = "sooljang-draft-v1:draft-owner:live-tab:product:create";

  act(() => restoreFormDraft("product:create", recoverableDraft("product:create") ?? ""));

  expect(current.result.current[0].name).toBe("다른 탭에서 쓰는 중");
  expect(JSON.parse(localStorage.getItem(source) ?? "null")?.value).toEqual({
    name: "다른 탭에서 쓰는 중",
  });
  expect(recoverableDraft("product:create")).toBeNull();
  const stored = JSON.parse(localStorage.getItem(source) ?? "null");
  localStorage.setItem(
    source,
    JSON.stringify({ ...stored, value: { name: "이어서 고침" }, updatedAt: stored.updatedAt + 1 }),
  );
  expect(recoverableDraft("product:create")).toBe("live-tab");
});

it("이미 불러온 버전은 복원 요청이 되풀이돼도 이 탭에서 고친 입력을 덮지 않는다", async () => {
  const { restoreFormDraft } = await import("@/sync/drafts");
  const source = "sooljang-draft-v1:draft-owner:other-tab:product:create";
  localStorage.setItem(
    source,
    JSON.stringify({ value: { name: "다른 탭 입력" }, updatedAt: 1, revision: "r1" }),
  );
  sessionStorage.setItem("sooljang-draft-tab", "this-tab");
  const current = renderHook(() => useDraftState("product:create", { name: "" }));
  act(() => restoreFormDraft("product:create", "other-tab"));
  act(() => current.result.current[1]({ name: "이 탭에서 고침" }));

  act(() => restoreFormDraft("product:create", "other-tab"));

  expect(current.result.current[0].name).toBe("이 탭에서 고침");
  localStorage.setItem(
    source,
    JSON.stringify({ value: { name: "다른 탭이 다시 고침" }, updatedAt: 2, revision: "r2" }),
  );
  act(() => restoreFormDraft("product:create", "other-tab"));
  expect(current.result.current[0].name).toBe("다른 탭이 다시 고침");
});

it("30일 넘게 손대지 않은 다른 탭 초안만 정리한다", async () => {
  const { pruneStaleDrafts, STALE_DRAFT_MS } = await import("@/sync/drafts");
  const now = Date.now();
  const put = (tab: string, at: number) =>
    localStorage.setItem(
      `sooljang-draft-v1:draft-owner:${tab}:product:create`,
      JSON.stringify({ value: { name: tab }, updatedAt: at, revision: tab }),
    );
  put("stale-tab", now - STALE_DRAFT_MS - 1);
  put("recent-tab", now - 1000);
  put("current-tab", now - STALE_DRAFT_MS - 1);
  localStorage.setItem("sooljang-draft-v1:draft-owner:broken-tab:product:create", "{");
  localStorage.setItem("sooljang-draft-restored-v1:draft-owner:stale-tab:product:create", "1");
  localStorage.setItem("sooljang-draft-restored-v1:draft-owner:recent-tab:product:create", "1");
  localStorage.setItem("sooljang-draft-restored-v1:draft-owner:gone-tab:product:create", "1");
  sessionStorage.setItem("sooljang-draft-tab", "current-tab");

  pruneStaleDrafts(now);

  const keys = Object.keys(localStorage).join();
  expect(keys).not.toContain("stale-tab");
  expect(keys).toContain("recent-tab");
  expect(keys).toContain("current-tab");
  expect(keys).toContain("broken-tab");
  expect(keys).not.toContain("gone-tab");
  // 불러옴 표시는 원본 초안과 함께 정리된다.
  expect(
    localStorage.getItem("sooljang-draft-restored-v1:draft-owner:recent-tab:product:create"),
  ).toBe("1");
});

it("같은 값을 다시 작성해도 이전 제출 버전으로는 새 초안을 지우지 않는다", () => {
  const form = renderHook(() => useDraftState("tasting:b1:nose", ""));
  act(() => form.result.current[1]("바닐라"));
  const submitted = captureFormDraft("tasting:b1");
  act(() => form.result.current[1]("바닐라"));
  expect(clearSubmittedDraft(submitted)).toBe(false);
  expect(Object.values(localStorage).join()).toContain("바닐라");
  expect(clearSubmittedDraft(captureFormDraft("tasting:b1"))).toBe(true);
  expect(localStorage.length).toBe(0);
});

it("새 필드 입력과 같은 계정의 재로그인도 이전 제출의 초안 정리를 막는다", async () => {
  const form = renderHook(() => useDraftState("purchase:p1:quantity", "1"));
  const emptySubmission = captureFormDraft("purchase:p1");
  act(() => form.result.current[1]("2"));
  expect(clearSubmittedDraft(emptySubmission)).toBe(false);
  const submitted = captureFormDraft("purchase:p1");
  lockDatabase();
  await activateDatabase("draft-owner");
  expect(clearSubmittedDraft(submitted)).toBe(false);
  act(() => form.result.current[1]("99"));
  expect(Object.values(localStorage).join()).toContain('"2"');
  expect(Object.values(localStorage).join()).not.toContain('"99"');
});
it("결과를 확인하기 전에는 내용을 고쳐 다시 보내도 같은 요청 식별자를 쓴다", () => {
  const first = submissionRequestId("purchase:p1");

  expect(submissionRequestId("purchase:p1")).toBe(first);
  expect(submissionRequestId("purchase:p2")).not.toBe(first);
});

it("저장 성공 뒤 같은 내용을 다시 등록하면 새 요청이 된다", () => {
  const saved = submissionRequestId("purchase:p1");
  finishSubmission("purchase:p1", "older-request");
  expect(submissionRequestId("purchase:p1")).toBe(saved);

  finishSubmission("purchase:p1", saved);

  expect(submissionRequestId("purchase:p1")).not.toBe(saved);
});

it("409만 결과 확정으로 보고 다른 실패는 요청 식별자를 유지한다", () => {
  const sent = submissionRequestId("purchase:p1");
  for (const status of [undefined, 401, 422, 500, 503]) {
    settleFailedSubmission("purchase:p1", sent, status);
    expect(submissionRequestId("purchase:p1")).toBe(sent);
  }

  settleFailedSubmission("purchase:p1", sent, 409);

  expect(submissionRequestId("purchase:p1")).not.toBe(sent);
});

it("복제한 탭은 탭 id를 새로 받으므로 다른 요청으로 보낸다", () => {
  sessionStorage.setItem("sooljang-draft-tab", "tab-original");
  const original = submissionRequestId("purchase:p1");
  // 복제 탭은 sessionStorage 를 복사해 오지만 initializeDraftTab 이 탭 id 를 새로 만든다.
  sessionStorage.setItem("sooljang-draft-tab", "tab-duplicate");

  expect(submissionRequestId("purchase:p1")).not.toBe(original);
});

it("다른 계정의 요청 식별자는 이어받지 않는다", async () => {
  const mine = submissionRequestId("product:create");
  lockDatabase();
  await activateDatabase("other-owner");

  expect(submissionRequestId("product:create")).not.toBe(mine);
});

it("등록 진행 기록은 같은 요청과 탭·계정에만 붙고 다른 계정에서 보이지 않는다", async () => {
  const requestId = submissionRequestId("creation-progress");
  saveSubmissionProgress("creation-progress", {
    productId: "saved-product",
    purchaseCreated: true,
  });
  expect(JSON.parse(submissionSnapshot("creation-progress") ?? "null")).toEqual({
    requestId,
    progress: { productId: "saved-product", purchaseCreated: true },
  });
  expect(pendingSubmissionRequestId("creation-progress")).toBe(requestId);
  await activateDatabase("another-owner");
  expect(submissionSnapshot("creation-progress")).toBeNull();
  expect(pendingSubmissionRequestId("creation-progress")).toBeNull();
  lockDatabase();
  expect(() => saveSubmissionProgress("creation-progress", {})).toThrow("보관할 수 없습니다");
});

it("등록 진행 저장 실패는 이전 기록을 지우지 않고 보관 실패를 알린다", () => {
  saveSubmissionProgress("creation-progress", { productId: "saved-product" });
  const saved = submissionSnapshot("creation-progress");
  const failed = vi.fn();
  draftEvents.addEventListener("storage-error", failed);
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("저장 공간 부족", "QuotaExceededError");
  });
  expect(() => saveSubmissionProgress("creation-progress", { completed: true })).toThrow(
    "보관하지 못했습니다",
  );
  expect(failed).toHaveBeenCalledOnce();
  set.mockRestore();
  draftEvents.removeEventListener("storage-error", failed);
  expect(submissionSnapshot("creation-progress")).toBe(saved);
});

it("등록 진행에 비밀을 저장하지 않으며 깨진 요청 식별자는 유효한 진행으로 읽지 않는다", () => {
  expect(() =>
    saveSubmissionProgress("creation-progress", { nested: { apiKey: "never-store" } }),
  ).toThrow("보관할 수 없습니다");
  const id = submissionRequestId("creation-progress");
  const key = Object.keys(sessionStorage).find((key) =>
    sessionStorage.getItem(key)?.includes(id),
  ) as string;
  sessionStorage.setItem(key, "{");
  expect(pendingSubmissionRequestId("creation-progress")).toBeNull();
  const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("읽기 불가");
  });
  expect(submissionSnapshot("creation-progress")).toBeNull();
  get.mockRestore();
});

it("이전 형식 키의 초안을 새 키로 옮기고 새 키에 이미 있는 초안은 덮지 않는다", async () => {
  const prefix = "sooljang-draft-v1:draft-owner:";
  const legacy = (tab: string, hash: string) => `${prefix}${tab}:product:edit:${hash}`;
  const draft = (name: string) => JSON.stringify({ value: { name }, updatedAt: 1 });
  localStorage.setItem(legacy("tab-a", "#products/p1?bottle=b1"), draft("고치던 이름"));
  localStorage.setItem(legacy("tab-b", "#products/p1"), draft("다른 탭 이전 초안"));
  localStorage.setItem(`${prefix}tab-b:product:edit:p1`, draft("새 키 초안"));
  localStorage.setItem(legacy("tab-a", "#products/p10"), draft("다른 제품"));
  const isLegacy = (form: string) =>
    form === "product:edit:#products/p1" || form.startsWith("product:edit:#products/p1?");

  migrateFormDrafts(isLegacy, "product:edit:p1");

  expect(localStorage.getItem(`${prefix}tab-a:product:edit:p1`)).toBe(draft("고치던 이름"));
  expect(localStorage.getItem(legacy("tab-a", "#products/p1?bottle=b1"))).toBeNull();
  expect(localStorage.getItem(`${prefix}tab-b:product:edit:p1`)).toBe(draft("새 키 초안"));
  expect(localStorage.getItem(legacy("tab-b", "#products/p1"))).toBe(draft("다른 탭 이전 초안"));
  expect(localStorage.getItem(legacy("tab-a", "#products/p10"))).toBe(draft("다른 제품"));
});

it("한 탭에 이전 형식 초안이 여럿이면 가장 최근에 고친 초안을 옮긴다", () => {
  const prefix = "sooljang-draft-v1:draft-owner:";
  const legacy = (hash: string) => `${prefix}tab-a:product:edit:${hash}`;
  const draft = (name: string, updatedAt: number) => JSON.stringify({ value: { name }, updatedAt });
  localStorage.setItem(legacy("#products/p1"), draft("먼저 쓴 초안", 1));
  localStorage.setItem(legacy("#products/p1?bottle=b1"), draft("나중에 고친 초안", 2));
  const isLegacy = (form: string) =>
    form === "product:edit:#products/p1" || form.startsWith("product:edit:#products/p1?");

  migrateFormDrafts(isLegacy, "product:edit:p1");

  expect(localStorage.getItem(`${prefix}tab-a:product:edit:p1`)).toBe(draft("나중에 고친 초안", 2));
  expect(localStorage.getItem(legacy("#products/p1?bottle=b1"))).toBeNull();
});
