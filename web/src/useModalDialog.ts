import { type RefObject, useEffect, useRef } from "react";

/**
 * `role="dialog"` 모달의 키보드·포커스 동작을 담당하는 훅.
 *
 * React 는 아직 `<dialog>`/포커스 트랩을 대체할 내장 훅이 없어 직접 구현한다. 범위는
 * 1) 열리자마자 패널로 포커스 이동, 2) `Tab`/`Shift+Tab` 이 패널 안에서만 순환하는
 * 포커스 트랩, 3) 언마운트(닫힘) 시 트리거로 포커스 복귀다.
 *
 * 바깥 클릭·Escape 닫기는 호출자가 처리한다(이 훅은 `onClose` 를 받지 않는다) — 그
 * 판단은 트리거 버튼이 패널의 형제인지(바깥 클릭 범위를 트리거까지 포함해야 하는지)에
 * 따라 달라져서, `App.tsx` 설정 메뉴처럼 "패널 + 트리거를 감싼 컨테이너" 를 기준으로
 * 잡는 게 자연스럽다. 분리해 두면 이 훅은 포커스 의미론에만 집중한다.
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export function useModalDialog<T extends HTMLElement>(
  returnFocusRef?: RefObject<T | null>,
): RefObject<HTMLDivElement | null> {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // 열리자마자 포커스를 패널로 옮긴다. 스크린리더가 다이얼로그 내용을 즉시 읽게 한다.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // 포커스 트랩: Tab 은 패널 안의 포커스 가능한 요소끼리만 순환한다. 패널 컨테이너
  // (tabIndex=-1)나 마지막 요소에서 Tab 을 누르면 첫 요소로, 첫 요소에서 Shift+Tab
  // 이면 마지막 요소로 되돌린다.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || active === dialog || !dialog.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !dialog.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // 닫힐 때(언마운트) 트리거로 포커스를 돌려준다. 키보드·스크린리더 사용자가 닫기
  // 전 위치를 잃지 않게 한다.
  useEffect(() => {
    return () => returnFocusRef?.current?.focus();
  }, [returnFocusRef]);

  return dialogRef;
}
