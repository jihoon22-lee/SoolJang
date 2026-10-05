import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EmptyState, InlineError, LoadingState } from "@/components/StatusViews";
import { renderWithQuery } from "@/testing";

describe("StatusViews", () => {
  it("로딩은 상태로, 오류는 경고로 알리고 다시 시도할 수 있다", async () => {
    const onRetry = vi.fn();
    renderWithQuery(
      <>
        <LoadingState label="불러오는 중…" />
        <InlineError message="불러오지 못했습니다" onRetry={onRetry} />
        <EmptyState title="아직 없습니다" action={<button type="button">추가</button>}>
          처음 기록을 남겨 보세요.
        </EmptyState>
      </>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("불러오는 중…");
    expect(screen.getByRole("alert")).toHaveTextContent("불러오지 못했습니다");
    await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByText("처음 기록을 남겨 보세요.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "추가" })).toBeInTheDocument();
  });
});
