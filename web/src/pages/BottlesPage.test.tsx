/**
 * 병 화면 테스트.
 *
 * 잔량 `null` 을 0ml 로 표시하면 "다 마셨다"고 오해하게 된다. 그 경계를 고정한다.
 */

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Bottle, Tasting, TastingSummary } from "@/api/types";
import { formatRatingChange, formatRemaining } from "@/components/BottlePanel";
import { BottlesPage } from "@/pages/BottlesPage";
import { authenticatedRoutes, renderWithQuery, stubRoutes } from "@/testing";

const unopened: Bottle = {
  id: "b1",
  purchase_id: "p1",
  label_no: 1,
  status: "unopened",
  opened_on: null,
  finished_on: null,
  remaining_ml: null,
  storage_location: null,
  note: null,
};

const opened: Bottle = {
  ...unopened,
  id: "b2",
  label_no: 2,
  status: "open",
  opened_on: "2026-03-01",
  remaining_ml: 600,
};

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("formatRemaining", () => {
  it("미개봉은 전량으로 표시한다", () => {
    // null 을 0ml 로 표시하면 다 마셨다고 오해하게 된다.
    expect(formatRemaining(unopened)).toBe("미개봉 (전량)");
  });

  it("개봉한 병은 잔량을 천단위 구분해 표시한다", () => {
    expect(formatRemaining({ ...opened, remaining_ml: 1200 })).toBe("1,200ml");
  });

  it("개봉했지만 잔량을 모르면 미기록으로 표시한다", () => {
    expect(formatRemaining({ ...opened, remaining_ml: null })).toBe("잔량 미기록");
  });

  it("잔량 0은 0ml 로 표시한다", () => {
    expect(formatRemaining({ ...opened, remaining_ml: 0 })).toBe("0ml");
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
    stubRoutes([...authenticatedRoutes(), { match: "/bottles", body: [unopened, opened] }]);
    renderWithQuery(<BottlesPage />);

    expect(await screen.findByText("1번 병")).toBeInTheDocument();
    expect(screen.getByText("2번 병")).toBeInTheDocument();
  });

  it("기본 필터는 재고다", async () => {
    const { calls } = stubRoutes([
      ...authenticatedRoutes(),
      { match: "/bottles", body: [unopened] },
    ]);
    renderWithQuery(<BottlesPage />);

    await screen.findByText("1번 병");
    // 이미 마셔 버린 병까지 섞으면 지금 뭘 마실 수 있는지 찾기 어렵다.
    expect(calls.some((call) => call.url.includes("in_stock=true"))).toBe(true);
  });

  it("필터를 바꾸면 상태로 조회한다", async () => {
    const { calls } = stubRoutes([
      ...authenticatedRoutes(),
      { match: "/bottles", body: [unopened] },
    ]);
    renderWithQuery(<BottlesPage />);

    await userEvent.click(await screen.findByRole("button", { name: "소진" }));

    await waitFor(() =>
      expect(calls.some((call) => call.url.includes("status=finished"))).toBe(true),
    );
  });

  it("병이 없으면 안내를 보여준다", async () => {
    stubRoutes([...authenticatedRoutes(), { match: "/bottles", body: [] }]);
    renderWithQuery(<BottlesPage />);

    expect(await screen.findByText(/해당하는 병이 없습니다/)).toBeInTheDocument();
  });

  it("조회에 실패하면 알린다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/bottles", status: 500, body: { detail: "서버 오류" } },
    ]);
    renderWithQuery(<BottlesPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/불러올 수 없습니다/);
  });

  it("병을 펼치면 상태 전이 버튼이 나온다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/bottles/b1/tastings", body: [] as Tasting[] },
      { match: "/tastings/summary", body: emptySummary },
      { match: "/bottles", body: [unopened] },
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
    const { calls } = stubRoutes([
      ...authenticatedRoutes(),
      { match: "/bottles/b1/tastings", body: [] as Tasting[] },
      { match: "/tastings/summary", body: emptySummary },
      { match: "/bottles", body: [unopened] },
    ]);
    renderWithQuery(<BottlesPage />);

    await userEvent.click(await screen.findByRole("button", { name: /1번 병/ }));
    await userEvent.click(await screen.findByRole("button", { name: "증여" }));

    expect(confirmSpy).toHaveBeenCalled();
    // 취소했으므로 요청을 보내지 않는다.
    expect(calls.some((call) => call.url.includes(":gift"))).toBe(false);
  });

  it("시음 폼에 평점 척도가 6점 만점 0.5 단위로 노출된다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/bottles/b2/tastings", body: [] as Tasting[] },
      { match: "/tastings/summary", body: emptySummary },
      { match: "/bottles", body: [opened] },
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

  it("시음을 저장하면 서버에 병 id 와 함께 보낸다", async () => {
    const { calls } = stubRoutes([
      ...authenticatedRoutes(),
      { match: "/bottles/b2/tastings", body: [] as Tasting[] },
      { match: "/tastings/summary", body: emptySummary },
      {
        match: "/tastings",
        method: "POST",
        status: 201,
        body: { id: "t1", bottle_id: "b2", sku_id: "s1", tasted_on: "2026-07-01" },
      },
      { match: "/bottles", body: [opened] },
    ]);
    renderWithQuery(<BottlesPage />);

    await userEvent.click(await screen.findByRole("button", { name: /2번 병/ }));
    await userEvent.type(await screen.findByLabelText("따른 양 (ml)"), "40");
    await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST");
      expect(post).toBeDefined();
      expect(post?.body).toMatchObject({ bottle_id: "b2", poured_ml: 40 });
    });
  });

  it("잔량 초과 오류를 그대로 보여준다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/bottles/b2/tastings", body: [] as Tasting[] },
      { match: "/tastings/summary", body: emptySummary },
      {
        match: "/tastings",
        method: "POST",
        status: 409,
        body: {
          type: "https://sooljang.local/errors/conflict",
          title: "현재 상태와 충돌",
          status: 409,
          detail: "잔량이 부족합니다. 남은 양 600ml, 따르려는 양 9999ml",
          errors: [],
        },
      },
      { match: "/bottles", body: [opened] },
    ]);
    renderWithQuery(<BottlesPage />);

    await userEvent.click(await screen.findByRole("button", { name: /2번 병/ }));
    await userEvent.type(await screen.findByLabelText("따른 양 (ml)"), "9999");
    await userEvent.click(screen.getByRole("button", { name: "기록 저장" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("잔량이 부족합니다");
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
      palate: null,
      finish: null,
      note: null,
      place: "집",
      companions: "친구",
    };
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
      { match: "/bottles", body: [opened] },
    ]);
    renderWithQuery(<BottlesPage />);

    await userEvent.click(await screen.findByRole("button", { name: /2번 병/ }));

    expect(await screen.findByText("2026-05-10")).toBeInTheDocument();
    expect(screen.getByText("5.0점")).toBeInTheDocument();
    expect(screen.getByText("향: 훈연")).toBeInTheDocument();
    expect(screen.getByText("집 · 친구")).toBeInTheDocument();
    expect(screen.getByText("변화 없음")).toBeInTheDocument();
  });
});
