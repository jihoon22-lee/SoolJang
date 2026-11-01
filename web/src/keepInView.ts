/**
 * 다른 화면에서 건너온 목적지(시음 정정 폼·구매 추가 폼)를 화면 위쪽에 붙들어 둔다.
 *
 * 목적지 위의 병·이력 목록은 뒤늦게 불러와져 자란다. 브라우저 스크롤 앵커는 목적지가 아니라
 * 위쪽 목록에 붙을 수 있어, 토스트 "고치기"로 연 정정 폼이 첫 화면 아래로 밀렸다. 잠시 동안
 * 페이지 크기 변화를 지켜보며 밀린 목적지를 제자리로 되돌린다. 초점은 건드리지 않고(입력·IME
 * 보존), 사용자가 화면을 누르거나 굴리거나 키를 누르면 바로 놓는다.
 */
const RELEASE_EVENTS = ["pointerdown", "touchstart", "wheel", "keydown"] as const;
/** 이보다 적게 움직인 것은 반올림 차이로 보고 다시 옮기지 않는다. */
const DRIFT_PX = 4;

function place(target: HTMLElement): number {
  target.scrollIntoView?.({ block: "start" });
  return target.getBoundingClientRect().top;
}

/** 목적지로 옮기고, 지켜보기를 멈추는 함수를 돌려준다(화면이 사라지거나 목적지가 바뀔 때). */
export function keepInView(target: HTMLElement, holdMs = 3_000): () => void {
  let placed = place(target);
  if (typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver(() => {
    if (Math.abs(target.getBoundingClientRect().top - placed) > DRIFT_PX) placed = place(target);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    observer.disconnect();
    clearTimeout(timer);
    for (const type of RELEASE_EVENTS) window.removeEventListener(type, release, true);
  };
  observer.observe(target.closest("main") ?? document.body);
  timer = setTimeout(release, holdMs);
  for (const type of RELEASE_EVENTS) {
    window.addEventListener(type, release, { capture: true, passive: true });
  }
  return release;
}
