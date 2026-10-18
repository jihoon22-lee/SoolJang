import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef, useState } from "react";
import { expect, it, vi } from "vitest";
import { ConfirmProvider, useConfirm } from "@/components/ConfirmDialog";
import { useModalDialog } from "@/useModalDialog";

function Trigger({ onResult }: { onResult: (confirmed: boolean) => void }) {
  const confirm = useConfirm();
  return (
    <button
      type="button"
      onClick={() =>
        void confirm({
          title: "구매 기록 삭제",
          message: "삭제할까요?",
          confirmLabel: "삭제",
          danger: true,
        }).then(onResult)
      }
    >
      지우기
    </button>
  );
}

it("확인을 누르면 true로 끝나고 닫힌 뒤 누른 버튼으로 포커스를 돌린다", async () => {
  const onResult = vi.fn();
  render(
    <ConfirmProvider>
      <Trigger onResult={onResult} />
    </ConfirmProvider>,
  );

  await userEvent.click(screen.getByRole("button", { name: "지우기" }));
  const dialog = screen.getByRole("alertdialog", { name: "구매 기록 삭제" });
  expect(dialog).toHaveAccessibleDescription("삭제할까요?");
  expect(dialog).toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: "삭제" }));

  await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "지우기" })).toHaveFocus();
});

it("취소·Escape는 false로 끝난다", async () => {
  const onResult = vi.fn();
  render(
    <ConfirmProvider>
      <Trigger onResult={onResult} />
    </ConfirmProvider>,
  );

  await userEvent.click(screen.getByRole("button", { name: "지우기" }));
  await userEvent.click(screen.getByRole("button", { name: "취소" }));
  await userEvent.click(screen.getByRole("button", { name: "지우기" }));
  await userEvent.keyboard("{Escape}");

  await waitFor(() => expect(onResult.mock.calls).toEqual([[false], [false]]));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

function PanelWithConfirm() {
  const [open, setOpen] = useState(true);
  const confirm = useConfirm();
  const ref = useRef<HTMLButtonElement>(null);
  return open ? (
    <Panel
      onEscape={() => setOpen(false)}
      onAsk={() => void confirm({ message: "건너뛸까요?" })}
      returnFocusRef={ref}
    />
  ) : (
    <p>패널 닫힘</p>
  );
}

function Panel({
  onEscape,
  onAsk,
  returnFocusRef,
}: {
  onEscape: () => void;
  onAsk: () => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useModalDialog(returnFocusRef);
  // 동기화 패널처럼 document 수준에서 Escape·바깥 클릭을 듣는 패널.
  useCloseOnOutside(onEscape);
  return (
    <div ref={dialogRef} role="dialog" aria-label="동기화" tabIndex={-1}>
      <button type="button" onClick={onAsk}>
        건너뛰기
      </button>
      <button type="button">다시 보내기</button>
    </div>
  );
}

function useCloseOnOutside(onClose: () => void) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    function onPointerDown(event: PointerEvent) {
      if (!(event.target as Element).closest('[role="dialog"]')) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose]);
}

it("다른 모달 위에서 열려도 아래 패널을 닫지 않고 Tab을 확인창 안에 가둔다", async () => {
  render(
    <ConfirmProvider>
      <PanelWithConfirm />
    </ConfirmProvider>,
  );

  await userEvent.click(screen.getByRole("button", { name: "건너뛰기" }));
  const confirmDialog = screen.getByRole("alertdialog");
  await userEvent.tab();
  await userEvent.tab();
  await userEvent.tab();
  expect(confirmDialog).toContainElement(document.activeElement as HTMLElement);
  await userEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(screen.getByRole("dialog", { name: "동기화" })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "건너뛰기" }));
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "동기화" })).toBeInTheDocument();
});
