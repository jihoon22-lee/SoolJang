import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "@/components/Toast";
import { renderWithQuery } from "@/testing";

function Trigger({ onAction }: { onAction?: () => Promise<void> }) {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() =>
        toast.show({
          message: "3병 소진 처리",
          ...(onAction ? { actionLabel: "실행 취소", onAction } : {}),
        })
      }
    >
      알림
    </button>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ToastProvider", () => {
  it("실행 취소를 누르면 동작을 부르고 알림을 닫는다", async () => {
    const onAction = vi.fn(async () => undefined);
    renderWithQuery(
      <ToastProvider>
        <Trigger onAction={onAction} />
      </ToastProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "알림" }));
    await userEvent.click(screen.getByRole("button", { name: "실행 취소" }));

    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.queryByText("3병 소진 처리")).not.toBeInTheDocument();
  });

  it("실행 취소가 실패하면 오류를 알린다", async () => {
    renderWithQuery(
      <ToastProvider>
        <Trigger onAction={async () => Promise.reject(new Error("이미 지운 병입니다"))} />
      </ToastProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "알림" }));
    await userEvent.click(screen.getByRole("button", { name: "실행 취소" }));

    expect(await screen.findByText("이미 지운 병입니다")).toBeInTheDocument();
  });

  it("정해진 시간이 지나면 저절로 사라진다", () => {
    vi.useFakeTimers();
    renderWithQuery(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );

    act(() => screen.getByRole("button", { name: "알림" }).click());
    expect(screen.getByText("3병 소진 처리")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(6_100));
    expect(screen.queryByText("3병 소진 처리")).not.toBeInTheDocument();
  });

  it("공급자가 없으면 아무것도 하지 않는다", async () => {
    renderWithQuery(<Trigger />);
    await userEvent.click(screen.getByRole("button", { name: "알림" }));
    expect(screen.queryByText("3병 소진 처리")).not.toBeInTheDocument();
  });
});
