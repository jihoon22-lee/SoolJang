import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { InventoryPage } from "@/pages/InventoryPage";
import { SyncStatusProvider } from "@/sync/SyncStatusProvider";
import { renderWithQuery, stubRoutes } from "@/testing";

const bottle = {
  id: "b1",
  product_id: "p1",
  name: "합성 위스키",
  label_no: 1,
  status: "unopened",
  location_id: null,
  legacy_location: null,
  bottle_code: "sooljang:bottle:b1",
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("실사에서 내부 병 코드를 확인하고 상태 변경 API를 호출하지 않는다", async () => {
  const { calls } = stubRoutes([
    { match: "/collection/locations", body: [] },
    { match: "/collection/bottles", body: [bottle] },
    {
      match: "/collection/stocktakes",
      body: [
        {
          id: "s1",
          name: "선반 실사",
          status: "active",
          location_id: null,
          expected_count: 1,
          observations: [],
          missing: [bottle],
          found_notes: [],
        },
      ],
    },
    {
      match: "/collection/stocktakes/s1/scan",
      method: "POST",
      body: { duplicate: true, observation: { result: "checked" } },
    },
  ]);
  renderWithQuery(
    <SyncStatusProvider>
      <InventoryPage onSelectProduct={vi.fn()} />
    </SyncStatusProvider>,
  );
  await screen.findByRole("option", { name: "선반 실사 (진행 중)" });
  await userEvent.selectOptions(screen.getByLabelText("진행·완료 실사"), "s1");
  await userEvent.type(screen.getByLabelText("내부 병 QR 문자열"), bottle.bottle_code);
  await userEvent.click(screen.getByRole("button", { name: "병 확인" }));
  expect(await screen.findByText("이미 확인한 병입니다")).toBeInTheDocument();
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
  renderWithQuery(
    <SyncStatusProvider>
      <InventoryPage onSelectProduct={vi.fn()} />
    </SyncStatusProvider>,
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "위치 추가" })).toBeDisabled());
  expect(screen.getByRole("button", { name: "실사 시작" })).toBeDisabled();
});

it("위치 수정·삭제는 영향을 확인하고 실사를 중지·재개·완료할 수 있다", async () => {
  const { collectionApi } = await import("@/api/collection");
  const location = {
    id: "l1",
    name: "검증 선반",
    kind: "shelf" as const,
    note: null,
    deleted: false,
    bottle_count: 1,
  };
  const stocktake = {
    id: "s1",
    name: "검증 실사",
    status: "active" as "active" | "paused" | "completed",
    location_id: "l1",
    expected_count: 1,
    observations: [],
    missing: [{ ...bottle, location_id: "l1" }],
    found_notes: [] as string[],
  };
  vi.spyOn(collectionApi, "locations").mockResolvedValue([
    location,
    { ...location, id: "old", name: "이전 상자", deleted: true },
  ]);
  vi.spyOn(collectionApi, "bottles").mockResolvedValue([
    { ...bottle, location_id: "l1", legacy_location: "종전 위치 메모" },
  ]);
  vi.spyOn(collectionApi, "movements").mockResolvedValue([
    { id: "m1", from_location_id: "old", to_location_id: "l1", created_at: "2026-09-07T00:00:00Z" },
  ]);
  vi.spyOn(collectionApi, "stocktakes").mockImplementation(async () => [stocktake]);
  vi.spyOn(collectionApi, "saveLocation").mockResolvedValue({ id: "l1" });
  vi.spyOn(collectionApi, "move").mockResolvedValue({});
  vi.spyOn(collectionApi, "preview").mockResolvedValue({
    id: "preview",
    kind: "location_delete",
    confirmed: false,
    snapshot: {
      rows: [{ id: "l1", name: location.name }],
      target: null,
      affected_count: 1,
      bottle_count: 0,
      known_paid_total: "0.00",
      unknown_price_count: 0,
    },
  });
  vi.spyOn(collectionApi, "confirm").mockResolvedValue({
    id: "preview",
    kind: "location_delete",
    confirmed: true,
    snapshot: {
      rows: [],
      target: null,
      affected_count: 1,
      bottle_count: 0,
      known_paid_total: "0.00",
      unknown_price_count: 0,
    },
  });
  vi.spyOn(collectionApi, "start").mockResolvedValue(stocktake);
  vi.spyOn(collectionApi, "status").mockImplementation(async (_id, status) => {
    stocktake.status = status;
    return { ...stocktake };
  });
  vi.spyOn(collectionApi, "found").mockImplementation(async (_id, note) => {
    stocktake.found_notes = [note];
    return { ...stocktake };
  });
  renderWithQuery(
    <SyncStatusProvider>
      <InventoryPage onSelectProduct={vi.fn()} />
    </SyncStatusProvider>,
  );
  await screen.findByText("검증 선반 · 1병");
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
  await userEvent.selectOptions(screen.getByLabelText("위치 필터"), "unassigned");
  expect(screen.queryByRole("button", { name: "합성 위스키 #1" })).not.toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText("위치 필터"), "l1");
  await userEvent.selectOptions(screen.getByLabelText("합성 위스키 1번 병 위치"), "");
  await waitFor(() => expect(collectionApi.move).toHaveBeenCalledWith("b1", null));
  await userEvent.click(screen.getByRole("button", { name: "병 QR · 이동 이력" }));
  expect(await screen.findByText(/이전 상자 → 검증 선반/)).toBeInTheDocument();
  await waitFor(() =>
    expect(
      screen.getByRole("img", { name: "술장 내부 병 QR" }).querySelector("path")?.getAttribute("d"),
    ).not.toBe(""),
  );
  await userEvent.click(screen.getByRole("button", { name: "닫기" }));
  await userEvent.click(screen.getByRole("button", { name: "삭제 영향 확인" }));
  await userEvent.click(await screen.findByRole("button", { name: "취소" }));
  expect(collectionApi.confirm).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "삭제 영향 확인" }));
  await userEvent.click(await screen.findByRole("button", { name: "확인하고 정리" }));
  await waitFor(() => expect(collectionApi.confirm).toHaveBeenCalledWith("preview"));
  await userEvent.type(screen.getByLabelText("실사 이름"), "검증 실사");
  await userEvent.click(screen.getByRole("button", { name: "실사 시작" }));
  await screen.findByRole("heading", { name: "검증 실사" });
  expect(collectionApi.start).toHaveBeenCalledWith("검증 실사", "l1");
  await userEvent.click(screen.getByRole("button", { name: "일시 중지" }));
  await userEvent.click(await screen.findByRole("button", { name: "실사 재개" }));
  await screen.findByRole("button", { name: "일시 중지" });
  await userEvent.type(screen.getByLabelText("미등록 발견 메모"), "등록 전 병");
  await userEvent.click(screen.getByRole("button", { name: "발견 기록" }));
  expect(await screen.findByText("등록 전 병", { selector: "li" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "관찰 기록으로 완료" }));
  await waitFor(() => expect(collectionApi.status).toHaveBeenLastCalledWith("s1", "completed"));
  expect(screen.getByRole("button", { name: "병 확인" })).toBeDisabled();
});
