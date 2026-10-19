/**
 * 되돌리기 어려운 동작 앞의 공용 확인창.
 *
 * `window.confirm` 은 앱 스타일·포커스 관리 밖이라 설치형 PWA 에서 브라우저 주소가 함께
 * 찍히고, 동기화 패널처럼 이미 열린 모달 위에서는 어떤 화면에 대한 확인인지 흐려졌다.
 * `useConfirm()` 이 돌려주는 함수는 사용자가 고를 때까지 기다렸다 `true`/`false` 로 끝난다.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useModalDialog } from "@/useModalDialog";

export interface ConfirmOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  danger?: boolean;
  /**
   * 닫힌 뒤 포커스를 돌릴 요소. 기본은 확인창을 연 요소다. 그 요소가 곧 사라지면(접히는 메뉴 안
   * 버튼) 메뉴를 연 버튼처럼 남아 있는 요소를 준다.
   */
  returnFocus?: HTMLElement | null;
}

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

// Provider 밖(컴포넌트만 따로 그리는 테스트)에서는 브라우저 확인창으로 동작한다.
const ConfirmContext = createContext<Confirm>((options) =>
  Promise.resolve(window.confirm(options.message)),
);

export function useConfirm(): Confirm {
  return useContext(ConfirmContext);
}

interface Pending {
  id: number;
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
  returnFocus: HTMLElement | null;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const nextId = useRef(0);

  const confirm = useCallback<Confirm>(
    (options) =>
      new Promise<boolean>((resolve) => {
        // 확인창은 한 번에 하나다. 앞선 요청은 취소로 끝내 기다리는 쪽이 멈추지 않게 한다.
        pendingRef.current?.resolve(false);
        const active = document.activeElement;
        nextId.current += 1;
        const next = {
          id: nextId.current,
          options,
          resolve,
          returnFocus: options.returnFocus ?? (active instanceof HTMLElement ? active : null),
        };
        pendingRef.current = next;
        setPending(next);
      }),
    [],
  );

  const close = useCallback((confirmed: boolean) => {
    pendingRef.current?.resolve(confirmed);
    pendingRef.current = null;
    setPending(null);
  }, []);

  // 확인창이 떠 있는 채로 화면이 사라지면 기다리던 쪽을 취소로 끝낸다.
  useEffect(() => () => pendingRef.current?.resolve(false), []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {/* 요청마다 새로 그려 앞선 확인창의 복귀 위치를 이어받지 않는다. */}
      {pending ? <ConfirmSheet key={pending.id} pending={pending} onClose={close} /> : null}
    </ConfirmContext.Provider>
  );
}

function ConfirmSheet({
  pending,
  onClose,
}: {
  pending: Pending;
  onClose: (confirmed: boolean) => void;
}) {
  const returnFocusRef = useRef(pending.returnFocus);
  const dialogRef = useModalDialog(returnFocusRef);
  const { message, title = "확인", confirmLabel = "확인", danger = false } = pending.options;

  useEffect(() => {
    // 배경을 눌러 포커스가 body 로 빠져도 Escape 는 확인창만 닫는다. document 캡처 단계에서 받아
    // 아래에 열린 패널(동기화 상태 등)의 document Escape 닫기까지 번지지 않게 한다.
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose(false);
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    // 바깥 클릭으로 닫히는 패널 위에서 열려도, 확인창을 누른 것은 그 패널의 바깥 클릭이 아니다.
    <div className="sheet-backdrop" onPointerDown={(event) => event.stopPropagation()}>
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        tabIndex={-1}
        className="bottom-sheet confirm-sheet"
      >
        <h2 id="confirm-dialog-title" className="mb-0">
          {title}
        </h2>
        <p id="confirm-dialog-message">{message}</p>
        <div className="button-row">
          <button type="button" onClick={() => onClose(false)}>
            취소
          </button>
          <button
            type="button"
            className={danger ? "danger" : "primary"}
            onClick={() => onClose(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
