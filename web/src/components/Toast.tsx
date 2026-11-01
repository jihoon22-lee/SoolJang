/**
 * 화면 하단 알림과 "실행 취소".
 *
 * 여러 병을 한 번에 바꾸는 동작에 매번 확인창을 띄우면 손이 많이 간다. 대신 바로 반영하고
 * 몇 초 동안 되돌릴 기회를 준다(되돌리기는 역방향 명령을 보낸다 — 기록을 지우지 않는다).
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

export interface ToastAction {
  label: string;
  onAction: () => void | Promise<void>;
}

export interface ToastInput {
  message: string;
  /** 있으면 버튼을 하나 보여준다(예: "실행 취소"). */
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
  /** 이어서 할 일을 여럿 보일 때(예: 시음 저장 뒤 고치기·한 잔 더·보기). */
  actions?: ToastAction[];
  tone?: "info" | "warn" | "error";
  /** 기본 8초. 실행 취소가 있으면 조금 더 길게 둔다. */
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: number;
  duration: number;
}

interface ToastApi {
  /** 띄운 알림을 닫는 함수를 돌려준다. 이어지는 동작을 가진 화면이 사라질 때 거둔다. */
  show: (toast: ToastInput) => () => void;
}

const ToastContext = createContext<ToastApi>({ show: () => () => undefined });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());
  // 화면(또는 테스트 환경)이 사라진 뒤 남은 타이머가 상태를 바꾸지 않게 한다.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const pause = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      pause(id);
      setItems((current) => current.filter((item) => item.id !== id));
    },
    [pause],
  );

  const schedule = useCallback(
    (id: number, duration: number) => {
      pause(id);
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), duration),
      );
    },
    [dismiss, pause],
  );

  const show = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++;
      const duration =
        toast.durationMs ?? (toast.onAction || toast.actions?.length ? 10_000 : 6_000);
      // 같은 자리에 쌓이면 읽기 어렵다. 최근 3개만 남긴다.
      setItems((current) => [...current.slice(-2), { ...toast, id, duration }]);
      schedule(id, duration);
      return () => dismiss(id);
    },
    [dismiss, schedule],
  );

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="toast-region" aria-live="polite">
        {items.map((item) => (
          // 읽거나 키보드로 단추까지 가는 동안에는 닫지 않고, 벗어나면 처음 시간부터 다시 센다.
          // biome-ignore lint/a11y/noStaticElementInteractions: 포인터·초점은 자동 닫힘 타이머만 멈춘다(동작은 안의 단추)
          <div
            key={item.id}
            className={`toast toast-${item.tone ?? "info"}${item.actions?.length ? " toast-stacked" : ""}`}
            onPointerEnter={() => pause(item.id)}
            onPointerLeave={(event) => {
              if (!event.currentTarget.contains(document.activeElement))
                schedule(item.id, item.duration);
            }}
            onFocus={() => pause(item.id)}
            onBlur={(event) => {
              const next = event.relatedTarget;
              if (!(next instanceof Node && event.currentTarget.contains(next)))
                schedule(item.id, item.duration);
            }}
          >
            <span className="toast-message">{item.message}</span>
            {[
              ...(item.onAction && item.actionLabel
                ? [{ label: item.actionLabel, onAction: item.onAction, undo: true }]
                : []),
              ...(item.actions ?? []).map((action) => ({ ...action, undo: false })),
            ].map((action) => (
              <button
                key={action.label}
                type="button"
                className="toast-action"
                onClick={() => {
                  dismiss(item.id);
                  // 실행 취소가 실패하면(그 사이 병이 지워짐 등) 조용히 묻지 않고 알린다.
                  void Promise.resolve()
                    .then(() => action.onAction())
                    .catch((error: unknown) =>
                      show({
                        message:
                          error instanceof Error
                            ? error.message
                            : action.undo
                              ? "되돌리지 못했습니다"
                              : "요청한 동작을 마치지 못했습니다",
                        tone: "error",
                      }),
                    );
                }}
              >
                {action.label}
              </button>
            ))}
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
