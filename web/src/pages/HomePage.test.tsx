import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/Toast";
import { HomePage } from "@/pages/HomePage";
import { activateDatabase, db } from "@/sync/db";
import { SyncStatusProvider } from "@/sync/SyncStatusProvider";
import { renderWithQuery } from "@/testing";

const NOW = "2026-01-01T00:00:00Z";

function row(overrides: Record<string, unknown>) {
  return {
    id: "row",
    user_id: "u1",
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...overrides,
  };
}

function renderHomePage() {
  const onSelectProduct = vi.fn();
  const onSelectCategory = vi.fn();
  const onNavigate = vi.fn();
  renderWithQuery(
    <SyncStatusProvider>
      <ToastProvider>
        <HomePage
          onSelectProduct={onSelectProduct}
          onSelectCategory={onSelectCategory}
          onNavigate={onNavigate}
        />
      </ToastProvider>
    </SyncStatusProvider>,
  );
  return { onSelectProduct, onSelectCategory, onNavigate };
}

beforeEach(async () => {
  localStorage.clear();
  await activateDatabase("u1");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all([
    db.category.clear(),
    db.product.clear(),
    db.sku.clear(),
    db.purchase.clear(),
    db.bottle.clear(),
    db.vendor.clear(),
    db.tasting_session.clear(),
    db.outbox.clear(),
  ]);
});

describe("HomePage", () => {
  it("빈 컬렉션이면 안내 문구를 보여준다", async () => {
    renderHomePage();

    expect(
      await screen.findByText("등록한 술이 없습니다. 내 술에서 첫 제품을 추가하세요."),
    ).toBeInTheDocument();
    expect(screen.getByText("아직 등록한 술이 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("아직 시음 기록이 없습니다.")).toBeInTheDocument();
  });

  it("요약·주종별 보유·랭킹·최근 활동을 보여준다", async () => {
    await db.category.bulkPut([
      row({ id: "liquor", parent_id: null, name: "양주" }),
      row({ id: "whisky", parent_id: "liquor", name: "위스키" }),
    ]);
    await db.vendor.bulkPut([row({ id: "v1", name: "가상마트", kind: "mart" })]);
    await db.product.bulkPut([
      row({
        id: "p1",
        name: "글렌고인 25y",
        category_id: "whisky",
        abv: "43.0",
        personal_rating: "3.0",
        created_at: "2026-01-02T00:00:00Z",
      }),
      row({
        id: "p2",
        name: "평점 술",
        category_id: "whisky",
        abv: "13.0",
        personal_rating: "5.0",
        created_at: "2026-01-01T00:00:00Z",
      }),
    ]);
    await db.sku.bulkPut([
      row({ id: "s1", product_id: "p1", volume_ml: 500 }),
      row({ id: "s2", product_id: "p2", volume_ml: 500 }),
    ]);
    await db.purchase.bulkPut([
      row({
        id: "pu1",
        sku_id: "s1",
        vendor_id: "v1",
        quantity: 1,
        unit_list_price: "1000000",
        unit_paid_price: "848000",
      }),
      row({
        id: "pu2",
        sku_id: "s2",
        vendor_id: "v1",
        quantity: 1,
        unit_list_price: "100000",
        unit_paid_price: "90000",
      }),
    ]);
    await db.bottle.bulkPut([
      row({ id: "b1", purchase_id: "pu1", label_no: 1, status: "unopened" }),
      row({ id: "b2", purchase_id: "pu2", label_no: 1, status: "unopened" }),
    ]);
    await db.tasting_session.bulkPut([
      row({ id: "t1", sku_id: "s1", bottle_id: "b1", tasted_on: "2026-01-05", rating: "4.5" }),
    ]);

    renderHomePage();

    // 요약: 구매 병수·재고가 "2병" 으로 표시된다(여러 곳에 나타날 수 있다).
    expect((await screen.findAllByText("2병")).length).toBeGreaterThan(0);
    // 주종별 보유: 상위 주종("양주")으로 롤업.
    expect(screen.getByText("양주")).toBeInTheDocument();
    // 랭킹·최근 등록·최근 시음 어디서든 제품 이름이 보인다.
    expect(screen.getAllByText("글렌고인 25y").length).toBeGreaterThan(0);
  });

  it("'오늘 마셨어요'로 열린 병을 골라 별점·양을 기록하고 바로가기로 이동한다", async () => {
    await db.product.put(row({ id: "p1", name: "열린 위스키" }));
    await db.sku.put(row({ id: "s1", product_id: "p1", volume_ml: 700 }));
    await db.purchase.put(row({ id: "pu1", sku_id: "s1", quantity: 1 }));
    await db.bottle.put(
      row({
        id: "b1",
        purchase_id: "pu1",
        label_no: 1,
        status: "open",
        opened_on: "2026-01-02",
        remaining_ml: 400,
      }),
    );
    const { onNavigate } = renderHomePage();

    expect(await screen.findByText("400ml 남음 · 2026-01-02 개봉")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "보관·실사 병 위치와 재고 확인" }));
    expect(onNavigate).toHaveBeenCalledWith("inventory");
    await userEvent.click(
      screen.getByRole("button", { name: "매장 모드 바코드로 보유·가격 확인" }),
    );
    expect(onNavigate).toHaveBeenCalledWith("scan");

    await userEvent.click(screen.getByRole("button", { name: "오늘 마셨어요" }));
    const dialog = await screen.findByRole("dialog", { name: "무엇을 마셨나요?" });
    await userEvent.click(within(dialog).getByRole("button", { name: /열린 위스키/ }));
    await userEvent.click(screen.getByRole("button", { name: "4점" }));
    await userEvent.click(screen.getByRole("button", { name: "50ml" }));
    await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));

    await waitFor(async () => expect((await db.bottle.get("b1"))?.remaining_ml).toBe(350));
    const [entry] = await db.outbox.toArray();
    expect(entry?.fields).toMatchObject({ bottle_id: "b1", poured_ml: 50, rating: "4.0" });
    expect(await screen.findByText("열린 위스키 시음을 기록했습니다")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "방금 기록 수정" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("남은 양을 모두 마시면 소진으로 기록하고 그렇다고 알린다", async () => {
    await db.product.put(row({ id: "p1", name: "캔맥주" }));
    await db.sku.put(row({ id: "s1", product_id: "p1", volume_ml: 355 }));
    await db.purchase.put(row({ id: "pu1", sku_id: "s1", quantity: 1 }));
    await db.bottle.put(row({ id: "b1", purchase_id: "pu1", label_no: 1, status: "unopened" }));
    renderHomePage();

    await userEvent.click(await screen.findByRole("button", { name: "오늘 마셨어요" }));
    const dialog = await screen.findByRole("dialog", { name: "무엇을 마셨나요?" });
    await userEvent.click(within(dialog).getByRole("button", { name: /캔맥주/ }));
    await userEvent.click(screen.getByRole("button", { name: "남은 양 전부(355ml)" }));
    await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));

    expect(
      await screen.findByText("캔맥주 시음을 기록했습니다 (다 마셔 소진 처리)"),
    ).toBeInTheDocument();
    const bottle = await db.bottle.get("b1");
    expect(bottle).toMatchObject({ status: "finished", remaining_ml: 0 });
  });

  it("열린 병의 실제 개봉 경과일을 표시한다", async () => {
    await db.category.put(row({ id: "wine", parent_id: null, name: "와인" }));
    await db.product.put(row({ id: "p1", name: "열어 둔 와인", category_id: "wine" }));
    await db.sku.put(row({ id: "s1", product_id: "p1", volume_ml: 750 }));
    await db.purchase.put(row({ id: "pu1", sku_id: "s1", quantity: 1 }));
    await db.bottle.put(
      row({ id: "b1", purchase_id: "pu1", label_no: 1, status: "open", opened_on: "2020-01-01" }),
    );

    renderHomePage();

    expect(await screen.findByText(/개봉 후 .*일 경과/)).toBeInTheDocument();
    expect(screen.queryByText(/권장 7일/)).not.toBeInTheDocument();
  });
});

it("주종의 현재·미개봉·개봉 수에서 같은 병을 찾고 하위 주종으로 내려간다", async () => {
  await db.category.bulkPut([
    row({ id: "r", name: "위스키", parent_id: null }),
    row({ id: "c", name: "싱글몰트", parent_id: "r" }),
  ]);
  await db.product.put(row({ id: "p", name: "오래 보유한 싱글몰트", category_id: "c" }));
  await db.sku.put(row({ id: "s", product_id: "p", volume_ml: 700 }));
  await db.purchase.put(row({ id: "pu", sku_id: "s", quantity: 3, unit_paid_price: "30000" }));
  await db.bottle.bulkPut([
    row({ id: "b1", purchase_id: "pu", label_no: 1, status: "open" }),
    row({ id: "b2", purchase_id: "pu", label_no: 2, status: "unopened" }),
    row({ id: "b3", purchase_id: "pu", label_no: 3, status: "finished" }),
  ]);
  const { onSelectProduct } = renderHomePage();
  await userEvent.click(await screen.findByRole("button", { name: "위스키 미개봉 1병 보기" }));
  const evidence = screen.getByRole("region", { name: "위스키 · 미개봉 병 목록" });
  expect(within(evidence).getByText(/병 #2/)).toBeInTheDocument();
  expect(within(evidence).queryByText(/병 #1/)).not.toBeInTheDocument();
  await userEvent.click(within(evidence).getByRole("button", { name: "오래 보유한 싱글몰트" }));
  expect(onSelectProduct).toHaveBeenCalledWith("p", { skuId: "s", bottleId: "b2" });
  await userEvent.click(screen.getByLabelText("하위 주종 함께 보기"));
  expect(screen.getByRole("button", { name: "싱글몰트 현재 보유 2병 보기" })).toBeInTheDocument();
  await userEvent.click(screen.getByLabelText("누적·원가 보기"));
  expect(screen.getByRole("columnheader", { name: "누적 구매" })).toBeInTheDocument();
  const stockRow = screen.getByRole("button", { name: "위스키 현재 보유 2병 보기" }).closest("tr");
  expect(stockRow).toHaveTextContent("3");
});

it("열린 병 전체 보기와 최근 시음 수정이 대상 병·기록을 유지한다", async () => {
  await db.product.put(row({ id: "p", name: "GlenAllachie 12", category_id: null }));
  await db.sku.put(row({ id: "s", product_id: "p", volume_ml: 700 }));
  await db.purchase.put(row({ id: "pu", sku_id: "s", quantity: 7 }));
  await db.bottle.bulkPut(
    Array.from({ length: 7 }, (_, i) =>
      row({ id: `b${i}`, purchase_id: "pu", label_no: i + 1, status: "open", remaining_ml: 500 }),
    ),
  );
  await db.tasting_session.put(
    row({ id: "t", sku_id: "s", bottle_id: "b0", tasted_on: "2026-10-10", rating: "0.0" }),
  );
  const { onSelectProduct } = renderHomePage();
  await userEvent.click(await screen.findByRole("button", { name: "전체 7병 보기" }));
  expect(screen.getByRole("button", { name: /GlenAllachie 12 #7/ })).toBeInTheDocument();
  const activity = screen.getByRole("region", { name: "최근 활동" });
  await userEvent.click(within(activity).getByRole("button", { name: "수정" }));
  expect(onSelectProduct).toHaveBeenCalledWith("p", {
    skuId: "s",
    bottleId: "b0",
    tastingId: "t",
    editTasting: true,
  });
});
