/**
 * 화면 하단 알림과 "실행 취소".
 *
 * 여러 병을 한 번에 바꾸는 동작에 매번 확인창을 띄우면 손이 많이 간다. 대신 바로 반영하고
 * 몇 초 동안 되돌릴 기회를 준다(되돌리기는 역방향 명령을 보낸다 — 기록을 지우지 않는다).
 */

import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";

export interface ToastInput {
  message: string;
  /** 있으면 버튼을 하나 보여준다(예: "실행 취소"). */
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
  tone?: "info" | "warn" | "error";
  /** 기본 8초. 실행 취소가 있으면 조금 더 길게 둔다. */
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastApi {
  show: (toast: ToastInput) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => undefined });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const show = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++;
      // 같은 자리에 쌓이면 읽기 어렵다. 최근 3개만 남긴다.
      setItems((current) => [...current.slice(-2), { ...toast, id }]);
      const duration = toast.durationMs ?? (toast.onAction ? 10_000 : 6_000);
      window.setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="toast-region" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast toast-${item.tone ?? "info"}`}>
            <span>{item.message}</span>
            {item.onAction && item.actionLabel ? (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  dismiss(item.id);
                  // 실행 취소가 실패하면(그 사이 병이 지워짐 등) 조용히 묻지 않고 알린다.
                  void Promise.resolve()
                    .then(() => item.onAction?.())
                    .catch((error: unknown) =>
                      show({
                        message: error instanceof Error ? error.message : "되돌리지 못했습니다",
                        tone: "error",
                      }),
                    );
                }}
              >
                {item.actionLabel}
              </button>
            ) : null}
            <button
              type="button"
              className="toast-close"
              aria-label="알림 닫기"
              onClick={() => dismiss(item.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
