import { afterEach, expect, it, vi } from "vitest";
import {
  applyWaitingUpdate,
  hasDirtyForms,
  markUpdateReady,
  protectFormUpdates,
} from "@/sync/update";

afterEach(() => {
  document.body.innerHTML = "";
});
it("outbox가 비어 있어도 작성 중 폼이 있으면 SW 교체를 미룬다", async () => {
  const stop = protectFormUpdates();
  document.body.innerHTML = '<form><input aria-label="이름"></form>';
  document.querySelector("input")?.dispatchEvent(new Event("input", { bubbles: true }));
  const update = vi.fn(async () => {});
  markUpdateReady(update);
  expect(hasDirtyForms()).toBe(true);
  expect(await applyWaitingUpdate()).toBe(false);
  expect(update).not.toHaveBeenCalled();
  document.querySelector("form")?.remove();
  expect(await applyWaitingUpdate()).toBe(true);
  expect(update).toHaveBeenCalledOnce();
  stop();
});
it("미저장 폼은 페이지 종료 경고를 제공한다", () => {
  const stop = protectFormUpdates();
  document.body.innerHTML = "<form><textarea></textarea></form>";
  document.querySelector("textarea")?.dispatchEvent(new Event("input", { bubbles: true }));
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  stop();
});

it("다른 탭의 SW 활성화도 작성 중인 탭을 강제 새로고침하지 않는다", async () => {
  const { controllerChanged } = await import("@/sync/update");
  const stop = protectFormUpdates();
  document.body.innerHTML = "<form><input></form>";
  document.querySelector("input")?.dispatchEvent(new Event("input", { bubbles: true }));
  const reload = vi.fn();
  controllerChanged(reload);
  expect(reload).not.toHaveBeenCalled();
  document.querySelector("form")?.remove();
  await applyWaitingUpdate();
  expect(reload).toHaveBeenCalledOnce();
  stop();
});
