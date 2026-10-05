/**
 * 로딩·빈 상태·오류 표시. 화면마다 `<output>`·`.alert`·`<p>` 가 섞여 있던 것을 세 가지로
 * 통일한다 — 같은 상황은 같은 모양과 같은 보조기술 의미(상태/경고)를 갖는다.
 */

import type { ReactNode } from "react";

/** 불러오는 중. 자리만 잡아 화면이 튀지 않게 하고 스크린리더에는 상태로 알린다. */
export function LoadingState({
  label = "불러오는 중…",
  lines = 3,
}: {
  label?: string;
  lines?: number;
}) {
  return (
    <div className="loading-state">
      <output aria-live="polite">{label}</output>
      {Array.from({ length: lines }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 내용 없는 자리표시 줄이다
        <span key={index} className="skeleton-line" aria-hidden="true" />
      ))}
    </div>
  );
}

/** 보여줄 것이 없을 때. 다음에 할 일을 버튼으로 함께 준다. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <p className="empty-state-title">{title}</p>
      {children ? <p className="muted">{children}</p> : null}
      {action ? <div className="button-row">{action}</div> : null}
    </div>
  );
}

/** 불러오기·저장 실패. 다시 시도할 수 있으면 버튼을 붙인다. */
export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="inline-error" role="alert">
      <span>{message}</span>
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          다시 시도
        </button>
      ) : null}
    </div>
  );
}
