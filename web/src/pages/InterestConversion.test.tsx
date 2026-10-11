import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { productsApi, vendorsApi } from "@/api/client";
import { type Interest, interestsApi } from "@/api/interests";
import { InterestsPage } from "@/pages/InterestsPage";
import { activateDatabase, lockDatabase } from "@/sync/db";
import { renderWithQuery } from "@/testing";

const sync = vi.hoisted(() => vi.fn());
vi.mock("@/sync/SyncStatusProvider", () => ({
  useSyncStatus: () => ({ state: "idle", triggerSync: sync }),
}));
const item: Interest = {
  id: "late-interest",
  name: "합성 관심",
  identity: { name: "합성 관심", volumes_ml: [700] },
  note: null,
  source_matches: {},
  archived: false,
  product_id: null,
  updated_at: "2026-10-11T00:00:00Z",
};
const receipt = {
  interest_id: item.id,
  purchase_id: "saved-purchase",
  product_id: "saved-product",
};
const draftKey = () =>
  Object.keys(localStorage).find((key) => key.endsWith(`:interest-purchase:${item.id}`));
beforeEach(async () => {
  localStorage.clear();
  await activateDatabase("conversion-owner");
  sync.mockClear();
  vi.spyOn(interestsApi, "list").mockResolvedValue([item]);
  vi.spyOn(interestsApi, "purchase").mockResolvedValue(receipt);
  vi.spyOn(productsApi, "list").mockResolvedValue({ items: [], next_cursor: null });
  vi.spyOn(vendorsApi, "list").mockResolvedValue([]);
});
afterEach(() => {
  lockDatabase();
  localStorage.clear();
  vi.restoreAllMocks();
});
async function openForm() {
  const navigate = vi.fn();
  const view = renderWithQuery(<InterestsPage onSelectProduct={navigate} />);
  const row = (await screen.findByRole("heading", { name: item.name })).closest("li");
  if (!row) throw new Error("관심 행 없음");
  await userEvent.click(within(row).getByRole("button", { name: "구매 전환" }));
  await userEvent.selectOptions(screen.getByLabelText("등록 방식"), "new");
  return { ...view, navigate };
}
async function submit() {
  await userEvent.click(screen.getByLabelText("제품·판본·규격과 실제 구매 내용을 확인했습니다"));
  await userEvent.click(screen.getByRole("button", { name: "구매와 병 생성" }));
  await waitFor(() => expect(interestsApi.purchase).toHaveBeenCalled());
}
function deferPurchase() {
  let finish: ((value: typeof receipt) => void) | undefined;
  const pending = new Promise<typeof receipt>((resolve) => {
    finish = resolve;
  });
  vi.mocked(interestsApi.purchase).mockReturnValueOnce(pending);
  return async () => {
    if (!finish) throw new Error("응답 대기 없음");
    await act(async () => {
      finish?.(receipt);
      await pending;
    });
  };
}

it("A계정의 늦은 구매 완료가 B계정 초안·동기화·이동을 건드리지 않는다", async () => {
  const finish = deferPurchase();
  const view = await openForm();
  await submit();
  const key = draftKey();
  if (!key) throw new Error("제출 초안 없음");
  await activateDatabase("next-conversion-owner");
  const otherKey = key.replace(":conversion-owner:", ":next-conversion-owner:");
  const nextDraft = JSON.stringify({
    value: { name: "B계정 새 입력" },
    updatedAt: 1,
    revision: "new",
  });
  localStorage.setItem(otherKey, nextDraft);
  await finish();
  expect(localStorage.getItem(otherKey)).toBe(nextDraft);
  expect(view.navigate).not.toHaveBeenCalled();
  expect(sync).not.toHaveBeenCalled();
});

it("같은 계정에서 화면을 떠나 새로 작성한 구매 초안을 이전 성공이 지우지 않는다", async () => {
  const finish = deferPurchase();
  const oldView = await openForm();
  await submit();
  oldView.unmount();
  const nextView = await openForm();
  await userEvent.clear(screen.getByLabelText("새 제품 이름"));
  await userEvent.type(screen.getByLabelText("새 제품 이름"), "다시 작성한 새 입력");
  const key = draftKey();
  if (!key) throw new Error("새 초안 없음");
  const updated = localStorage.getItem(key);
  await finish();
  expect(localStorage.getItem(key)).toBe(updated);
  expect(oldView.navigate).not.toHaveBeenCalled();
  expect(nextView.navigate).not.toHaveBeenCalled();
  expect(sync).not.toHaveBeenCalled();
});

it("현재 화면의 구매 완료는 제출한 초안을 정리하고 제품으로 한 번 이동한다", async () => {
  const view = await openForm();
  const key = draftKey();
  await submit();
  await waitFor(() => expect(view.navigate).toHaveBeenCalledWith(receipt.product_id));
  expect(view.navigate).toHaveBeenCalledTimes(1);
  expect(sync).toHaveBeenCalledTimes(1);
  if (!key) throw new Error("초안 키 없음");
  expect(localStorage.getItem(key)).toBeNull();
});

it("응답 유실 뒤 재시도는 같은 구매 본문을 보내 멱등 전환 영수증을 재확인한다", async () => {
  vi.mocked(interestsApi.purchase).mockRejectedValueOnce(new TypeError("응답을 받지 못했습니다"));
  const view = await openForm();
  await submit();
  expect(await screen.findByRole("alert")).toHaveTextContent("응답을 받지 못했습니다");
  expect(screen.getByLabelText("새 제품 이름")).toHaveValue(item.name);
  await userEvent.click(screen.getByRole("button", { name: "구매와 병 생성" }));
  await waitFor(() => expect(view.navigate).toHaveBeenCalledWith(receipt.product_id));
  expect(vi.mocked(interestsApi.purchase).mock.calls[1]).toEqual(
    vi.mocked(interestsApi.purchase).mock.calls[0],
  );
});
