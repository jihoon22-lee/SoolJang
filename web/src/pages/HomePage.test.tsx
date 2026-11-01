import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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
  const onRecordPurchase = vi.fn();
  const onNavigate = vi.fn();
  renderWithQuery(
    <SyncStatusProvider>
      <ToastProvider>
        <HomePage
          onSelectProduct={onSelectProduct}
          onRecordPurchase={onRecordPurchase}
          onNavigate={onNavigate}
        />
      </ToastProvider>
    </SyncStatusProvider>,
  );
  return { onSelectProduct, onRecordPurchase, onNavigate };
}

/** 보유 요약의 한 지표 값. */
function metric(label: string): string | null | undefined {
  return screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
}

async function openBottle(
  id: string,
  productId: string,
  labelNo = 1,
  remaining: number | null = 400,
) {
  await db.bottle.put(
    row({
      id,
      purchase_id: `pu-${productId}`,
      label_no: labelNo,
      status: "open",
      opened_on: "2026-01-02",
      remaining_ml: remaining,
    }),
  );
}

async function product(id: string, name: string, volume = 700) {
  await db.product.put(row({ id, name }));
  await db.sku.put(row({ id: `s-${id}`, product_id: id, volume_ml: volume }));
  await db.purchase.put(row({ id: `pu-${id}`, sku_id: `s-${id}`, quantity: 1 }));
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
  it("빈 컬렉션이면 두 기록 행동과 첫 등록 안내를 보여준다", async () => {
    const { onRecordPurchase } = renderHomePage();

    expect(
      await screen.findByText("아직 기록한 술이 없습니다. 산 술 기록에서 첫 술을 등록하세요."),
    ).toBeInTheDocument();
    expect(screen.getByText("열려 있는 병이 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("아직 시음 기록이 없습니다.")).toBeInTheDocument();
    expect(metric("현재 보유")).toBe("0병");
    await userEvent.click(screen.getByRole("button", { name: "산 술 기록" }));
    expect(onRecordPurchase).toHaveBeenCalledOnce();
  });

  it("현재·미개봉·개봉을 펼침 없이 보이고 주종별 보유는 통계 주종별로 보낸다", async () => {
    await db.category.put(row({ id: "whisky", parent_id: null, name: "위스키" }));
    await db.product.put(row({ id: "p1", name: "글렌고인 25y", category_id: "whisky" }));
    await db.sku.put(row({ id: "s1", product_id: "p1", volume_ml: 500 }));
    await db.purchase.put(
      row({ id: "pu1", sku_id: "s1", quantity: 3, unit_paid_price: "1234567" }),
    );
    await db.bottle.bulkPut([
      row({ id: "b1", purchase_id: "pu1", label_no: 1, status: "unopened" }),
      row({ id: "b2", purchase_id: "pu1", label_no: 2, status: "unopened" }),
      row({ id: "b3", purchase_id: "pu1", label_no: 3, status: "open", remaining_ml: 250 }),
    ]);
    const { onNavigate } = renderHomePage();

    await screen.findByText("글렌고인 25y");
    expect(metric("현재 보유")).toBe("3병");
    expect(metric("미개봉")).toBe("2병");
    expect(metric("개봉 중")).toBe("1병");
    expect(metric("재고 원가")).toBe("3,703,701원");
    // 홈에는 관리 바로가기·랭킹·주종 표가 없다(D265).
    expect(screen.queryByRole("navigation", { name: "바로가기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "주종별 보유 보기" }));
    expect(onNavigate).toHaveBeenCalledWith("stats");
    expect(sessionStorage.getItem("sooljang:view:u1:stats:section")).toBe('"categories"');
  });

  it("열린 병의 한 잔에서 타이핑 없이 4번 눌러 기록한다", async () => {
    await product("p1", "열린 위스키");
    await openBottle("b1", "p1");
    const { onSelectProduct } = renderHomePage();

    // 잔량 글자가 게이지와 같은 행에 있다(게이지 그림은 보조 기술에 숨긴다).
    expect(await screen.findByText(/400ml 남음 · 개봉 후 .*일 경과/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "열린 위스키 #1 한 잔 기록" }));
    const dialog = await screen.findByRole("dialog", { name: "열린 위스키" });
    await userEvent.click(within(dialog).getByRole("button", { name: "4점" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "50ml" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "기록 저장" }));

    await waitFor(async () => expect((await db.bottle.get("b1"))?.remaining_ml).toBe(350));
    const [entry] = await db.outbox.toArray();
    expect(entry?.fields).toMatchObject({ bottle_id: "b1", poured_ml: 50, rating: "4.0" });
    // 저장하면 시트가 닫히고 이어서 할 일은 알림에 있다(D267).
    expect(await screen.findByText("열린 위스키 시음을 기록했습니다")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    for (const label of ["고치기", "한 잔 더", "보기"])
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    // 누른 한 잔 단추로 초점이 돌아온다.
    expect(screen.getByRole("button", { name: "열린 위스키 #1 한 잔 기록" })).toHaveFocus();

    const [tasting] = await db.tasting_session.toArray();
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    expect(onSelectProduct).toHaveBeenCalledWith("p1", {
      skuId: "s-p1",
      bottleId: "b1",
      tastingId: tasting?.id,
    });
  });

  it("저장 알림의 한 잔 더는 같은 병을 빈 입력으로 다시 열고 고치기·보기는 방금 기록으로 간다", async () => {
    await product("p1", "열린 위스키");
    await openBottle("b1", "p1");
    const { onSelectProduct } = renderHomePage();

    await userEvent.click(await screen.findByRole("button", { name: "열린 위스키 #1 한 잔 기록" }));
    await userEvent.click(screen.getByRole("button", { name: "30ml" }));
    await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));
    await userEvent.click(await screen.findByRole("button", { name: "한 잔 더" }));
    const dialog = await screen.findByRole("dialog", { name: "열린 위스키" });
    expect(within(dialog).getByRole("button", { name: "30ml" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "50ml" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "기록 저장" }));
    await waitFor(async () => expect((await db.bottle.get("b1"))?.remaining_ml).toBe(320));
    expect(await db.tasting_session.count()).toBe(2);

    const latest = (await db.tasting_session.toArray()).find((item) => item.poured_ml === 50);
    const context = { skuId: "s-p1", bottleId: "b1", tastingId: latest?.id };
    await userEvent.click(await screen.findByRole("button", { name: "고치기" }));
    expect(onSelectProduct).toHaveBeenLastCalledWith("p1", { ...context, editTasting: true });
    expect(screen.queryByRole("button", { name: "보기" })).not.toBeInTheDocument();
  });

  it("새 기록을 시작하거나 홈을 떠나면 앞 기록의 이어가기 알림을 거둔다", async () => {
    await product("p1", "열린 위스키");
    await openBottle("b1", "p1");
    function Switchable() {
      const [home, setHome] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setHome(false)}>
            다른 화면
          </button>
          {home ? (
            <HomePage onSelectProduct={vi.fn()} onRecordPurchase={vi.fn()} onNavigate={vi.fn()} />
          ) : null}
        </>
      );
    }
    renderWithQuery(
      <SyncStatusProvider>
        <ToastProvider>
          <Switchable />
        </ToastProvider>
      </SyncStatusProvider>,
    );
    async function pour() {
      await userEvent.click(
        await screen.findByRole("button", { name: "열린 위스키 #1 한 잔 기록" }),
      );
      await userEvent.click(screen.getByRole("button", { name: "30ml" }));
      await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));
      await screen.findByRole("button", { name: "한 잔 더" });
    }

    await pour();
    await userEvent.click(screen.getByRole("button", { name: "마신 술 기록" }));
    expect(screen.queryByRole("button", { name: "한 잔 더" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "닫기" }));

    await pour();
    await userEvent.click(screen.getByRole("button", { name: "다른 화면" }));
    expect(screen.queryByText("열린 위스키 시음을 기록했습니다")).not.toBeInTheDocument();
  });

  it("저장이 끝나기 전에 홈을 떠나면 이어가기 없이 기록했다고만 알린다", async () => {
    await product("p1", "열린 위스키");
    await openBottle("b1", "p1");
    function Switchable() {
      const [home, setHome] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setHome(false)}>
            다른 화면
          </button>
          {home ? (
            <HomePage onSelectProduct={vi.fn()} onRecordPurchase={vi.fn()} onNavigate={vi.fn()} />
          ) : null}
        </>
      );
    }
    renderWithQuery(
      <SyncStatusProvider>
        <ToastProvider>
          <Switchable />
        </ToastProvider>
      </SyncStatusProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "열린 위스키 #1 한 잔 기록" }));
    await userEvent.click(screen.getByRole("button", { name: "30ml" }));
    // 저장 트랜잭션이 끝나기 전에 홈을 떠난다.
    fireEvent.click(screen.getByRole("button", { name: "기록 저장" }));
    fireEvent.click(screen.getByText("다른 화면"));

    expect(await screen.findByText("열린 위스키 시음을 기록했습니다")).toBeInTheDocument();
    expect(await db.tasting_session.count()).toBe(1);
    // 열 시트가 없는 "한 잔 더"를 남기지 않는다.
    expect(screen.queryByRole("button", { name: "한 잔 더" })).not.toBeInTheDocument();
  });

  it("다른 병을 쓰던 입력이 있어도 한 잔은 고른 병으로 열고 이전 입력은 그 병에 남긴다", async () => {
    await product("p1", "첫째 병");
    await product("p2", "둘째 병");
    await openBottle("b1", "p1");
    await openBottle("b2", "p2");
    renderHomePage();

    await userEvent.click(await screen.findByRole("button", { name: "마신 술 기록" }));
    const chooser = await screen.findByRole("dialog", { name: "무엇을 마셨나요?" });
    await userEvent.click(within(chooser).getByRole("button", { name: /첫째 병/ }));
    await userEvent.click(screen.getByRole("button", { name: "4점" }));
    await userEvent.click(screen.getByRole("button", { name: "닫기" }));

    await userEvent.click(screen.getByRole("button", { name: "둘째 병 #1 한 잔 기록" }));
    const dialog = await screen.findByRole("dialog", { name: "둘째 병" });
    expect(within(dialog).getByRole("button", { name: "4점" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "다른 술 고르기" }));
    await userEvent.click(within(dialog).getByRole("button", { name: /첫째 병/ }));
    expect(await screen.findByRole("dialog", { name: "첫째 병" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "4점" })).toHaveAttribute("aria-pressed", "true");
  });

  it("남은 양을 모두 마시면 소진으로 기록하고 그렇다고 알린다", async () => {
    await db.product.put(row({ id: "p1", name: "캔맥주" }));
    await db.sku.put(row({ id: "s1", product_id: "p1", volume_ml: 355 }));
    await db.purchase.put(row({ id: "pu1", sku_id: "s1", quantity: 1 }));
    await db.bottle.put(row({ id: "b1", purchase_id: "pu1", label_no: 1, status: "unopened" }));
    renderHomePage();

    await userEvent.click(await screen.findByRole("button", { name: "마신 술 기록" }));
    const dialog = await screen.findByRole("dialog", { name: "무엇을 마셨나요?" });
    await userEvent.click(within(dialog).getByRole("button", { name: /캔맥주/ }));
    await userEvent.click(screen.getByRole("button", { name: "남은 양 전부(355ml)" }));
    await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));

    expect(
      await screen.findByText("캔맥주 시음을 기록했습니다 (다 마셔 소진 처리)"),
    ).toBeInTheDocument();
    // 다 마신 병에는 한 잔 더를 권하지 않는다.
    expect(screen.getByRole("button", { name: "고치기" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "한 잔 더" })).not.toBeInTheDocument();
    const bottle = await db.bottle.get("b1");
    expect(bottle).toMatchObject({ status: "finished", remaining_ml: 0 });
  });

  it("열린 병의 한 잔으로 남은 양을 다 마시면 사라진 행 대신 주 행동으로 초점을 돌린다", async () => {
    await product("p1", "마지막 잔");
    await openBottle("b1", "p1", 1, 90);
    renderHomePage();

    await userEvent.click(await screen.findByRole("button", { name: "마지막 잔 #1 한 잔 기록" }));
    await userEvent.click(await screen.findByRole("button", { name: "남은 양 전부(90ml)" }));
    await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));

    expect(
      await screen.findByText("마지막 잔 시음을 기록했습니다 (다 마셔 소진 처리)"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "마지막 잔 #1 한 잔 기록" })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "마신 술 기록" })).toHaveFocus();
  });

  it("열린 병의 실제 개봉 경과일을 보이고 잔량 미기록을 빈 병으로 그리지 않는다", async () => {
    await db.category.put(row({ id: "wine", parent_id: null, name: "와인" }));
    await db.product.put(row({ id: "p1", name: "열어 둔 와인", category_id: "wine" }));
    await db.sku.put(row({ id: "s1", product_id: "p1", volume_ml: 750 }));
    await db.purchase.put(row({ id: "pu1", sku_id: "s1", quantity: 1 }));
    await db.bottle.put(
      row({ id: "b1", purchase_id: "pu1", label_no: 1, status: "open", opened_on: "2020-01-01" }),
    );

    renderHomePage();

    expect(await screen.findByText(/잔량 미기록 · 개봉 후 .*일 경과/)).toBeInTheDocument();
    expect(screen.queryByText(/권장 7일/)).not.toBeInTheDocument();
    expect(document.querySelector(".bottle-gauge--unknown")).not.toBeNull();
    expect(document.querySelector(".bottle-gauge-fill")).toBeNull();
  });
});

it("열린 병 전체 보기와 최근 시음이 대상 병·기록을 연다", async () => {
  await db.product.put(row({ id: "p", name: "GlenAllachie 12", category_id: null }));
  await db.sku.put(row({ id: "s", product_id: "p", volume_ml: 700 }));
  await db.purchase.put(row({ id: "pu", sku_id: "s", quantity: 7 }));
  await db.bottle.bulkPut(
    Array.from({ length: 7 }, (_, i) =>
      row({ id: `b${i}`, purchase_id: "pu", label_no: i + 1, status: "open", remaining_ml: 500 }),
    ),
  );
  await db.tasting_session.bulkPut([
    row({ id: "t", sku_id: "s", bottle_id: "b0", tasted_on: "2026-10-10", rating: "0.0" }),
    row({ id: "u", sku_id: "s", bottle_id: "b1", tasted_on: "2026-10-09", rating: null }),
  ]);
  const { onSelectProduct } = renderHomePage();
  await userEvent.click(await screen.findByRole("button", { name: "전체 7병 보기" }));
  expect(screen.getByRole("button", { name: "GlenAllachie 12 #7 · 700ml" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "GlenAllachie 12 #7 한 잔 기록" })).toBeInTheDocument();
  const recent = screen.getByRole("region", { name: "최근 시음" });
  // 0점과 평점 없음을 구분한다(QS05).
  const [zero, unrated] = within(recent).getAllByRole("button");
  expect(zero).toHaveTextContent("0 / 6");
  expect(unrated).toHaveTextContent("평점 없음");
  await userEvent.click(zero as HTMLElement);
  expect(onSelectProduct).toHaveBeenCalledWith("p", {
    skuId: "s",
    bottleId: "b0",
    tastingId: "t",
  });
});

it("같은 이름·용량의 열린 병은 번호로, 번호까지 같으면 구매일·구매처로 구분한다", async () => {
  await product("p1", "같은 위스키");
  await db.vendor.bulkPut([
    row({ id: "v-old", name: "오래된 매장" }),
    row({ id: "v-new", name: "새 매장" }),
  ]);
  // 같은 규격을 두 번 샀다. 병 번호는 구매마다 1부터 매긴다.
  await db.purchase.bulkPut([
    row({
      id: "pu-p1",
      sku_id: "s-p1",
      quantity: 2,
      purchased_on: "2025-01-01",
      vendor_id: "v-old",
    }),
    row({
      id: "pu-p1b",
      sku_id: "s-p1",
      quantity: 1,
      purchased_on: "2026-01-01",
      vendor_id: "v-new",
    }),
  ]);
  await openBottle("b-old-1", "p1", 1, 300);
  await openBottle("b-old-2", "p1", 2, 500);
  await db.bottle.put(
    row({
      id: "b-new-1",
      purchase_id: "pu-p1b",
      label_no: 1,
      status: "open",
      opened_on: "2026-01-03",
      remaining_ml: 600,
    }),
  );

  renderHomePage();

  expect(
    await screen.findByRole("button", {
      name: "같은 위스키 #1 · 구매 2025-01-01 · 오래된 매장 한 잔 기록",
    }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "같은 위스키 #1 · 구매 2026-01-01 · 새 매장 한 잔 기록" }),
  ).toBeInTheDocument();
  // 다른 번호인 2번 병은 번호만으로 구분한다.
  expect(screen.getByRole("button", { name: "같은 위스키 #2 한 잔 기록" })).toBeInTheDocument();
  expect(screen.getByText(/^#1 · 구매 2026-01-01 · 새 매장 · 600ml 남음/)).toBeInTheDocument();
  expect(screen.getByText(/^#2 · 500ml 남음/)).toBeInTheDocument();
});

it("하나뿐인 열린 병에는 번호·구매를 덧붙이지 않고 최근 시음에는 빈티지를 보인다", async () => {
  await db.product.put(row({ id: "w", name: "가상 샤토", vintage: 2009, abv: "13.5" }));
  await db.sku.put(row({ id: "s-w", product_id: "w", volume_ml: 750 }));
  await db.purchase.put(row({ id: "pu-w", sku_id: "s-w", quantity: 1 }));
  await openBottle("b-w", "w", 1, 400);
  await db.tasting_session.put(
    row({ id: "t-w", sku_id: "s-w", bottle_id: "b-w", tasted_on: "2026-10-10", rating: "4.0" }),
  );

  renderHomePage();

  expect(
    await screen.findByRole("button", { name: "가상 샤토 #1 한 잔 기록" }),
  ).toBeInTheDocument();
  expect(screen.getByText(/^400ml 남음/)).toBeInTheDocument();
  const recent = screen.getByRole("region", { name: "최근 시음" });
  expect(within(recent).getByRole("button")).toHaveTextContent("2026-10-10 · 1번 병 · 2009 빈티지");
});
