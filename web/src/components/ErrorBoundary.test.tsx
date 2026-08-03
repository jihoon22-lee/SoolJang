import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "@/components/ErrorBoundary";

function Boom(): never {
  throw new Error("의도된 테스트 오류");
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    // React 가 콘솔에 남기는 개발용 오류 로그(우리가 의도적으로 던진 것)로 테스트 출력이
    // 지저분해지는 것을 막는다.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("자식이 정상이면 그대로 렌더한다", () => {
    render(
      <ErrorBoundary>
        <p>정상 화면</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText("정상 화면")).toBeInTheDocument();
  });

  it("렌더 중 예외를 잡아 복구 안내를 보여준다", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("heading", { name: "문제가 발생했습니다" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("의도된 테스트 오류");
  });

  it("새로고침 버튼이 페이지를 다시 불러온다", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    await userEvent.click(screen.getByRole("button", { name: "새로고침" }));

    expect(reload).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
