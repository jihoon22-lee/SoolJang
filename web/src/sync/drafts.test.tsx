import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { activateDatabase, lockDatabase } from "@/sync/db";
import {
  captureFormDraft,
  clearFormDraft,
  clearSubmittedDraft,
  useDraftState,
} from "@/sync/drafts";

beforeEach(async () => {
  await activateDatabase("draft-owner");
});
afterEach(() => {
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
