import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceHistoryRow, PriceWatch } from "@/api/priceWatch";
import { PriceHistoryPanel } from "@/components/PriceHistoryPanel";
import { PriceWatchPage } from "@/pages/PriceWatchPage";
import { activateDatabase, lockDatabase } from "@/sync/db";
import {
  authenticatedRoutes,
  type RouteStub,
  renderWithQuery,
  stubRoutes,
  TEST_USER,
} from "@/testing";

const conditions = {
  price_kind: "regular",
  membership: "none",
  coupon: "none",
  fulfillment: "pickup",
  region: "서울",
  shipping: "none",
  tax: "included",
};
const watch: PriceWatch = {
  id: "watch-one",
  interest_id: "interest-one",
  interest_name: "합성 관심",
  source_id: "source-one",
  source_name: "합성 판매처",
  condition_key: "condition-one",
  criteria: {
    product_key: "product-one",
    offer_key: "offer-one",
    currency: "KRW",
    volume_ml: "700",
    units: 1,
    target_amount: "50000",
    conditions,
    max_age_seconds: 3600,
  },
  config_revision: 2,
  is_active: true,
  schedule_enabled: false,
  push_enabled: false,
  interval_seconds: 86400,
  cooldown_seconds: 86400,
  next_due_at: null,
  last_checked_at: null,
  last_outcome: "unknown",
  blocked_reason: null,
  last_notified_at: null,
  latest_run: null,
};
const observation: PriceHistoryRow = {
  id: "observation-one",
  offer_id: "offer-one",
  source_id: "source-one",
  source_name: "합성 판매처",
  condition_key: "condition-one",
  amount: "49000",
  currency: "KRW",
  source_url: "https://example.com/item/1",
  fetched_at: "2026-09-07T00:00:00Z",
  facts: { ...conditions, volume_ml: 700, units: 1, in_stock: true },
};
function routes(watches: PriceWatch[] = [watch], extras: RouteStub[] = []) {
  return stubRoutes([
    ...authenticatedRoutes(),
    ...extras,
    {
      match: "/price-watch/config",
      body: {
        configured: false,
        public_key: null,
        worker_enabled: true,
        worker: { state: "running" },
      },
    },
    { match: "/price-watch/notifications", body: [] },
    { match: "/price-watch/subscriptions", body: [] },
    { match: "/price-watch/interests/interest-one/history", body: [observation] },
    { match: "/price-watch", body: watches },
  ]);
}
beforeEach(async () => {
  await activateDatabase(TEST_USER.id);
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  lockDatabase();
});
describe("가격 감시", () => {
  it("목록 진입은 수동 기본과 별도 푸시 동의를 보여주며 자동 조회하지 않는다", async () => {
    const { calls } = routes();
    renderWithQuery(<PriceWatchPage />);
    expect(await screen.findByText("꺼짐 · 수동 조회")).toBeInTheDocument();
    expect(screen.getByText("꺼짐", { exact: true })).toBeInTheDocument();
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(screen.getByRole("button", { name: "이 브라우저에서 수신 허용" })).toBeDisabled();
  });
  it("정기 조회와 푸시는 따로 선택해 저장한다", async () => {
    const { calls } = routes(
      [watch],
      [{ match: "/price-watch/watch-one", method: "PATCH", body: watch }],
    );
    renderWithQuery(<PriceWatchPage />);
    await userEvent.click(await screen.findByRole("button", { name: "감시 설정" }));
    const periodic = screen.getByLabelText("정기 가격 조회에 동의");
    const push = screen.getByLabelText("이 대상의 웹 푸시 수신에 동의");
    expect(periodic).not.toBeChecked();
    expect(push).not.toBeChecked();
    await userEvent.click(periodic);
    expect(push).not.toBeChecked();
    await userEvent.clear(screen.getByLabelText("조회 간격 (분)"));
    await userEvent.type(screen.getByLabelText("조회 간격 (분)"), "60");
    await userEvent.click(screen.getByRole("button", { name: "감시 설정 저장" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "PATCH")?.body).toMatchObject({
        expected_revision: 2,
        schedule_enabled: true,
        push_enabled: false,
        interval_seconds: 3600,
      }),
    );
  });
  it("수동 조회는 명시 요청 ID를 보내고 일정 설정을 바꾸지 않는다", async () => {
    const { calls } = routes(
      [watch],
      [
        {
          match: "/price-watch/watch-one/check",
          method: "POST",
          status: 202,
          body: {
            id: "run-one",
            watch_id: watch.id,
            status: "queued",
            outcome: "unknown",
            attempts: 0,
            scheduled_for: observation.fetched_at,
            finished_at: null,
          },
        },
      ],
    );
    renderWithQuery(<PriceWatchPage />);
    await userEvent.click(await screen.findByRole("button", { name: "지금 가격 조회" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
        expected_revision: 2,
        request_id: expect.any(String),
      }),
    );
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });
  it("연결 사용 불가에서는 자동·수동 조회를 막는 이유를 표시한다", async () => {
    routes([{ ...watch, blocked_reason: "connection_unavailable" }]);
    renderWithQuery(<PriceWatchPage />);
    expect(await screen.findByText(/현재 요청 중지: 연결 사용 불가/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "지금 가격 조회" })).toBeDisabled();
  });
  it("해제 전에 보존되는 기록과 진행 중 요청 영향을 안내한다", async () => {
    const { calls } = routes(
      [watch],
      [{ match: "/price-watch/watch-one", method: "DELETE", status: 204, body: null }],
    );
    renderWithQuery(<PriceWatchPage />);
    await userEvent.click(await screen.findByRole("button", { name: "감시 해제" }));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(screen.getByRole("alert")).toHaveTextContent("기존 가격 관측·관심 대상·알림은 보존");
    await userEvent.click(screen.getByRole("button", { name: "감시 해제 확인" }));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
  });
  it("응답 유실은 전달 미확인으로 표시하고 자동 재전송을 약속하지 않는다", async () => {
    routes(
      [],
      [
        {
          match: "/price-watch/notifications",
          body: [
            {
              id: "notice-one",
              watch_id: watch.id,
              interest_id: watch.interest_id,
              created_at: observation.fetched_at,
              read_at: null,
              delivery_states: ["unknown"],
              amount: "49000",
              currency: "KRW",
              source_url: observation.source_url,
              observed_at: observation.fetched_at,
            },
          ],
        },
      ],
    );
    renderWithQuery(<PriceWatchPage />);
    const card = await screen.findByRole("article", { name: "목표가 충족 알림" });
    expect(within(card).getByText("전달 여부 미확인 · 자동 재전송 안 함")).toBeInTheDocument();
  });
  it("미완성 감시 설정은 닫았다 열거나 다시 접속해도 복원한다", async () => {
    routes();
    const first = renderWithQuery(<PriceWatchPage />);
    await userEvent.click(await screen.findByRole("button", { name: "감시 설정" }));
    const input = screen.getByLabelText("목표가 (KRW)");
    await userEvent.clear(input);
    await userEvent.type(input, "45678");
    first.unmount();
    renderWithQuery(<PriceWatchPage />);
    await userEvent.click(await screen.findByRole("button", { name: "감시 설정" }));
    expect(screen.getByLabelText("목표가 (KRW)")).toHaveValue(45678);
  });
});
describe("가격 이력에서 목표가", () => {
  it("원관측 시각·가격 조건을 보여주고 저장은 수동 기본으로 요청한다", async () => {
    const { calls } = routes(
      [],
      [{ match: "/price-watch", method: "POST", status: 201, body: watch }],
    );
    renderWithQuery(<PriceHistoryPanel interestId="interest-one" />);
    expect(await screen.findByText("49000 KRW")).toBeInTheDocument();
    expect(screen.getByText(/지역: 서울/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "이 판매 조건의 목표가 설정" }));
    await userEvent.clear(screen.getByLabelText("목표가 (KRW)"));
    await userEvent.type(screen.getByLabelText("목표가 (KRW)"), "45000");
    await userEvent.click(screen.getByRole("button", { name: "목표가 저장" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        interest_id: "interest-one",
        offer_id: "offer-one",
        target_amount: "45000",
        max_age_seconds: 3600,
      }),
    );
  });
  it("관측이 없으면 과거 가격을 만들지 않고 다음 조작을 안내한다", async () => {
    routes([], [{ match: "/price-watch/interests/interest-one/history", body: [] }]);
    renderWithQuery(<PriceHistoryPanel interestId="interest-one" />);
    expect(await screen.findByText(/아직 저장된 가격 관측이 없습니다/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "이 판매 조건의 목표가 설정" }),
    ).not.toBeInTheDocument();
  });
});

it("보유 제품 가격 이력은 읽기만 하며 관심 저장 경로로 연결한다", async () => {
  const { calls } = routes(
    [],
    [{ match: "/price-watch/products/product-one/history", body: [observation] }],
  );
  renderWithQuery(<PriceHistoryPanel productId="product-one" />);
  expect(await screen.findByText("49000 KRW")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "이 판매 조건의 목표가 설정" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "관심 저장 후 목표가 설정" })).toHaveAttribute(
    "href",
    "#interests",
  );
  expect(calls.every((call) => call.method === "GET")).toBe(true);
});

it("진행 중 조회와 저장된 정기·푸시 동의를 표시하고 중복 조회를 막는다", async () => {
  routes([
    {
      ...watch,
      schedule_enabled: true,
      push_enabled: true,
      next_due_at: "2026-09-08T00:00:00Z",
      latest_run: {
        id: "run-pending",
        watch_id: watch.id,
        status: "queued",
        outcome: "unknown",
        attempts: 1,
        scheduled_for: observation.fetched_at,
        finished_at: null,
      },
    },
  ]);
  renderWithQuery(<PriceWatchPage />);
  expect(await screen.findByText("1440분 간격")).toBeInTheDocument();
  expect(screen.getByText("수신 동의 · 기기 구독 필요")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "지금 가격 조회" })).toBeDisabled();
  expect(screen.getByText(/최근 작업: 대기 중/)).toBeInTheDocument();
});

it("감시 설정 충돌 시 입력을 유지하고 명시적으로 서버 값으로 복구한다", async () => {
  routes(
    [watch],
    [
      {
        match: "/price-watch/watch-one",
        method: "PATCH",
        status: 409,
        body: {
          type: "https://sooljang.local/errors/conflict",
          title: "설정 충돌",
          status: 409,
          detail: "최신 상태를 확인하세요",
          errors: [],
        },
      },
    ],
  );
  renderWithQuery(<PriceWatchPage />);
  await userEvent.click(await screen.findByRole("button", { name: "감시 설정" }));
  await userEvent.clear(screen.getByLabelText("목표가 (KRW)"));
  await userEvent.type(screen.getByLabelText("목표가 (KRW)"), "41000");
  await userEvent.click(screen.getByRole("button", { name: "감시 설정 저장" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("최신 상태를 확인하세요");
  expect(screen.getByLabelText("목표가 (KRW)")).toHaveValue(41000);
  await userEvent.click(screen.getByRole("button", { name: "서버 값 다시 불러오기" }));
  expect(screen.getByLabelText("목표가 (KRW)")).toHaveValue(50000);
});

it("불완전한 판매 조건의 목표가 저장 오류를 표시하고 입력을 보존한다", async () => {
  routes(
    [],
    [
      {
        match: "/price-watch/interests/interest-one/history",
        body: [{ ...observation, facts: { volume_ml: null, units: null, in_stock: null } }],
      },
      {
        match: "/price-watch",
        method: "POST",
        status: 422,
        body: {
          type: "https://sooljang.local/errors/validation",
          title: "조건 확인",
          status: 422,
          detail: "판매 조건을 먼저 확인하세요",
          errors: [],
        },
      },
    ],
  );
  renderWithQuery(<PriceHistoryPanel interestId="interest-one" />);
  await userEvent.click(await screen.findByRole("button", { name: "이 판매 조건의 목표가 설정" }));
  await userEvent.click(screen.getByRole("button", { name: "목표가 저장" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("판매 조건을 먼저 확인하세요");
  expect(screen.getByLabelText("목표가 (KRW)")).toHaveValue(49000);
});

it("제품 가격 이력의 관심 저장 콜백은 사용자 버튼에서만 호출한다", async () => {
  const save = vi.fn();
  routes([], [{ match: "/price-watch/products/product-one/history", body: [observation] }]);
  renderWithQuery(<PriceHistoryPanel productId="product-one" onSaveInterest={save} />);
  await screen.findByText("49000 KRW");
  expect(save).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "관심 저장 후 목표가 설정" }));
  expect(save).toHaveBeenCalledTimes(1);
});

it("서버 작업이 꺼져 있거나 오류이면 감시 상태와 조치 이유를 보여준다", async () => {
  routes(
    [watch],
    [
      {
        match: "/price-watch/config",
        body: {
          configured: false,
          public_key: null,
          worker_enabled: false,
          worker: { state: "error" },
        },
      },
    ],
  );
  renderWithQuery(<PriceWatchPage />);
  await screen.findByText("꺼짐 · 수동 조회");
  expect(screen.getAllByRole("alert")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "지금 가격 조회" })).toBeDisabled();
});
