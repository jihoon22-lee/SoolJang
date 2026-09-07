/** SW 교체는 폼 입력이 끝날 때까지 미룬다. outbox와 폼 dirty 상태는 별개다. */
export const updateEvents = new EventTarget();
let updateReady = false;
let applyUpdate: (() => Promise<void>) | null = null;
const dirtyForms = new Set<HTMLFormElement>();
export function markFormDirty(form: HTMLFormElement): void {
  dirtyForms.add(form);
  updateEvents.dispatchEvent(new Event("change"));
}
export function hasDirtyForms(): boolean {
  for (const form of dirtyForms) if (!form.isConnected) dirtyForms.delete(form);
  return dirtyForms.size > 0;
}
export function markUpdateReady(update: () => Promise<void>): void {
  applyUpdate = update;
  updateReady = true;
  updateEvents.dispatchEvent(new Event("change"));
}
/** 다른 탭이 SW를 활성화해도 이 탭의 dirty 폼은 자동 새로고침하지 않는다. */
export function controllerChanged(reload: () => void): void {
  if (hasDirtyForms()) markUpdateReady(async () => reload());
  else reload();
}
export function isUpdateReady(): boolean {
  return updateReady;
}
export async function applyWaitingUpdate(): Promise<boolean> {
  if (!applyUpdate || hasDirtyForms()) return false;
  await applyUpdate();
  return true;
}
export function protectFormUpdates(): () => void {
  const input = (event: Event) => {
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      if (target.form) dirtyForms.add(target.form);
      updateEvents.dispatchEvent(new Event("change"));
    }
  };
  const reset = (event: Event) => {
    if (event.target instanceof HTMLFormElement) dirtyForms.delete(event.target);
    updateEvents.dispatchEvent(new Event("change"));
  };
  const unload = (event: BeforeUnloadEvent) => {
    if (hasDirtyForms()) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  document.addEventListener("input", input, true);
  document.addEventListener("change", input, true);
  document.addEventListener("reset", reset, true);
  window.addEventListener("beforeunload", unload);
  return () => {
    document.removeEventListener("input", input, true);
    document.removeEventListener("change", input, true);
    document.removeEventListener("reset", reset, true);
    window.removeEventListener("beforeunload", unload);
    dirtyForms.clear();
  };
}
