/**
 * 인증 게이트와 로그인 화면 테스트.
 *
 * "로그인하지 않으면 데이터가 보이지 않는다" 는 것이 핵심이라, 통과 경로보다 차단 경로를
 * 더 촘촘히 본다.
 */

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "@/App";
import type { CategoryTree } from "@/api/types";
import {
  authenticatedRoutes,
  type RouteStub,
  renderWithQuery,
  stubRoutes,
  TEST_USER,
} from "@/testing";

const emptyTree: CategoryTree = { items: [], max_depth: 0, depth_limit: 8 };
/** 테스트용 CSRF 토큰. 실제 자격증명이 아니다. scan-secrets-allow */
const TEST_CSRF = "test-csrf-value";
const emptyProducts = { items: [], next_cursor: null };

const UNAUTHORIZED = {
  match: "/auth/me",
  status: 401,
  body: {
    type: "https://sooljang.local/errors/unauthorized",
    title: "인증이 필요합니다",
    status: 401,
    detail: "로그인이 필요합니다",
    errors: [],
  },
};

function loginSuccess() {
  return {
    match: "/auth/login",
    method: "POST",
    body: {
      user: TEST_USER,
      csrf_token: TEST_CSRF, // scan-secrets-allow
      expires_at: "2026-09-01T00:00:00Z",
    },
  };
}

/**
 * 테스트에서 CSRF 쿠키를 직접 심는다.
 *
 * 서버가 심어 주는 값을 브라우저처럼 재현해야 클라이언트가 헤더에 실는지 검증할 수 있다.
 * Biome 의 `noDocumentCookie` 는 애플리케이션 코드를 겨냥한 규칙이라 테스트에서는 끈다.
 */
function setCsrfCookie(value: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: 브라우저가 심는 쿠키를 테스트에서 재현한다
  document.cookie = value;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfCookie("sooljang_csrf=; max-age=0; path=/");
});

describe("인증 게이트", () => {
  it("로그인하지 않으면 로그인 화면을 보여준다", async () => {
    stubRoutes([
      UNAUTHORIZED,
      { match: "/auth/setup", body: { needs_setup: false } },
      { match: "/categories", body: emptyTree },
      { match: "/products", body: emptyProducts },
    ]);
    renderWithQuery(<App />);

    expect(await screen.findByRole("heading", { name: "술장 로그인" })).toBeInTheDocument();
  });

  it("로그인하지 않으면 술 목록을 보여주지 않는다", async () => {
    stubRoutes([
      UNAUTHORIZED,
      { match: "/auth/setup", body: { needs_setup: false } },
      { match: "/products", body: emptyProducts },
    ]);
    renderWithQuery(<App />);

    await screen.findByRole("heading", { name: "술장 로그인" });
    expect(screen.queryByRole("link", { name: "내 술" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "주요 화면" })).not.toBeInTheDocument();
  });

  it("사용자가 없으면 최초 계정 생성 폼을 보여준다", async () => {
    stubRoutes([UNAUTHORIZED, { match: "/auth/setup", body: { needs_setup: true } }]);
    renderWithQuery(<App />);

    expect(await screen.findByRole("heading", { name: "술장 시작하기" })).toBeInTheDocument();
    expect(screen.getByLabelText("표시 이름")).toBeInTheDocument();
    expect(screen.getByLabelText("비밀번호 확인")).toBeInTheDocument();
  });

  it("로그인 화면에서는 표시 이름을 묻지 않는다", async () => {
    stubRoutes([UNAUTHORIZED, { match: "/auth/setup", body: { needs_setup: false } }]);
    renderWithQuery(<App />);

    await screen.findByRole("heading", { name: "술장 로그인" });
    expect(screen.queryByLabelText("표시 이름")).not.toBeInTheDocument();
  });

  it("로그인하면 앱 화면으로 들어간다", async () => {
    // 로그인에 성공하면 세션 쿠키가 심겨 `/auth/me` 가 200 을 돌려준다. 스텁 배열을 그 자리에서
    // 바꿔 그 전환을 재현한다. 401 을 계속 돌려주면 실제와 다른 상황을 검증하게 된다.
    const routes: RouteStub[] = [
      UNAUTHORIZED,
      { match: "/auth/setup", body: { needs_setup: false } },
      loginSuccess(),
      { match: "/categories", body: emptyTree },
      { match: "/products", body: emptyProducts },
    ];
    const { spy } = stubRoutes(routes);
    renderWithQuery(<App />);

    await screen.findByRole("heading", { name: "술장 로그인" });
    await userEvent.type(screen.getByLabelText("이메일"), "owner@example.com");
    await userEvent.type(screen.getByLabelText("비밀번호"), "sooljang-test-1234");

    routes[0] = { match: "/auth/me", status: 200, body: TEST_USER };
    await userEvent.click(screen.getByRole("button", { name: "로그인" }));

    expect(await screen.findByRole("navigation", { name: "주요 화면" })).toBeInTheDocument();
    expect(spy).toHaveBeenCalled();
  });

  it("로그인 실패 메시지를 보여준다", async () => {
    stubRoutes([
      UNAUTHORIZED,
      { match: "/auth/setup", body: { needs_setup: false } },
      {
        match: "/auth/login",
        method: "POST",
        status: 401,
        body: {
          type: "https://sooljang.local/errors/unauthorized",
          title: "인증이 필요합니다",
          status: 401,
          detail: "이메일 또는 비밀번호가 올바르지 않습니다",
          errors: [],
        },
      },
    ]);
    renderWithQuery(<App />);

    await screen.findByRole("heading", { name: "술장 로그인" });
    await userEvent.type(screen.getByLabelText("이메일"), "owner@example.com");
    await userEvent.type(screen.getByLabelText("비밀번호"), "틀린비밀번호");
    await userEvent.click(screen.getByRole("button", { name: "로그인" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "이메일 또는 비밀번호가 올바르지 않습니다",
    );
  });

  it("로그인 실패 후에도 로그인 화면에 머문다", async () => {
    stubRoutes([
      UNAUTHORIZED,
      { match: "/auth/setup", body: { needs_setup: false } },
      { match: "/auth/login", method: "POST", status: 401, body: { detail: "실패" } },
    ]);
    renderWithQuery(<App />);

    await screen.findByRole("heading", { name: "술장 로그인" });
    await userEvent.type(screen.getByLabelText("이메일"), "owner@example.com");
    await userEvent.type(screen.getByLabelText("비밀번호"), "틀림");
    await userEvent.click(screen.getByRole("button", { name: "로그인" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "술장 로그인" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("navigation", { name: "주요 화면" })).not.toBeInTheDocument();
  });

  it("최초 설정에서 비밀번호 확인이 다르면 요청을 보내지 않는다", async () => {
    const { calls } = stubRoutes([
      UNAUTHORIZED,
      { match: "/auth/setup", body: { needs_setup: true } },
    ]);
    renderWithQuery(<App />);

    await screen.findByRole("heading", { name: "술장 시작하기" });
    await userEvent.type(screen.getByLabelText("표시 이름"), "나");
    await userEvent.type(screen.getByLabelText("이메일"), "owner@example.com");
    await userEvent.type(screen.getByLabelText("비밀번호"), "sooljang-test-1234");
    await userEvent.type(screen.getByLabelText("비밀번호 확인"), "다른비밀번호1234");
    await userEvent.click(screen.getByRole("button", { name: "계정 만들고 시작" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("비밀번호가 서로 다릅니다");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("서버에 연결할 수 없으면 재시도를 제공한다", async () => {
    stubRoutes([
      UNAUTHORIZED,
      { match: "/auth/setup", status: 500, body: { detail: "서버 오류" } },
    ]);
    renderWithQuery(<App />);

    expect(
      await screen.findByRole("heading", { name: "서버에 연결할 수 없습니다" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });

  it("로그아웃하면 로그인 화면으로 돌아간다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/auth/logout", method: "POST", status: 204, body: null },
      { match: "/auth/setup", body: { needs_setup: false } },
      { match: "/categories", body: emptyTree },
      { match: "/products", body: emptyProducts },
    ]);
    renderWithQuery(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "로그아웃" }));

    expect(await screen.findByRole("heading", { name: "술장 로그인" })).toBeInTheDocument();
  });

  it("로그인한 사용자의 표시 이름을 헤더에 보여준다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/categories", body: emptyTree },
      { match: "/products", body: emptyProducts },
    ]);
    renderWithQuery(<App />);

    expect(await screen.findByText("테스트 소유자")).toBeInTheDocument();
  });
});

describe("CSRF 토큰", () => {
  it("쓰기 요청에 쿠키의 CSRF 토큰을 실어 보낸다", async () => {
    setCsrfCookie("sooljang_csrf=csrf-abcd; path=/");
    const { calls, spy } = stubRoutes([
      ...authenticatedRoutes(),
      { match: "/categories", body: emptyTree },
      { match: "/products", body: emptyProducts },
    ]);

    const { categoriesApi } = await import("@/api/client");
    await categoriesApi.create({ name: "테스트" }).catch(() => undefined);

    const post = spy.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST");
    expect(post).toBeDefined();
    const headers = (post?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBe("csrf-abcd");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("읽기 요청에는 CSRF 토큰을 싣지 않는다", async () => {
    setCsrfCookie("sooljang_csrf=csrf-abcd; path=/");
    const { spy } = stubRoutes([{ match: "/products", body: emptyProducts }]);

    const { productsApi } = await import("@/api/client");
    await productsApi.list({}).catch(() => undefined);

    const get = spy.mock.calls[0];
    const headers = (get?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBeUndefined();
  });

  it("쿠키가 없으면 헤더를 붙이지 않는다", async () => {
    const { spy } = stubRoutes([{ match: "/categories", body: emptyTree }]);

    const { categoriesApi } = await import("@/api/client");
    await categoriesApi.create({ name: "테스트" }).catch(() => undefined);

    const post = spy.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST");
    const headers = (post?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBeUndefined();
  });
});
