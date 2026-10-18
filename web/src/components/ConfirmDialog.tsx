/**
 * 되돌리기 어려운 동작 앞의 공용 확인창.
 *
 * `window.confirm` 은 앱 스타일·포커스 관리 밖이라 설치형 PWA 에서 브라우저 주소가 함께
 * 찍히고, 동기화 패널처럼 이미 열린 모달 위에서는 어떤 화면에 대한 확인인지 흐려졌다.
 * `useConfirm()` 이 돌려주는 함수는 사용자가 고를 때까지 기다렸다 `true`/`false` 로 끝난다.
 */

import {
  createContext,
  type KeyboardEvent,
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
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
  returnFocus: HTMLElement | null;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  const confirm = useCallback<Confirm>(
    (options) =>
      new Promise<boolean>((resolve) => {
        // 확인창은 한 번에 하나다. 앞선 요청은 취소로 끝내 기다리는 쪽이 멈추지 않게 한다.
        pendingRef.current?.resolve(false);
        const active = document.activeElement;
        const next = {
          options,
          resolve,
          returnFocus: active instanceof HTMLElement ? active : null,
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
      {pending ? <ConfirmSheet pending={pending} onClose={close} /> : null}
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

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    // 아래에 열린 패널(동기화 상태 등)의 Escape 닫기까지 번지지 않게 한다.
    event.stopPropagation();
    onClose(false);
  }

  return (
    // 바깥 클릭으로 닫히는 패널 위에서 열려도, 확인창을 누른 것은 그 패널의 바깥 클릭이 아니다.
    // biome-ignore lint/a11y/noStaticElementInteractions: 이벤트 전파만 막는 배경이다.
    <div
      className="sheet-backdrop"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
    >
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
