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

  it("이어서 할 동작 여럿을 함께 보이고 누른 동작만 부른다", async () => {
    const edit = vi.fn();
    const again = vi.fn();
    function Multi() {
      const toast = useToast();
      return (
        <button
          type="button"
          onClick={() =>
            toast.show({
              message: "시음을 기록했습니다",
              actions: [
                { label: "고치기", onAction: edit },
                { label: "한 잔 더", onAction: again },
              ],
            })
          }
        >
          알림
        </button>
      );
    }
    renderWithQuery(
      <ToastProvider>
        <Multi />
      </ToastProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "알림" }));
    expect(screen.getByRole("button", { name: "고치기" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "한 잔 더" }));

    expect(again).toHaveBeenCalledOnce();
    expect(edit).not.toHaveBeenCalled();
    expect(screen.queryByText("시음을 기록했습니다")).not.toBeInTheDocument();
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

  it("단추에 초점이 있는 동안은 닫지 않고 초점이 떠나면 다시 센다", () => {
    vi.useFakeTimers();
    renderWithQuery(
      <ToastProvider>
        <Trigger onAction={async () => undefined} />
      </ToastProvider>,
    );

    act(() => screen.getByRole("button", { name: "알림" }).click());
    act(() => screen.getByRole("button", { name: "실행 취소" }).focus());
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByText("3병 소진 처리")).toBeInTheDocument();

    act(() => screen.getByRole("button", { name: "알림" }).focus());
    act(() => vi.advanceTimersByTime(9_000));
    expect(screen.getByText("3병 소진 처리")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1_100));
    expect(screen.queryByText("3병 소진 처리")).not.toBeInTheDocument();
  });

  it("돌려받은 함수로 띄운 알림을 거둔다", () => {
    let dismiss = () => {};
    function Owner() {
      const toast = useToast();
      return (
        <button type="button" onClick={() => (dismiss = toast.show({ message: "한 잔 기록" }))}>
          알림
        </button>
      );
    }
    renderWithQuery(
      <ToastProvider>
        <Owner />
      </ToastProvider>,
    );

    act(() => screen.getByRole("button", { name: "알림" }).click());
    expect(screen.getByText("한 잔 기록")).toBeInTheDocument();
    act(() => dismiss());
    expect(screen.queryByText("한 잔 기록")).not.toBeInTheDocument();
  });

  it("화면이 사라지면 남은 닫기 타이머를 지운다", () => {
    vi.useFakeTimers();
    const view = renderWithQuery(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    act(() => screen.getByRole("button", { name: "알림" }).click());
    expect(vi.getTimerCount()).toBe(1);

    view.unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("공급자가 없으면 아무것도 하지 않는다", async () => {
    renderWithQuery(<Trigger />);
    await userEvent.click(screen.getByRole("button", { name: "알림" }));
    expect(screen.queryByText("3병 소진 처리")).not.toBeInTheDocument();
  });
});
