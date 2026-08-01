/**
 * 병 화면 테스트.
 *
 * 잔량 `null` 을 0ml 로 표시하면 "다 마셨다"고 오해하게 된다. 그 경계를 고정한다.
 *
 * 목록은 이제 Dexie 로컬 미러에서 읽는다(오프라인에서도 재고를 봐야 한다). 상태 전이·
 * 시음 기록은 outbox 를 거치므로, 네트워크 호출 대신 `db.outbox`/`db.bottle` 에 쌓인
 * 내용으로 검증한다. 시음 타임라인·요약은 아직 네트워크 조회로 남아 있다.
 */

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Tasting, TastingSummary } from "@/api/types";
import { formatRatingChange, formatRemaining } from "@/components/BottlePanel";
import { BottlesPage } from "@/pages/BottlesPage";
import { db } from "@/sync/db";
import { authenticatedRoutes, renderWithQuery, stubRoutes } from "@/testing";

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

const unopenedBottle = {
  id: "b1",
  purchase_id: "p1",
  label_no: 1,
  status: "unopened" as const,
  opened_on: null,
  finished_on: null,
  remaining_ml: null,
  storage_location: null,
  note: null,
};

const openedBottle = {
  ...unopenedBottle,
  id: "b2",
  label_no: 2,
  status: "open" as const,
  opened_on: "2026-03-01",
  remaining_ml: 600,
};

async function seedPurchase(volumeMl = 700) {
  await db.sku.put(row({ id: "s1", product_id: "prod1", volume_ml: volumeMl }));
  await db.purchase.put(row({ id: "p1", sku_id: "s1", quantity: 1 }));
}

async function seedBottles(...bottles: Record<string, unknown>[]) {
  await db.bottle.bulkPut(bottles.map((b) => row(b)));
}

const emptySummary: TastingSummary = {
  session_count: 0,
  rated_count: 0,
  average_rating: null,
  first_rating: null,
  latest_rating: null,
  rating_change: null,
  total_poured_ml: 0,
  first_tasted_on: null,
  latest_tasted_on: null,
};

beforeEach(async () => {
  await db.open();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await db.transaction(
    "rw",
    [db.bottle, db.purchase, db.sku, db.outbox, db.tasting_session],
    async () => {
      await Promise.all([
        db.bottle.clear(),
        db.purchase.clear(),
        db.sku.clear(),
        db.outbox.clear(),
        db.tasting_session.clear(),
      ]);
    },
  );
});

describe("formatRemaining", () => {
  it("미개봉은 전량으로 표시한다", () => {
    // null 을 0ml 로 표시하면 다 마셨다고 오해하게 된다.
    expect(formatRemaining(unopenedBottle)).toBe("미개봉 (전량)");
  });

  it("개봉한 병은 잔량을 천단위 구분해 표시한다", () => {
    expect(formatRemaining({ ...openedBottle, remaining_ml: 1200 })).toBe("1,200ml");
  });

  it("개봉했지만 잔량을 모르면 미기록으로 표시한다", () => {
    expect(formatRemaining({ ...openedBottle, remaining_ml: null })).toBe("잔량 미기록");
  });

  it("잔량 0은 0ml 로 표시한다", () => {
    expect(formatRemaining({ ...openedBottle, remaining_ml: 0 })).toBe("0ml");
  });
});

describe("formatRatingChange", () => {
  it("올랐으면 부호와 함께 좋아짐을 알린다", () => {
    expect(formatRatingChange("1.5")).toBe("+1.5 (좋아짐)");
  });

  it("내렸으면 낮아짐을 알린다", () => {
    expect(formatRatingChange("-0.5")).toBe("-0.5 (낮아짐)");
  });

  it("같으면 변화 없음", () => {
    expect(formatRatingChange("0.0")).toBe("변화 없음");
  });

  it("비교할 기록이 없으면 그렇게 알린다", () => {
    expect(formatRatingChange(null)).toBe("비교할 기록 없음");
  });
});

describe("BottlesPage", () => {
  it("재고 병 목록을 보여준다", async () => {
    await seedPurchase();
    await seedBottles(unopenedBottle, openedBottle);
    renderWithQuery(<BottlesPage />);

    expect(await screen.findByText("1번 병")).toBeInTheDocument();
    expect(screen.getByText("2번 병")).toBeInTheDocument();
  });

  it("기본 필터는 재고다", async () => {
    await seedPurchase();
    await seedBottles(unopenedBottle, {
      ...openedBottle,
      id: "b3",
      label_no: 3,
      status: "finished",
      remaining_ml: 0,
      finished_on: "2026-02-01",
    });
    renderWithQuery(<BottlesPage />);

    await screen.findByText("1번 병");
    // 이미 마셔 버린 병까지 섞으면 지금 뭘 마실 수 있는지 찾기 어렵다.
    expect(screen.queryByText("3번 병")).not.toBeInTheDocument();
  });

  it("필터를 바꾸면 상태로 조회한다", async () => {
    await seedPurchase();
    await seedBottles(unopenedBottle, {
      ...openedBottle,
      id: "b3",
      label_no: 3,
      status: "finished",
      remaining_ml: 0,
      finished_on: "2026-02-01",
    });
    renderWithQuery(<BottlesPage />);

    await screen.findByText("1번 병");
    await userEvent.click(await screen.findByRole("button", { name: "소진" }));

    await waitFor(() => expect(screen.getByText("3번 병")).toBeInTheDocument());
    expect(screen.queryByText("1번 병")).not.toBeInTheDocument();
  });

  it("병이 없으면 안내를 보여준다", async () => {
    renderWithQuery(<BottlesPage />);

    expect(await screen.findByText(/해당하는 병이 없습니다/)).toBeInTheDocument();
  });

  it("병을 펼치면 상태 전이 버튼이 나온다", async () => {
    await seedPurchase();
    await seedBottles(unopenedBottle);
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/bottles/b1/tastings", body: [] as Tasting[] },
      { match: "/tastings/summary", body: emptySummary },
    ]);
    renderWithQuery(<BottlesPage />);

    await userEvent.click(await screen.findByRole("button", { name: /1번 병/ }));

    // 필터에도 "개봉"·"소진" 버튼이 있으므로 상태 전이 영역으로 범위를 좁힌다.
    const actions = await screen.findByRole("group", { name: "상태 바꾸기" });
    // 미개봉이므로 개봉만 가능하고 소진은 보이지 않는다.
    expect(within(actions).getByRole("button", { name: "개봉" })).toBeInTheDocument();
    expect(within(actions).queryByRole("button", { name: "소진" })).not.toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: "증여" })).toBeInTheDocument();
  });

  it("증여는 확인을 받는다", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await seedPurchase();
    await seedBottles(unopenedBottle);
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/bottles/b1/tastings", body: [] as Tasting[] },
      { match: "/tastings/summary", body: emptySummary },
    ]);
    renderWithQuery(<BottlesPage />);

    await userEvent.click(await screen.findByRole("button", { name: /1번 병/ }));
    await userEvent.click(await screen.findByRole("button", { name: "증여" }));

    expect(confirmSpy).toHaveBeenCalled();
    // 취소했으므로 outbox 에 아무것도 쌓이지 않는다.
    expect(await db.outbox.count()).toBe(0);
    expect((await db.bottle.get("b1"))?.status).toBe("unopened");
  });

  it("개봉하면 outbox 에 쌓이고 잔량이 규격 용량으로 낙관적으로 반영된다", async () => {
    await seedPurchase(700);
    await seedBottles(unopenedBottle);
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/bottles/b1/tastings", body: [] as Tasting[] },
      { match: "/tastings/summary", body: emptySummary },
    ]);
    renderWithQuery(<BottlesPage />);

    await userEvent.click(await screen.findByRole("button", { name: /1번 병/ }));
    const actions = await screen.findByRole("group", { name: "상태 바꾸기" });
    await userEvent.click(within(actions).getByRole("button", { name: "개봉" }));

    await waitFor(async () => {
      const entries = await db.outbox.toArray();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ entity: "bottle", op: "action", action: "open" });
    });
    const bottle = await db.bottle.get("b1");
    expect(bottle?.status).toBe("open");
    expect(bottle?.remaining_ml).toBe(700);
  });

  it("소진하면 잔량이 0 이 되고 되돌리기로 다시 개봉 상태가 된다", async () => {
    await seedPurchase();
    await seedBottles(openedBottle);
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/bottles/b2/tastings", body: [] as Tasting[] },
      { match: "/tastings/summary", body: emptySummary },
    ]);
    renderWithQuery(<BottlesPage />);

    // "재고" 필터에 있으면 소진 직후 목록에서 빠져 패널이 같이 사라진다 — "전체" 로 본다.
    await userEvent.click(await screen.findByRole("button", { name: "전체" }));
    await userEvent.click(await screen.findByRole("button", { name: /2번 병/ }));
    let actions = await screen.findByRole("group", { name: "상태 바꾸기" });
    await userEvent.click(within(actions).getByRole("button", { name: "소진" }));

    await waitFor(async () => {
      expect((await db.bottle.get("b2"))?.status).toBe("finished");
    });
    expect((await db.bottle.get("b2"))?.remaining_ml).toBe(0);

    actions = await screen.findByRole("group", { name: "상태 바꾸기" });
    await userEvent.click(within(actions).getByRole("button", { name: "되돌리기" }));

    await waitFor(async () => {
      expect((await db.bottle.get("b2"))?.status).toBe("open");
    });
    expect((await db.bottle.get("b2"))?.finished_on).toBeNull();
  });

  it("증여를 확인하면 outbox 에 쌓이고 재고에서 빠진다", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await seedPurchase();
    await seedBottles(unopenedBottle);
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/bottles/b1/tastings", body: [] as Tasting[] },
      { match: "/tastings/summary", body: emptySummary },
    ]);
    renderWithQuery(<BottlesPage />);

    await userEvent.click(await screen.findByRole("button", { name: /1번 병/ }));
    await userEvent.click(await screen.findByRole("button", { name: "증여" }));

    await waitFor(async () => {
      const entries = await db.outbox.toArray();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ entity: "bottle", op: "action", action: "gift" });
    });
    expect((await db.bottle.get("b1"))?.status).toBe("gifted");
  });

  it("판매를 확인하면 병이 재고에서 빠진다", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await seedPurchase();
    await seedBottles(unopenedBottle);
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/bottles/b1/tastings", body: [] as Tasting[] },
      { match: "/tastings/summary", body: emptySummary },
    ]);
    renderWithQuery(<BottlesPage />);

    await userEvent.click(await screen.findByRole("button", { name: /1번 병/ }));
    await userEvent.click(await screen.findByRole("button", { name: "판매" }));

    await waitFor(async () => {
      expect((await db.bottle.get("b1"))?.status).toBe("sold");
    });
  });

  it("시음 폼에 평점 척도가 6점 만점 0.5 단위로 노출된다", async () => {
    await seedPurchase();
    await seedBottles(openedBottle);
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/bottles/b2/tastings", body: [] as Tasting[] },
      { match: "/tastings/summary", body: emptySummary },
    ]);
    renderWithQuery(<BottlesPage />);

    await userEvent.click(await screen.findByRole("button", { name: /2번 병/ }));

    const select = await screen.findByLabelText("평점 (6점 만점)");
    const options = Array.from(select.querySelectorAll("option")).map((node) => node.value);
    expect(options).toContain("6.0");
    expect(options).toContain("0.5");
    expect(options).not.toContain("6.5");
    // 0.5 단위 13개 + "평점 없음"
    expect(options).toHaveLength(14);
  });

  it("시음을 저장하면 outbox 에 쌓이고 잔량이 낙관적으로 차감된다", async () => {
    await seedPurchase();
    await seedBottles(openedBottle);
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/bottles/b2/tastings", body: [] as Tasting[] },
      { match: "/tastings/summary", body: emptySummary },
    ]);
    renderWithQuery(<BottlesPage />);

    await userEvent.click(await screen.findByRole("button", { name: /2번 병/ }));
    await userEvent.type(await screen.findByLabelText("따른 양 (ml)"), "40");
    await userEvent.selectOptions(screen.getByLabelText("평점 (6점 만점)"), "4.5");
    await userEvent.type(screen.getByLabelText("향"), "훈연");
    await userEvent.type(screen.getByLabelText("맛"), "달콤");
    await userEvent.type(screen.getByLabelText("피니시"), "길다");
    await userEvent.type(screen.getByLabelText("장소"), "집");
    await userEvent.type(screen.getByLabelText("동석자"), "혼자");
    await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));

    await waitFor(async () => {
      const entries = await db.outbox.toArray();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        entity: "tasting_session",
        op: "action",
        action: "record_tasting",
      });
      expect(entries[0]?.fields).toMatchObject({
        bottle_id: "b2",
        poured_ml: 40,
        rating: "4.5",
        nose: "훈연",
        palate: "달콤",
        finish: "길다",
        place: "집",
        companions: "혼자",
      });
    });
    // 개봉한 병(잔량 600ml)에서 40ml 을 따랐으므로 560ml 이 남는다.
    expect((await db.bottle.get("b2"))?.remaining_ml).toBe(560);
  });

  it("잔량 초과는 로컬에서 바로 거부한다", async () => {
    await seedPurchase();
    await seedBottles(openedBottle);
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/bottles/b2/tastings", body: [] as Tasting[] },
      { match: "/tastings/summary", body: emptySummary },
    ]);
    renderWithQuery(<BottlesPage />);

    await userEvent.click(await screen.findByRole("button", { name: /2번 병/ }));
    await userEvent.type(await screen.findByLabelText("따른 양 (ml)"), "9999");
    await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("잔량이 부족합니다");
    expect(await db.outbox.count()).toBe(0);
  });

  it("시음 기록을 타임라인으로 보여준다", async () => {
    const tasting: Tasting = {
      id: "t1",
      bottle_id: "b2",
      sku_id: "s1",
      tasted_on: "2026-05-10",
      poured_ml: 60,
      rating: "5.0",
      nose: "훈연",
      palate: "달콤함",
      finish: "길게 남음",
      note: null,
      place: "집",
      companions: "친구",
    };
    await seedPurchase();
    await seedBottles(openedBottle);
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/bottles/b2/tastings", body: [tasting] },
      {
        match: "/tastings/summary",
        body: {
          ...emptySummary,
          session_count: 1,
          rated_count: 1,
          average_rating: "5.00",
          first_rating: "5.0",
          latest_rating: "5.0",
          rating_change: "0.0",
          total_poured_ml: 60,
        },
      },
    ]);
    renderWithQuery(<BottlesPage />);

    await userEvent.click(await screen.findByRole("button", { name: /2번 병/ }));

    expect(await screen.findByText("2026-05-10")).toBeInTheDocument();
    expect(screen.getByText("5.0점")).toBeInTheDocument();
    expect(screen.getByText("향: 훈연")).toBeInTheDocument();
    expect(screen.getByText("맛: 달콤함")).toBeInTheDocument();
    expect(screen.getByText("피니시: 길게 남음")).toBeInTheDocument();
    expect(screen.getByText("집 · 친구")).toBeInTheDocument();
    expect(screen.getByText("변화 없음")).toBeInTheDocument();
  });
});
