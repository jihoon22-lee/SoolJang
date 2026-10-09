import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { Bottle } from "@/api/types";
import { RemainingEditor } from "@/components/RemainingEditor";
import { activateDatabase, db } from "@/sync/db";

const row = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  user_id: "remaining",
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
  deleted_at: null,
  ...fields,
});
const bottle: Bottle = {
  id: "b",
  purchase_id: "p",
  label_no: 1,
  status: "open",
  opened_on: null,
  finished_on: null,
  remaining_ml: 450,
  storage_location: null,
  note: null,
};
beforeEach(async () => {
  await activateDatabase("remaining");
  for (const table of db.tables) await table.clear();
  await db.sku.bulkPut([row("s500", { volume_ml: 500 }), row("s750", { volume_ml: 750 })]);
  await db.purchase.put(row("p", { sku_id: "s500" }));
  await db.bottle.put(row("b", { purchase_id: "p" }));
});
it("같은 병의 구매 규격이 정정되면 다시 열지 않아도 최신 용량으로 잔량을 입력한다", async () => {
  const onSet = vi.fn();
  render(<RemainingEditor bottle={bottle} onSet={onSet} />);
  await userEvent.click(screen.getByRole("button", { name: "잔량 조정" }));
  await screen.findByLabelText("남은 양(ml) · 최대 500ml");
  await db.purchase.update("p", { sku_id: "s750" });
  const input = await screen.findByLabelText("남은 양(ml) · 최대 750ml");
  fireEvent.change(input, { target: { value: "650" } });
  await userEvent.click(screen.getByRole("button", { name: "저장" }));
  expect(onSet).toHaveBeenCalledWith(650);
});
it("규격 축소 뒤 상한을 넘는 작성 중 잔량은 보존하되 저장하지 않는다", async () => {
  await db.purchase.update("p", { sku_id: "s750" });
  render(<RemainingEditor bottle={bottle} onSet={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "잔량 조정" }));
  fireEvent.change(await screen.findByLabelText("남은 양(ml) · 최대 750ml"), {
    target: { value: "650" },
  });
  await db.purchase.update("p", { sku_id: "s500" });
  expect(await screen.findByLabelText("남은 양(ml) · 최대 500ml")).toHaveValue(650);
  await waitFor(() => expect(screen.getByRole("button", { name: "저장" })).toBeDisabled());
});
