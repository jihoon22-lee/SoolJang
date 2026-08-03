/**
 * 렌더 중 예외를 잡아 백지 화면 대신 복구 안내를 보여준다.
 *
 * 클래스 컴포넌트여야 한다 — React 는 아직 `getDerivedStateFromError`/`componentDidCatch`
 * 를 대체할 훅을 제공하지 않는다. 이 경계가 없으면 렌더 중 예외 하나로 전체 트리가
 * 언마운트돼 새로고침 외에는 복구할 방법이 없는 백지 화면이 된다.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("렌더 중 처리되지 않은 오류", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="auth-screen">
        <div className="auth-card">
          <h1>문제가 발생했습니다</h1>
          <p className="auth-hint">
            화면을 표시하는 중 오류가 났습니다. 새로고침하면 대부분 복구됩니다.
          </p>
          <p className="auth-error" role="alert">
            {error.message || "알 수 없는 오류"}
          </p>
          <button type="button" className="primary" onClick={() => window.location.reload()}>
            새로고침
          </button>
        </div>
      </main>
    );
  }
}
