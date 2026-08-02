import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bottle, Tasting, TastingSummary } from "@/api/types";
import { BottlePanel, formatRatingChange, formatRemaining } from "@/components/BottlePanel";
import { db } from "@/sync/db";
import { renderWithQuery, stubRoutes } from "@/testing";

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

function bottle(overrides: Partial<Bottle> = {}): Bottle {
  return {
    id: "b1",
    purchase_id: "pu1",
    label_no: 1,
    status: "unopened",
    opened_on: null,
    finished_on: null,
    remaining_ml: null,
    storage_location: null,
    note: null,
    ...overrides,
  };
}

/** 전이·시음 기록 뮤테이션이 참조하는 sku·purchase·bottle 로컬 미러를 시딩한다. */
async function seedContext(
  bottleRow: Bottle,
  opts: { skuId?: string; volumeMl?: number; noSku?: boolean } = {},
) {
  const skuId = opts.skuId ?? "sku1";
  if (!opts.noSku) {
    await db.sku.put(row({ id: skuId, product_id: "p1", volume_ml: opts.volumeMl ?? 700 }));
  }
  await db.purchase.put(row({ id: bottleRow.purchase_id, sku_id: opts.noSku ? null : skuId }));
  await db.bottle.put(row({ ...bottleRow }));
}

function stubTastings(
  bottleId: string,
  opts: { tastings?: Tasting[]; summary?: Partial<TastingSummary>; tastingsStatus?: number } = {},
) {
  return stubRoutes([
    {
      match: `/bottles/${bottleId}/tastings`,
      body: opts.tastings ?? [],
      ...(opts.tastingsStatus ? { status: opts.tastingsStatus } : {}),
    },
    {
      match: "/tastings/summary",
      body: {
        session_count: 0,
        rated_count: 0,
        average_rating: null,
        first_rating: null,
        latest_rating: null,
        rating_change: null,
        total_poured_ml: 0,
        first_tasted_on: null,
        latest_tasted_on: null,
        ...opts.summary,
      },
    },
    { match: "/tastings/", method: "DELETE", status: 204, body: null },
  ]);
}

beforeEach(async () => {
  await db.open();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all([
    db.sku.clear(),
    db.purchase.clear(),
    db.bottle.clear(),
    db.tasting_session.clear(),
    db.outbox.clear(),
  ]);
});

describe("formatRemaining", () => {
  it("미개봉이면 전량이라고 표시한다", () => {
    expect(formatRemaining(bottle({ status: "unopened", remaining_ml: null }))).toBe(
      "미개봉 (전량)",
    );
  });

  it("개봉했지만 잔량이 기록되지 않았으면 미기록이라고 표시한다", () => {
    expect(formatRemaining(bottle({ status: "open", remaining_ml: null }))).toBe("잔량 미기록");
  });

  it("잔량이 있으면 ml 단위로 표시한다", () => {
    expect(formatRemaining(bottle({ status: "open", remaining_ml: 350 }))).toBe("350ml");
  });
});

describe("formatRatingChange", () => {
  it("비교 기록이 없으면 안내한다", () => {
    expect(formatRatingChange(null)).toBe("비교할 기록 없음");
  });

  it("숫자로 해석할 수 없으면 안내한다", () => {
    expect(formatRatingChange("모름")).toBe("비교할 기록 없음");
  });

  it("변화가 없으면 명시한다", () => {
    expect(formatRatingChange("0")).toBe("변화 없음");
  });

  it("올랐으면 부호와 함께 좋아졌다고 표시한다", () => {
    expect(formatRatingChange("0.5")).toBe("+0.5 (좋아짐)");
  });

  it("내렸으면 부호와 함께 낮아졌다고 표시한다", () => {
    expect(formatRatingChange("-1.0")).toBe("-1.0 (낮아짐)");
  });
});

describe("BottlePanel", () => {
  it("병 번호와 상태 배지, 개봉·소진일을 보여준다", async () => {
    const target = bottle({
      status: "finished",
      opened_on: "2026-02-01",
      finished_on: "2026-02-10",
      remaining_ml: 0,
    });
    stubTastings(target.id);
    renderWithQuery(<BottlePanel bottle={target} />);

    expect(screen.getByRole("heading", { name: /1번 병/ })).toBeInTheDocument();
    expect(screen.getByText("소진")).toBeInTheDocument();
    expect(screen.getByText("2026-02-01")).toBeInTheDocument();
    expect(screen.getByText("2026-02-10")).toBeInTheDocument();
  });

  it("날짜가 없으면 대시로 표시한다", () => {
    stubTastings("b1");
    renderWithQuery(<BottlePanel bottle={bottle()} />);

    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  describe("상태별 버튼 노출", () => {
    it("미개봉이면 개봉·증여·판매만 있다", () => {
      stubTastings("b1");
      renderWithQuery(<BottlePanel bottle={bottle({ status: "unopened" })} />);

      expect(screen.getByRole("button", { name: "개봉" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "증여" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "판매" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "소진" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "개봉 취소" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "되돌리기" })).not.toBeInTheDocument();
    });

    it("개봉 상태면 소진·개봉 취소·증여·판매가 있다", () => {
      stubTastings("b1");
      renderWithQuery(<BottlePanel bottle={bottle({ status: "open" })} />);

      expect(screen.getByRole("button", { name: "소진" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "개봉 취소" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "증여" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "판매" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "개봉" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "되돌리기" })).not.toBeInTheDocument();
    });

    it.each(["finished", "gifted", "sold"] as const)("%s 상태면 되돌리기만 있다", (status) => {
      stubTastings("b1");
      renderWithQuery(<BottlePanel bottle={bottle({ status })} />);

      expect(screen.getByRole("button", { name: "되돌리기" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "개봉" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "소진" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "개봉 취소" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "증여" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "판매" })).not.toBeInTheDocument();
    });
  });

  describe("상태 전이", () => {
    it("개봉을 누르면 상태·개봉일·잔량이 규격 용량으로 바뀐다", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const target = bottle({ status: "unopened" });
      await seedContext(target, { volumeMl: 700 });
      stubTastings(target.id);
      renderWithQuery(<BottlePanel bottle={target} />);

      await userEvent.click(screen.getByRole("button", { name: "개봉" }));

      await waitFor(async () => {
        const updated = await db.bottle.get(target.id);
        expect(updated?.status).toBe("open");
        expect(updated?.opened_on).toBe(today);
        expect(updated?.remaining_ml).toBe(700);
      });
    });

    it("소진을 누르면 상태가 finished 로 바뀌고 잔량이 0 이 된다", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const target = bottle({ status: "open", opened_on: "2026-01-15", remaining_ml: 400 });
      await seedContext(target);
      stubTastings(target.id);
      renderWithQuery(<BottlePanel bottle={target} />);

      await userEvent.click(screen.getByRole("button", { name: "소진" }));

      await waitFor(async () => {
        const updated = await db.bottle.get(target.id);
        expect(updated?.status).toBe("finished");
        expect(updated?.remaining_ml).toBe(0);
        expect(updated?.finished_on).toBe(today);
      });
    });

    it("되돌리기를 누르면 개봉 상태로 돌아가고 소진일이 지워진다", async () => {
      const target = bottle({
        status: "finished",
        opened_on: "2026-01-15",
        finished_on: "2026-01-20",
        remaining_ml: 0,
      });
      await seedContext(target);
      stubTastings(target.id);
      renderWithQuery(<BottlePanel bottle={target} />);

      await userEvent.click(screen.getByRole("button", { name: "되돌리기" }));

      await waitFor(async () => {
        const updated = await db.bottle.get(target.id);
        expect(updated?.status).toBe("open");
        expect(updated?.finished_on).toBeNull();
        expect(updated?.opened_on).toBe("2026-01-15");
      });
    });

    it("개봉 취소를 누르면 미개봉 상태로 돌아가고 개봉일·잔량이 지워진다", async () => {
      const target = bottle({ status: "open", opened_on: "2026-01-15", remaining_ml: 500 });
      await seedContext(target);
      stubTastings(target.id);
      renderWithQuery(<BottlePanel bottle={target} />);

      await userEvent.click(screen.getByRole("button", { name: "개봉 취소" }));

      await waitFor(async () => {
        const updated = await db.bottle.get(target.id);
        expect(updated?.status).toBe("unopened");
        expect(updated?.opened_on).toBeNull();
        expect(updated?.remaining_ml).toBeNull();
      });
    });

    it("증여는 확인을 취소하면 상태가 바뀌지 않는다", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      const target = bottle({ status: "unopened" });
      await seedContext(target);
      stubTastings(target.id);
      renderWithQuery(<BottlePanel bottle={target} />);

      await userEvent.click(screen.getByRole("button", { name: "증여" }));

      const updated = await db.bottle.get(target.id);
      expect(updated?.status).toBe("unopened");
      confirmSpy.mockRestore();
    });

    it("증여를 확인하면 상태가 gifted 로 바뀐다", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      const target = bottle({ status: "unopened" });
      await seedContext(target);
      stubTastings(target.id);
      renderWithQuery(<BottlePanel bottle={target} />);

      await userEvent.click(screen.getByRole("button", { name: "증여" }));

      await waitFor(async () => {
        const updated = await db.bottle.get(target.id);
        expect(updated?.status).toBe("gifted");
        expect(updated?.finished_on).toBe(today);
      });
      confirmSpy.mockRestore();
    });

    it("판매를 확인하면 상태가 sold 로 바뀐다", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      const target = bottle({ status: "open" });
      await seedContext(target);
      stubTastings(target.id);
      renderWithQuery(<BottlePanel bottle={target} />);

      await userEvent.click(screen.getByRole("button", { name: "판매" }));

      await waitFor(async () => {
        const updated = await db.bottle.get(target.id);
        expect(updated?.status).toBe("sold");
      });
      confirmSpy.mockRestore();
    });

    it("로컬에 병 정보가 없으면 오류를 보여준다", async () => {
      const target = bottle({ status: "unopened" });
      // db.bottle 을 시딩하지 않아 전이 뮤테이션이 병을 찾지 못하게 한다.
      stubTastings(target.id);
      renderWithQuery(<BottlePanel bottle={target} />);

      await userEvent.click(screen.getByRole("button", { name: "개봉" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("병을 찾을 수 없습니다");
    });
  });

  describe("시음 요약", () => {
    it("시음 기록이 없으면 요약을 보여주지 않는다", async () => {
      const target = bottle();
      stubTastings(target.id, { summary: { session_count: 0 } });
      renderWithQuery(<BottlePanel bottle={target} />);

      await screen.findByText("시음 기록하기");
      expect(screen.queryByText("시음 횟수")).not.toBeInTheDocument();
    });

    it("시음 기록이 있으면 횟수·평균·변화·따른 양을 보여준다", async () => {
      const target = bottle();
      stubTastings(target.id, {
        summary: {
          session_count: 3,
          average_rating: "4.5",
          rating_change: "0.5",
          total_poured_ml: 900,
        },
      });
      renderWithQuery(<BottlePanel bottle={target} />);

      expect(await screen.findByText("시음 횟수")).toBeInTheDocument();
      expect(screen.getByText("3회")).toBeInTheDocument();
      expect(screen.getByText("4.5", { selector: "dd" })).toBeInTheDocument();
      expect(screen.getByText("+0.5 (좋아짐)")).toBeInTheDocument();
      expect(screen.getByText("900ml")).toBeInTheDocument();
    });

    it("평균 평점이 없으면 기록 없음이라고 표시한다", async () => {
      const target = bottle();
      stubTastings(target.id, { summary: { session_count: 2, average_rating: null } });
      renderWithQuery(<BottlePanel bottle={target} />);

      expect(await screen.findByText("기록 없음")).toBeInTheDocument();
    });
  });

  describe("시음 기록 타임라인", () => {
    it("불러오는 중에는 로딩 상태를 보여준다", () => {
      stubTastings("b1");
      renderWithQuery(<BottlePanel bottle={bottle()} />);

      expect(screen.getByText("불러오는 중…")).toBeInTheDocument();
    });

    it("오프라인 등으로 실패하면 안내 문구를 보여준다", async () => {
      // 스텁을 걸지 않아 실제 fetch 가 실패하도록 둔다.
      renderWithQuery(<BottlePanel bottle={bottle()} />);

      expect(
        await screen.findByText("오프라인에서는 시음 기록을 불러올 수 없습니다."),
      ).toBeInTheDocument();
    });

    it("기록이 없으면 안내한다", async () => {
      const target = bottle();
      stubTastings(target.id, { tastings: [] });
      renderWithQuery(<BottlePanel bottle={target} />);

      expect(await screen.findByText("아직 기록이 없습니다.")).toBeInTheDocument();
    });

    it("기록을 날짜·평점·메모와 함께 보여준다", async () => {
      const target = bottle();
      const full: Tasting = {
        id: "t1",
        bottle_id: target.id,
        sku_id: "sku1",
        tasted_on: "2026-01-10",
        poured_ml: 30,
        rating: "4.5",
        nose: "바닐라",
        palate: "꿀",
        finish: "긴 여운",
        note: null,
        place: "집",
        companions: "혼자",
      };
      const minimal: Tasting = {
        id: "t2",
        bottle_id: target.id,
        sku_id: "sku1",
        tasted_on: "2026-01-05",
        poured_ml: null,
        rating: null,
        nose: null,
        palate: null,
        finish: null,
        note: null,
        place: null,
        companions: null,
      };
      stubTastings(target.id, { tastings: [full, minimal] });
      renderWithQuery(<BottlePanel bottle={target} />);

      expect(await screen.findByText("2026-01-10")).toBeInTheDocument();
      expect(screen.getByText("4.5점")).toBeInTheDocument();
      expect(screen.getByText("30ml")).toBeInTheDocument();
      expect(screen.getByText("향: 바닐라")).toBeInTheDocument();
      expect(screen.getByText("맛: 꿀")).toBeInTheDocument();
      expect(screen.getByText("피니시: 긴 여운")).toBeInTheDocument();
      expect(screen.getByText("집 · 혼자")).toBeInTheDocument();

      expect(screen.getByText("2026-01-05")).toBeInTheDocument();
      expect(screen.getByText("평점 없음", { selector: "span" })).toBeInTheDocument();
    });
  });

  describe("시음 기록 삭제", () => {
    const item: Tasting = {
      id: "t1",
      bottle_id: "b1",
      sku_id: "sku1",
      tasted_on: "2026-01-10",
      poured_ml: null,
      rating: null,
      nose: null,
      palate: null,
      finish: null,
      note: null,
      place: null,
      companions: null,
    };

    it("오프라인이면 삭제 버튼을 숨기고 안내한다", async () => {
      const target = bottle();
      stubTastings(target.id, { tastings: [item] });
      renderWithQuery(<BottlePanel bottle={target} offline={true} />);

      await screen.findByText("2026-01-10");
      expect(screen.queryByRole("button", { name: "삭제" })).not.toBeInTheDocument();
      expect(
        screen.getByText("시음 기록 삭제는 온라인일 때만 할 수 있습니다."),
      ).toBeInTheDocument();
    });

    it("확인을 취소하면 삭제 요청을 보내지 않는다", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      const target = bottle();
      const { calls } = stubTastings(target.id, { tastings: [item] });
      renderWithQuery(<BottlePanel bottle={target} />);

      await userEvent.click(await screen.findByRole("button", { name: "삭제" }));

      expect(calls.some((call) => call.method === "DELETE")).toBe(false);
      confirmSpy.mockRestore();
    });

    it("확인하면 시음 기록을 삭제한다", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      const target = bottle();
      const { calls } = stubTastings(target.id, { tastings: [item] });
      renderWithQuery(<BottlePanel bottle={target} />);

      await userEvent.click(await screen.findByRole("button", { name: "삭제" }));

      await waitFor(() => {
        expect(
          calls.some((call) => call.method === "DELETE" && call.url.includes("/tastings/t1")),
        ).toBe(true);
      });
      confirmSpy.mockRestore();
    });
  });

  describe("시음 기록하기 폼", () => {
    it("최소 입력(마신 날만)으로 제출하면 outbox 에 기록이 쌓인다", async () => {
      const target = bottle({ status: "open", remaining_ml: 700 });
      await seedContext(target);
      stubTastings(target.id);
      renderWithQuery(<BottlePanel bottle={target} />);

      await userEvent.click(await screen.findByRole("button", { name: "기록 저장" }));

      await waitFor(async () => {
        const entries = await db.outbox.toArray();
        expect(entries.some((entry) => entry.entity === "tasting_session")).toBe(true);
      });
    });

    it("따른 양을 입력하면 잔량에서 차감되고, 다 마시면 자동으로 소진 처리한다", async () => {
      const target = bottle({ status: "open", remaining_ml: 200 });
      await seedContext(target);
      stubTastings(target.id);
      renderWithQuery(<BottlePanel bottle={target} />);

      await userEvent.type(screen.getByLabelText("따른 양 (ml)"), "200");
      await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));

      await waitFor(async () => {
        const updated = await db.bottle.get(target.id);
        expect(updated?.remaining_ml).toBe(0);
        expect(updated?.status).toBe("finished");
      });
    });

    it("미개봉 병에서 시음을 기록하면 자동으로 개봉 처리한다", async () => {
      const target = bottle({ status: "unopened", remaining_ml: null });
      await seedContext(target, { volumeMl: 500 });
      stubTastings(target.id);
      renderWithQuery(<BottlePanel bottle={target} />);

      await userEvent.type(screen.getByLabelText("따른 양 (ml)"), "50");
      await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));

      await waitFor(async () => {
        const updated = await db.bottle.get(target.id);
        expect(updated?.status).toBe("open");
        expect(updated?.remaining_ml).toBe(450);
      });
    });

    it("잔량보다 많이 따르면 오류를 보여주고 저장하지 않는다", async () => {
      const target = bottle({ status: "open", remaining_ml: 100 });
      await seedContext(target);
      stubTastings(target.id);
      renderWithQuery(<BottlePanel bottle={target} />);

      await userEvent.type(screen.getByLabelText("따른 양 (ml)"), "150");
      await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));

      expect(await screen.findByText(/잔량이 부족합니다/)).toBeInTheDocument();
      const updated = await db.bottle.get(target.id);
      expect(updated?.remaining_ml).toBe(100);
    });

    it("증여·판매된 병에는 시음을 기록할 수 없다", async () => {
      const target = bottle({ status: "gifted", finished_on: "2026-01-01" });
      await seedContext(target);
      stubTastings(target.id);
      renderWithQuery(<BottlePanel bottle={target} />);

      await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));

      expect(await screen.findByText(/내보낸 병은 시음을 기록할 수 없습니다/)).toBeInTheDocument();
    });

    it("규격을 알 수 없으면 저장할 수 없다고 안내한다", async () => {
      const target = bottle({ status: "open" });
      await seedContext(target, { noSku: true });
      stubTastings(target.id);
      renderWithQuery(<BottlePanel bottle={target} />);

      await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));

      expect(await screen.findByText(/무엇을 마셨는지 확인할 수 없습니다/)).toBeInTheDocument();
    });

    it("저장에 성공하면 따른 양·평점·메모 입력을 비운다", async () => {
      const target = bottle({ status: "open", remaining_ml: 700 });
      await seedContext(target);
      stubTastings(target.id);
      renderWithQuery(<BottlePanel bottle={target} />);

      await userEvent.type(screen.getByLabelText("따른 양 (ml)"), "30");
      await userEvent.selectOptions(screen.getByLabelText("평점 (6점 만점)"), "4.5");
      await userEvent.type(screen.getByLabelText("향"), "바닐라");
      await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));

      await waitFor(() => {
        expect(screen.getByLabelText("따른 양 (ml)")).toHaveValue(null);
        expect(screen.getByLabelText("향")).toHaveValue("");
      });
    });
  });
});
