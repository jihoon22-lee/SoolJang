import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QuickTastingSheet } from "@/components/QuickTastingSheet";
import { ToastProvider } from "@/components/Toast";
import { activateDatabase, databaseIdentity, db } from "@/sync/db";
import { SyncStatusProvider } from "@/sync/SyncStatusProvider";
import * as tastingActions from "@/sync/tastingActions";
import { applyWaitingUpdate, hasDirtyForms, markUpdateReady } from "@/sync/update";
import { renderWithQuery, stubRoutes } from "@/testing";

const OWNER = "quick-owner";
const NOW = "2026-01-01T00:00:00Z";
function row(fields: Record<string, unknown>) {
  return {
    id: "row",
    user_id: databaseIdentity().userId ?? "",
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...fields,
  };
}
async function seed() {
  await db.product.put(row({ id: "product", name: "합성 위스키" }));
  await db.sku.bulkPut([
    row({ id: "large", product_id: "product", volume_ml: 700 }),
    row({ id: "small", product_id: "product", volume_ml: 200 }),
  ]);
  await db.vendor.bulkPut([
    row({ id: "old-shop", name: "오래된 매장" }),
    row({ id: "new-shop", name: "새 매장" }),
  ]);
  await db.purchase.bulkPut([
    row({
      id: "old-purchase",
      sku_id: "large",
      purchased_on: "2025-01-01",
      vendor_id: "old-shop",
      quantity: 1,
    }),
    row({
      id: "new-purchase",
      sku_id: "large",
      purchased_on: "2026-01-01",
      vendor_id: "new-shop",
      quantity: 1,
    }),
    row({ id: "small-purchase", sku_id: "small", purchased_on: "2025-02-01", quantity: 1 }),
  ]);
  await db.bottle.bulkPut([
    row({
      id: "older",
      purchase_id: "old-purchase",
      label_no: 9,
      status: "unopened",
      opened_on: null,
      remaining_ml: null,
    }),
    row({
      id: "newer",
      purchase_id: "new-purchase",
      label_no: 1,
      status: "unopened",
      opened_on: null,
      remaining_ml: null,
    }),
    row({
      id: "small-bottle",
      purchase_id: "small-purchase",
      label_no: 2,
      status: "unopened",
      opened_on: null,
      remaining_ml: null,
    }),
    row({
      id: "open-bottle",
      purchase_id: "new-purchase",
      label_no: 3,
      status: "open",
      opened_on: "2026-01-01",
      remaining_ml: 100,
    }),
  ]);
}
function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <SyncStatusProvider>
      <ToastProvider>
        {open ? (
          <QuickTastingSheet onClose={() => setOpen(false)} />
        ) : (
          <button type="button" onClick={() => setOpen(true)}>
            다시 열기
          </button>
        )}
      </ToastProvider>
    </SyncStatusProvider>
  );
}
async function chooseLarge() {
  await userEvent.click(await screen.findByRole("button", { name: /700ml.*미개봉 2병/ }));
  await screen.findByRole("button", { name: "기록 저장" });
}
async function writeNote(note = "바닐라 향") {
  await userEvent.click(
    screen.getByText("자세히 기록 (향·맛·피니시·장소·동석자)", { selector: "summary" }),
  );
  await userEvent.type(screen.getByLabelText("향"), note);
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  await activateDatabase(OWNER);
  vi.stubGlobal("navigator", { ...navigator, onLine: false });
  await seed();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
  await activateDatabase(OWNER);
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
});

it("미개봉은 용량별로 묶고 가장 오래된 구매의 병을 기본으로 기록한다", async () => {
  renderWithQuery(<Harness />);
  expect(await screen.findByRole("button", { name: /200ml.*미개봉 1병/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /700ml.*#3.*개봉/ })).toBeInTheDocument();
  await chooseLarge();
  expect(screen.getByText(/700ml.*#9.*2025-01-01.*오래된 매장/)).toBeInTheDocument();
  expect(screen.getByText(/위치 확인 불가 \(오프라인\)/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "30ml" }));
  await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));
  await waitFor(async () => expect((await db.bottle.get("older"))?.remaining_ml).toBe(670));
  expect((await db.bottle.get("newer"))?.status).toBe("unopened");
  expect((await db.outbox.toArray())[0]?.fields.bottle_id).toBe("older");
});

it("병 변경에서 구매일·구매처·번호·온라인 위치를 확인하고 다른 병을 선택한다", async () => {
  vi.stubGlobal("navigator", { ...navigator, onLine: true });
  const { calls } = stubRoutes([
    {
      match: "/collection/bottles",
      body: [
        { id: "older", location_id: "shelf", legacy_location: null },
        { id: "newer", location_id: null, legacy_location: "서랍" },
      ],
    },
    {
      match: "/collection/locations",
      body: [{ id: "shelf", name: "위스키 선반", deleted: false }],
    },
  ]);
  renderWithQuery(<Harness />);
  await chooseLarge();
  expect(await screen.findByText(/#9.*위스키 선반/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "병 변경" }));
  const replacement = await screen.findByRole("button", {
    name: /700ml.*#1.*2026-01-01.*새 매장.*서랍/,
  });
  expect(
    screen.getByRole("button", { name: /700ml.*#9.*2025-01-01.*오래된 매장.*위스키 선반/ }),
  ).toBeInTheDocument();
  await userEvent.click(replacement);
  await userEvent.click(screen.getByRole("button", { name: "30ml" }));
  await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));
  await waitFor(async () => expect((await db.outbox.toArray())[0]?.fields.bottle_id).toBe("newer"));
  expect((await db.bottle.get("older"))?.status).toBe("unopened");
  expect(calls.filter((call) => call.url.includes("/collection/")).length).toBe(2);
});

it("닫았다 다시 열거나 새로 마운트해도 선택한 병·평점·양·노트를 복원한다", async () => {
  const first = renderWithQuery(<Harness />);
  await chooseLarge();
  await userEvent.click(screen.getByRole("button", { name: "4점" }));
  await userEvent.click(screen.getByRole("button", { name: "50ml" }));
  await writeNote();
  await userEvent.click(screen.getByRole("button", { name: "닫기" }));
  await userEvent.click(screen.getByRole("button", { name: "다시 열기" }));
  expect(await screen.findByLabelText("향")).toHaveValue("바닐라 향");
  expect(screen.getByRole("button", { name: "4점" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "50ml" })).toHaveAttribute("aria-pressed", "true");
  first.unmount();
  renderWithQuery(<Harness />);
  expect(await screen.findByText(/#9.*오래된 매장/)).toBeInTheDocument();
  expect(screen.getByLabelText("향")).toHaveValue("바닐라 향");
  expect(await db.outbox.count()).toBe(0);
});

it("다른 탭의 초안은 자동 섞지 않고 명시적 복원으로 병과 입력을 함께 가져온다", async () => {
  sessionStorage.setItem("sooljang-draft-tab", "first-tab");
  const first = renderWithQuery(<Harness />);
  await chooseLarge();
  await writeNote("첫 탭의 노트");
  first.unmount();
  sessionStorage.setItem("sooljang-draft-tab", "second-tab");
  renderWithQuery(<Harness />);
  expect(await screen.findByRole("dialog", { name: "무엇을 마셨나요?" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "이전 입력 불러오기" }));
  await waitFor(() => expect(screen.getByLabelText("향")).toHaveValue("첫 탭의 노트"));
  expect(screen.getByText(/#9.*오래된 매장/)).toBeInTheDocument();
});

it("다른 병에 이미 입력이 있으면 덮어쓰지 않고 각 병의 초안을 유지한다", async () => {
  renderWithQuery(<Harness />);
  await chooseLarge();
  await writeNote("첫 병의 노트");
  await userEvent.click(screen.getByRole("button", { name: "병 변경" }));
  await userEvent.click(await screen.findByRole("button", { name: /700ml.*#1.*새 매장/ }));
  await userEvent.clear(screen.getByLabelText("향"));
  await userEvent.type(screen.getByLabelText("향"), "둘째 병의 노트");
  await userEvent.click(screen.getByRole("button", { name: "병 변경" }));
  await userEvent.click(await screen.findByRole("button", { name: /700ml.*#9.*오래된 매장/ }));
  expect(await screen.findByLabelText("향")).toHaveValue("첫 병의 노트");
  expect(screen.getByText(/선택한 병의 기존 입력을 불러왔습니다/)).toBeInTheDocument();
});

it.each([
  "gifted",
  "sold",
  "deleted",
])("작성 중인 병이 %s가 되면 입력을 보존하고 다른 병으로 이어서 기록한다", async (status) => {
  renderWithQuery(<Harness />);
  await chooseLarge();
  await writeNote("보존할 입력");
  await act(async () => {
    await db.bottle.update("older", status === "deleted" ? { deleted_at: NOW } : { status });
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("선택한 병을 사용할 수 없습니다");
  expect(screen.getByRole("button", { name: "기록 저장" })).toBeDisabled();
  expect(screen.getByLabelText("향")).toHaveValue("보존할 입력");
  await userEvent.click(screen.getByRole("button", { name: "다른 병으로 이어서 기록" }));
  await userEvent.click(await screen.findByRole("button", { name: /700ml.*미개봉 1병/ }));
  expect(await screen.findByLabelText("향")).toHaveValue("보존할 입력");
  await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));
  await waitFor(async () =>
    expect((await db.outbox.toArray())[0]?.fields).toMatchObject({
      bottle_id: "newer",
      nose: "보존할 입력",
    }),
  );
});

it("저장 실패 때는 초안을 유지하고 성공한 병의 초안만 지운다", async () => {
  renderWithQuery(<Harness />);
  await chooseLarge();
  const amount = screen.getByLabelText(/직접 입력\(ml\)/);
  await userEvent.type(amount, "9999");
  await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("잔량이 부족합니다");
  expect(Object.keys(localStorage).some((key) => key.endsWith("quick-tasting:bottle:older"))).toBe(
    true,
  );
  await userEvent.clear(amount);
  await userEvent.type(amount, "30");
  await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));
  await screen.findByRole("button", { name: "다시 열기" });
  expect(Object.keys(localStorage).some((key) => key.includes("quick-tasting:"))).toBe(false);
});

it("명시적으로 입력을 삭제하면 다시 열 때 빈 선택 화면부터 시작한다", async () => {
  renderWithQuery(<Harness />);
  await chooseLarge();
  await writeNote();
  await userEvent.click(screen.getByRole("button", { name: "작성 중인 입력 삭제" }));
  await userEvent.click(screen.getByRole("button", { name: "다시 열기" }));
  expect(await screen.findByRole("dialog", { name: "무엇을 마셨나요?" })).toBeInTheDocument();
  expect(Object.keys(localStorage).some((key) => key.includes("quick-tasting:"))).toBe(false);
});

it("별점·프리셋 버튼도 작성 중으로 표시하며 업데이트 후 다시 열어 입력을 복원한다", async () => {
  const first = renderWithQuery(<Harness />);
  await chooseLarge();
  expect(hasDirtyForms()).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "4점" }));
  await userEvent.click(screen.getByRole("button", { name: "50ml" }));
  const update = vi.fn(async () => {});
  markUpdateReady(update);
  expect(hasDirtyForms()).toBe(true);
  expect(await applyWaitingUpdate()).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "닫기" }));
  expect(await applyWaitingUpdate()).toBe(true);
  first.unmount();
  renderWithQuery(<Harness />);
  expect(await screen.findByRole("button", { name: "50ml" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("button", { name: "4점" })).toHaveAttribute("aria-pressed", "true");
});

it("계정을 바꾸면 같은 병 ID라도 이전 계정 초안을 불러오지 않는다", async () => {
  const first = renderWithQuery(<Harness />);
  await chooseLarge();
  await writeNote("이전 계정 비공개 입력");
  first.unmount();
  await activateDatabase("quick-other");
  await seed();
  renderWithQuery(<Harness />);
  expect(await screen.findByRole("dialog", { name: "무엇을 마셨나요?" })).toBeInTheDocument();
  await chooseLarge();
  expect(screen.getByLabelText("향")).toHaveValue("");
  expect(
    within(screen.getByRole("dialog")).queryByText("이전 입력 불러오기"),
  ).not.toBeInTheDocument();
});

function holdTastingSave() {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = tastingActions.recordTasting;
  const record = vi.spyOn(tastingActions, "recordTasting").mockImplementationOnce(async (input) => {
    await Dexie.waitFor(gate);
    return original(input);
  });
  return { record, release };
}

it("저장 transaction 대기 중 닫기·Escape로 새 시트를 열어 이전 저장과 겹칠 수 없다", async () => {
  renderWithQuery(<Harness />);
  await chooseLarge();
  await writeNote("저장할 첫 기록");
  const held = holdTastingSave();
  await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));
  await waitFor(() => expect(held.record).toHaveBeenCalledOnce());
  expect(screen.getByRole("button", { name: "닫기" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "닫기" }));
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "다시 열기" })).not.toBeInTheDocument();
  await act(async () => held.release());
  await userEvent.click(await screen.findByRole("button", { name: "다시 열기" }));
  await userEvent.click(await screen.findByRole("button", { name: /700ml.*#9.*개봉/ }));
  await writeNote("새 시트의 다음 기록");
  await userEvent.click(screen.getByRole("button", { name: "닫기" }));
  await userEvent.click(screen.getByRole("button", { name: "다시 열기" }));
  expect(await screen.findByLabelText("향")).toHaveValue("새 시트의 다음 기록");
  expect((await db.tasting_session.toArray())[0]?.nose).toBe("저장할 첫 기록");
});

it("저장 transaction 대기 중 입력·별점·프리셋 편집을 막아 최신 초안을 잃지 않는다", async () => {
  renderWithQuery(<Harness />);
  await chooseLarge();
  await writeNote("제출한 노트");
  const held = holdTastingSave();
  await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));
  await waitFor(() => expect(held.record).toHaveBeenCalledOnce());
  const note = screen.getByLabelText("향");
  expect(note).toBeDisabled();
  expect(screen.getByRole("button", { name: "4점" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "50ml" })).toBeDisabled();
  await userEvent.type(note, "추가 입력");
  fireEvent.change(note, { target: { value: "지연 이벤트 입력" } });
  expect(note).toHaveValue("제출한 노트");
  await act(async () => held.release());
  await screen.findByRole("button", { name: "다시 열기" });
  expect((await db.tasting_session.toArray())[0]?.nose).toBe("제출한 노트");
  expect(Object.keys(localStorage).some((key) => key.includes("quick-tasting:"))).toBe(false);
});

it("동일 이름·용량의 다른 빈티지를 구분하고 선택한 실제 병의 상세 맥락을 전달한다", async () => {
  await db.product.update("product", { vintage: 2020, abv: "46", age_years: null });
  await db.product.put(
    row({ id: "edition-product", name: "합성 위스키", vintage: 2021, abv: "46", age_years: null }),
  );
  await db.sku.put(row({ id: "edition-sku", product_id: "edition-product", volume_ml: 700 }));
  await db.purchase.put(
    row({ id: "edition-purchase", sku_id: "edition-sku", purchased_on: "2025-01-01", quantity: 1 }),
  );
  await db.bottle.put(
    row({
      id: "edition-bottle",
      purchase_id: "edition-purchase",
      label_no: 1,
      status: "unopened",
      opened_on: null,
      remaining_ml: null,
    }),
  );
  const onSelectProduct = vi.fn();
  const onClose = vi.fn();
  renderWithQuery(
    <SyncStatusProvider>
      <ToastProvider>
        <QuickTastingSheet onClose={onClose} onSelectProduct={onSelectProduct} />
      </ToastProvider>
    </SyncStatusProvider>,
  );
  expect(
    await screen.findByRole("button", { name: /합성 위스키.*2020 빈티지.*700ml.*미개봉 2병/ }),
  ).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: /합성 위스키.*2021 빈티지.*700ml.*미개봉 1병/ }),
  );
  expect(screen.getByRole("heading", { name: /2021 빈티지/ })).toBeInTheDocument();
  expect(await screen.findByText(/700ml.*#1.*구매.*purchase/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "이 병 상세" }));
  expect(onSelectProduct).toHaveBeenCalledWith("edition-product", {
    skuId: "edition-sku",
    bottleId: "edition-bottle",
  });
  expect(onClose).toHaveBeenCalled();
});
