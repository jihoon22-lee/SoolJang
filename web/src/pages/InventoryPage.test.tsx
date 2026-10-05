import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { collectionApi, type InventoryBottle, type Stocktake } from "@/api/collection";
import { ToastProvider } from "@/components/Toast";
import { InventoryPage } from "@/pages/InventoryPage";
import { db } from "@/sync/db";
import { SyncStatusProvider } from "@/sync/SyncStatusProvider";
import { renderWithQuery, stubRoutes } from "@/testing";

const bottle: InventoryBottle = {
  id: "b1",
  product_id: "p1",
  name: "합성 위스키",
  label_no: 1,
  status: "unopened",
  location_id: null,
  legacy_location: null,
  bottle_code: "sooljang:bottle:b1",
};

function stocktakeOf(overrides: Partial<Stocktake> = {}): Stocktake {
  return {
    id: "s1",
    name: "선반 실사",
    status: "active",
    location_id: null,
    expected_count: 1,
    observed_count: 0,
    mismatch_count: 0,
    unexpected_count: 0,
    observations: [],
    missing: [bottle],
    found_notes: [],
    ...overrides,
  };
}

function renderPage(onSelectProduct = vi.fn()) {
  renderWithQuery(
    <SyncStatusProvider>
      <ToastProvider>
        <InventoryPage onSelectProduct={onSelectProduct} />
      </ToastProvider>
    </SyncStatusProvider>,
  );
  return { onSelectProduct };
}

beforeEach(async () => {
  await db.open();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all([db.bottle.clear(), db.outbox.clear()]);
});

it("실사에서 내부 병 코드를 확인하고 상태 변경 API를 호출하지 않는다", async () => {
  const { calls } = stubRoutes([
    { match: "/collection/locations", body: [] },
    { match: "/collection/bottles", body: [bottle] },
    { match: "/collection/stocktakes", body: [stocktakeOf()] },
    {
      match: "/collection/stocktakes/s1/scan",
      method: "POST",
      body: { duplicate: true, observation: { result: "checked" } },
    },
  ]);
  renderPage();
  // 진행 중인 실사는 다른 탭에서도 배너로 알린다.
  await userEvent.click(await screen.findByRole("button", { name: /실사 진행 중: 선반 실사/ }));
  await userEvent.type(screen.getByLabelText("내부 병 QR 문자열"), bottle.bottle_code);
  await userEvent.click(screen.getByRole("button", { name: "병 확인" }));
  expect(await screen.findByText("이미 확인한 병입니다 · 합성 위스키 #1")).toBeInTheDocument();
  const writes = calls.filter((call) => call.method !== "GET");
  expect(writes).toEqual([
    {
      url: "/api/v1/collection/stocktakes/s1/scan",
      method: "POST",
      body: { bottle_code: bottle.bottle_code, observed_location_id: null },
    },
  ]);
});

it("오프라인에서 위치·실사 쓰기를 비활성화한다", async () => {
  vi.stubGlobal("navigator", { ...navigator, onLine: false });
  renderPage();
  await userEvent.click(screen.getByRole("tab", { name: "위치 관리" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "위치 추가" })).toBeDisabled());
  await userEvent.click(screen.getByRole("tab", { name: "재고 실사" }));
  expect(screen.getByRole("button", { name: "실사 시작" })).toBeDisabled();
});

it("여러 병을 골라 한 위치로 옮기고 실행 취소로 원래 위치에 되돌린다", async () => {
  const shelf = {
    id: "l1",
    name: "선반",
    kind: "shelf" as const,
    note: null,
    deleted: false,
    bottle_count: 0,
  };
  const other = {
    ...bottle,
    id: "b2",
    label_no: 2,
    bottle_code: "sooljang:bottle:b2",
    location_id: "l1",
  };
  vi.spyOn(collectionApi, "locations").mockResolvedValue([shelf]);
  vi.spyOn(collectionApi, "bottles").mockResolvedValue([bottle, other]);
  vi.spyOn(collectionApi, "stocktakes").mockResolvedValue([]);
  const moveMany = vi
    .spyOn(collectionApi, "moveMany")
    .mockResolvedValue({ moved: 1, unchanged: 1 });
  renderPage();

  await userEvent.click(await screen.findByRole("checkbox", { name: "보이는 병 모두 선택" }));
  const bar = screen.getByRole("toolbar", { name: "선택한 병 옮기기" });
  await userEvent.selectOptions(within(bar).getByLabelText("옮길 위치"), "l1");
  await userEvent.click(within(bar).getByRole("button", { name: "옮기기" }));
  await waitFor(() => expect(moveMany).toHaveBeenCalledWith(["b1", "b2"], "l1"));

  await userEvent.click(await screen.findByRole("button", { name: "실행 취소" }));
  // 원래 위치별로 묶어 되돌린다 — 미지정이던 b1 은 미지정으로, 선반이던 b2 는 선반으로.
  await waitFor(() => expect(moveMany).toHaveBeenCalledWith(["b1"], null));
  expect(moveMany).toHaveBeenCalledWith(["b2"], "l1");
});

it("위치 이름 수정과 삭제 영향 확인·취소·확정을 할 수 있다", async () => {
  const location = {
    id: "l1",
    name: "검증 선반",
    kind: "shelf" as const,
    note: null,
    deleted: false,
    bottle_count: 1,
  };
  const snapshot = {
    rows: [{ id: "l1", name: location.name }],
    target: null,
    affected_count: 1,
    bottle_count: 0,
    known_paid_total: "0.00",
    unknown_price_count: 0,
  };
  vi.spyOn(collectionApi, "locations").mockResolvedValue([location]);
  vi.spyOn(collectionApi, "bottles").mockResolvedValue([{ ...bottle, location_id: "l1" }]);
  vi.spyOn(collectionApi, "stocktakes").mockResolvedValue([]);
  vi.spyOn(collectionApi, "saveLocation").mockResolvedValue({ id: "l1" });
  vi.spyOn(collectionApi, "preview").mockResolvedValue({
    id: "preview",
    kind: "location_delete",
    confirmed: false,
    snapshot,
  });
  vi.spyOn(collectionApi, "confirm").mockResolvedValue({
    id: "preview",
    kind: "location_delete",
    confirmed: true,
    snapshot,
  });
  renderPage();
  await userEvent.click(screen.getByRole("tab", { name: "위치 관리" }));
  await screen.findByText(/검증 선반 · 1병/);
  await userEvent.click(screen.getByRole("button", { name: "수정" }));
  await userEvent.clear(screen.getByLabelText("위치 이름"));
  await userEvent.type(screen.getByLabelText("위치 이름"), "검증 상자");
  await userEvent.selectOptions(screen.getByLabelText("위치 종류"), "box");
  await userEvent.click(screen.getByRole("button", { name: "이름·종류 저장" }));
  await waitFor(() =>
    expect(collectionApi.saveLocation).toHaveBeenCalledWith(
      { name: "검증 상자", kind: "box" },
      "l1",
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "삭제 영향 확인" }));
  await userEvent.click(await screen.findByRole("button", { name: "취소" }));
  expect(collectionApi.confirm).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "삭제 영향 확인" }));
  await userEvent.click(await screen.findByRole("button", { name: "확인하고 정리" }));
  await waitFor(() => expect(collectionApi.confirm).toHaveBeenCalledWith("preview"));
});

it("병 QR과 이동 이력을 열어 본다", async () => {
  vi.spyOn(collectionApi, "locations").mockResolvedValue([
    { id: "old", name: "이전 상자", kind: "box", note: null, deleted: true, bottle_count: 0 },
    { id: "l1", name: "검증 선반", kind: "shelf", note: null, deleted: false, bottle_count: 1 },
  ]);
  vi.spyOn(collectionApi, "bottles").mockResolvedValue([
    { ...bottle, location_id: "l1", legacy_location: "종전 위치 메모" },
  ]);
  vi.spyOn(collectionApi, "stocktakes").mockResolvedValue([]);
  vi.spyOn(collectionApi, "movements").mockResolvedValue([
    { id: "m1", from_location_id: "old", to_location_id: "l1", created_at: "2026-09-07T00:00:00Z" },
  ]);
  const move = vi.spyOn(collectionApi, "move").mockResolvedValue({});
  renderPage();
  expect(await screen.findByText(/기존 메모: 종전 위치 메모/)).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText("합성 위스키 1번 병 위치"), "");
  await waitFor(() => expect(move).toHaveBeenCalledWith("b1", null));
  await userEvent.click(screen.getByRole("button", { name: "합성 위스키 1번 병 QR · 이동 이력" }));
  expect(await screen.findByText(/이전 상자 → 검증 선반/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "닫기" }));
  expect(screen.queryByText(/이전 상자 → 검증 선반/)).not.toBeInTheDocument();
});

it("실사를 시작·중지·재개하고 위치 불일치를 반영하며 미확인 병을 골라 소진 처리한다", async () => {
  await db.bottle.put({
    id: "b1",
    user_id: "u1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    purchase_id: "pu1",
    label_no: 1,
    status: "unopened",
    opened_on: null,
    finished_on: null,
    remaining_ml: null,
  });
  const stocktake = stocktakeOf({ name: "검증 실사", location_id: "l1", mismatch_count: 1 });
  vi.spyOn(collectionApi, "locations").mockResolvedValue([
    { id: "l1", name: "검증 선반", kind: "shelf", note: null, deleted: false, bottle_count: 1 },
  ]);
  vi.spyOn(collectionApi, "bottles").mockResolvedValue([{ ...bottle, location_id: "l1" }]);
  vi.spyOn(collectionApi, "stocktakes").mockImplementation(async () => [{ ...stocktake }]);
  vi.spyOn(collectionApi, "start").mockResolvedValue(stocktake);
  vi.spyOn(collectionApi, "status").mockImplementation(async (_id, status) => {
    stocktake.status = status;
    return { ...stocktake };
  });
  vi.spyOn(collectionApi, "found").mockImplementation(async (_id, note) => {
    stocktake.found_notes = [note];
    return { ...stocktake };
  });
  const apply = vi.spyOn(collectionApi, "applyLocations").mockImplementation(async () => {
    stocktake.mismatch_count = 0;
    return { moved: 1, stocktake: { ...stocktake } };
  });
  renderPage();
  await userEvent.click(screen.getByRole("tab", { name: "재고 실사" }));
  await userEvent.type(screen.getByLabelText("실사 이름"), "검증 실사");
  await userEvent.selectOptions(screen.getByLabelText("범위"), "l1");
  await userEvent.click(screen.getByRole("button", { name: "실사 시작" }));
  await screen.findByRole("heading", { name: "검증 실사" });
  expect(collectionApi.start).toHaveBeenCalledWith("검증 실사", "l1");
  expect(screen.getByText(/확인 0\/1병/)).toBeInTheDocument();

  await userEvent.click(
    screen.getByRole("button", { name: "위치 불일치 1병을 확인한 위치로 옮기기" }),
  );
  await waitFor(() => expect(apply).toHaveBeenCalledWith("s1"));

  await userEvent.click(screen.getByRole("button", { name: "일시 중지" }));
  await userEvent.click(await screen.findByRole("button", { name: "실사 재개" }));
  await screen.findByRole("button", { name: "일시 중지" });
  await userEvent.type(screen.getByLabelText("미등록 발견 메모"), "등록 전 병");
  await userEvent.click(screen.getByRole("button", { name: "발견 기록" }));
  expect(await screen.findByText("등록 전 병", { selector: "li" })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("checkbox", { name: "합성 위스키 #1" }));
  await userEvent.click(screen.getByRole("button", { name: "선택한 1병 소진 처리" }));
  await waitFor(async () => expect((await db.bottle.get("b1"))?.status).toBe("finished"));
  expect((await db.outbox.toArray()).map((entry) => entry.action)).toEqual(["finish"]);

  await userEvent.click(screen.getByRole("button", { name: "관찰 기록으로 완료" }));
  await waitFor(() => expect(collectionApi.status).toHaveBeenLastCalledWith("s1", "completed"));
  expect(screen.getByRole("button", { name: "병 확인" })).toBeDisabled();
});
