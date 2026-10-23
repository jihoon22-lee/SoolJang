import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "@/App";
import {
  AUTH_SESSION_KEY,
  advanceAuthSession,
  isCurrentAuthSession,
  StaleAuthResponseError,
} from "@/api/authSession";
import { attachmentsApi, authApi, request, setUnauthorizedHandler } from "@/api/client";
import type { User } from "@/api/types";
import { databaseIdentity, lockDatabase } from "@/sync/db";
import {
  hasPendingLogout,
  LOCAL_SESSION_KEY,
  markPendingLogout,
  offlineSession,
  rememberLocalSession,
} from "@/sync/localSession";
import { renderWithQuery, TEST_USER } from "@/testing";

function response(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status });
}

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function server(nextUser: User, logout = Promise.resolve(response(null, 204))) {
  const old = deferred();
  let current: User | null = TEST_USER;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith("/auth/me")) return response(current, current ? 200 : 401);
      if (path.endsWith("/auth/setup")) return response({ needs_setup: false });
      if (path.endsWith("/auth/logout")) {
        current = null;
        return logout;
      }
      if (path.endsWith("/auth/login")) {
        current = nextUser;
        return response({
          user: current,
          csrf_token: "test-csrf", // scan-secrets-allow: synthetic fixture
          expires_at: "2026-12-01",
        });
      }
      if (path.endsWith("/interests") || path.endsWith("/attachments")) return old.promise;
      if (path.includes("/sync"))
        return response({ changes: {}, next_cursor: null, has_more: false });
      return response({ items: [], next_cursor: null });
    }),
  );
  return old;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  advanceAuthSession(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  lockDatabase();
});

async function logout(): Promise<void> {
  await userEvent.click(await screen.findByRole("button", { name: "설정" }));
  await userEvent.click(screen.getByRole("button", { name: "로그아웃" }));
  await screen.findByRole("heading", { name: "술장 로그인" });
}

async function login(): Promise<void> {
  await userEvent.type(screen.getByLabelText("이메일", { exact: true }), "next@example.com");
  await userEvent.type(screen.getByLabelText("비밀번호", { exact: true }), "synthetic-password");
  await userEvent.click(screen.getByRole("button", { name: "로그인" }));
  await screen.findByRole("heading", { name: "홈" });
}

it.each([
  ["다른 계정", "read"],
  ["같은 계정", "read"],
  ["다른 계정", "upload"],
])("%s 재로그인 후 이전 %s 요청의 401은 현재 계정을 잠그지 않는다", async (account, kind) => {
  const next = {
    ...TEST_USER,
    id: account === "같은 계정" ? TEST_USER.id : "00000000-0000-0000-0000-000000000002",
    display_name: "새 로그인",
  };
  const old = server(next);
  renderWithQuery(<App />);
  await screen.findByRole("heading", { name: "홈" });
  const pending = (
    kind === "read"
      ? request("/interests")
      : attachmentsApi.create(new File(["synthetic"], "label.png", { type: "image/png" }), {
          kind: "label",
          product_id: "fixture",
        })
  ).catch((error: unknown) => error);
  await logout();
  await login();
  await waitFor(() => expect(databaseIdentity().userId).toBe(next.id));

  await act(async () => {
    old.resolve(response({ detail: "이전 세션 만료" }, 401));
    await pending;
  });

  expect(screen.getByRole("heading", { name: "홈" })).toBeInTheDocument();
  expect(databaseIdentity().userId).toBe(next.id);
  expect(JSON.parse(localStorage.getItem(LOCAL_SESSION_KEY) ?? "null")?.user.id).toBe(next.id);
});

it("서버 로그아웃 응답이 끝나기 전에는 새 로그인 제출을 막는다", async () => {
  const pendingLogout = deferred();
  server(TEST_USER, pendingLogout.promise);
  renderWithQuery(<App />);
  await screen.findByRole("heading", { name: "홈" });
  await logout();
  const submit = screen.getByRole("button", { name: "로그인" });
  try {
    expect(submit).toBeDisabled();
  } finally {
    await act(async () => {
      pendingLogout.resolve(response(null, 204));
    });
  }
  await waitFor(() => expect(submit).toBeEnabled());
});

it("미완료 로그아웃 재시도에서 이미 만료된 세션의 401도 로그아웃 완료로 정리한다", async () => {
  markPendingLogout();
  const fetch = vi.fn(async (input: string | URL | Request) =>
    String(input).endsWith("/auth/logout") ? response({}, 401) : response({ needs_setup: false }),
  );
  vi.stubGlobal("fetch", fetch);
  renderWithQuery(<App />);

  expect(await screen.findByRole("heading", { name: "술장 로그인" })).toBeInTheDocument();
  await waitFor(() => expect(hasPendingLogout()).toBe(false));
  expect(fetch.mock.calls.some(([input]) => String(input).endsWith("/auth/me"))).toBe(false);
});

it.each(["read", "upload"])("현재 로그인 %s 요청의 401은 로컬 계정을 잠근다", async (kind) => {
  const old = server(TEST_USER);
  renderWithQuery(<App />);
  await screen.findByRole("heading", { name: "홈" });
  const pending = (
    kind === "read"
      ? request("/interests")
      : attachmentsApi.create(new File(["fixture"], "photo.png"), {
          kind: "label",
          product_id: "fixture",
        })
  ).catch((error: unknown) => error);
  await act(async () => {
    old.resolve(response({}, 401));
    await pending;
  });
  expect(await screen.findByRole("heading", { name: "술장 로그인" })).toBeInTheDocument();
  expect(databaseIdentity().userId).toBeNull();
});

it.each([
  200, 401,
])("다른 탭의 새 로그인 이후 늦은 %s 응답은 현재 세션을 변경하지 않는다", async (status) => {
  const old = deferred();
  const unauthorized = vi.fn();
  setUnauthorizedHandler(unauthorized);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => old.promise),
  );
  const pending = request("/interests").catch((error: unknown) => error);
  // storage 이벤트가 도착하기 전에도 다른 탭이 기록한 인증 전환을 감지한다.
  localStorage.setItem(AUTH_SESSION_KEY, "new-login-in-another-tab");
  old.resolve(response({ items: ["old account data"] }, status));
  expect(await pending).toBeInstanceOf(StaleAuthResponseError);
  expect(unauthorized).not.toHaveBeenCalled();
  setUnauthorizedHandler(null);
});

it("시작 시 계정 조회가 취소 뒤 늦게 성공해도 새 로그인 정보를 덮지 않는다", async () => {
  const next = { ...TEST_USER, id: "00000000-0000-0000-0000-000000000002" };
  server(next);
  let complete!: (user: User) => void;
  const old = new Promise<User>((resolve) => {
    complete = resolve;
  });
  // API 경계가 AbortSignal을 무시하는 경우에도 App의 로컬 저장 부수효과를 보호한다.
  const me = vi.spyOn(authApi, "me").mockReturnValueOnce(old);
  renderWithQuery(<App />);
  await waitFor(() => expect(me).toHaveBeenCalled());
  act(() =>
    window.dispatchEvent(new StorageEvent("storage", { key: LOCAL_SESSION_KEY, newValue: null })),
  );
  await screen.findByRole("heading", { name: "술장 로그인" });
  await login();
  await act(async () => {
    complete(TEST_USER);
    await old;
  });
  expect(JSON.parse(localStorage.getItem(LOCAL_SESSION_KEY) ?? "null")?.user.id).toBe(next.id);
  expect(databaseIdentity().userId).toBe(next.id);
});

it("로그인 UI callback 전에 cookie lock 안에서 세대를 확정해 대기 중인 옛 로그인을 취소한다", async () => {
  const next = { ...TEST_USER, display_name: "새 계정" };
  const fetch = vi.fn(async () =>
    response({ user: next, csrf_token: "fixture", expires_at: "2026-12-01" }),
  );
  vi.stubGlobal("fetch", fetch);
  const released: (string | null)[] = [];
  vi.stubGlobal("navigator", {
    locks: {
      request: async (_name: string, callback: () => Promise<unknown>) => {
        const result = await callback();
        released.push(localStorage.getItem(AUTH_SESSION_KEY));
        return result;
      },
    },
  });
  const input = { email: "fixture@example.com", password: "fixture" };
  const first = authApi.login(input);
  const second = authApi.login(input).catch((error: unknown) => error);
  const confirmed = await first;
  expect(await second).toBeInstanceOf(StaleAuthResponseError);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(released).toHaveLength(1);
  expect(released[0]).toBeTruthy();
  expect(isCurrentAuthSession(confirmed.session)).toBe(true);
  expect(confirmed.result.user).toEqual(next);
});

it.each([
  "write",
  "upload",
])("다른 탭의 인증 전환 이벤트가 늦어도 이전 화면의 새 %s 요청은 전송하지 않는다", async (kind) => {
  const fetch = vi.fn(async () => response({ id: "wrong-account" }, 201));
  vi.stubGlobal("fetch", fetch);
  localStorage.setItem(AUTH_SESSION_KEY, "another-tab-started-login");

  const pending =
    kind === "write"
      ? request("/vendors", { method: "POST", body: { name: "이전 계정의 구매처" } })
      : attachmentsApi.create(new File(["fixture"], "label.png"), {
          kind: "label",
          product_id: "old-account-product",
        });

  await expect(pending).rejects.toBeInstanceOf(StaleAuthResponseError);
  expect(fetch).not.toHaveBeenCalled();
});

it("다른 탭에서 로그인을 시작하면 응답이 오기 전에 현재 화면과 로컬 기록을 잠근다", async () => {
  server(TEST_USER);
  renderWithQuery(<App />);
  await screen.findByRole("heading", { name: "홈" });
  expect(databaseIdentity().userId).toBe(TEST_USER.id);

  act(() => {
    localStorage.setItem(AUTH_SESSION_KEY, "another-tab-started-login");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: AUTH_SESSION_KEY,
        newValue: "another-tab-started-login",
      }),
    );
  });

  expect(await screen.findByRole("heading", { name: "술장 로그인" })).toBeInTheDocument();
  expect(databaseIdentity().userId).toBeNull();
  expect(screen.queryByRole("navigation", { name: "주요 화면" })).not.toBeInTheDocument();
});

it("앱의 이벤트 등록 전에 끝난 다른 탭 인증 전환도 로그인 화면에서 다시 시작한다", async () => {
  server(TEST_USER);
  localStorage.setItem(AUTH_SESSION_KEY, "login-before-app-mounted");
  renderWithQuery(<App />);

  expect(await screen.findByRole("heading", { name: "술장 로그인" })).toBeInTheDocument();
  expect(databaseIdentity().userId).toBeNull();
});

it("다른 탭의 인증 전환이 진행 중인 로그인 안내 조회를 취소해도 다시 조회한다", async () => {
  const oldSetup = deferred();
  let setupCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/auth/setup")) {
        setupCalls += 1;
        return setupCalls === 1 ? oldSetup.promise : response({ needs_setup: false });
      }
      return response({}, 401);
    }),
  );
  renderWithQuery(<App />);
  await waitFor(() => expect(setupCalls).toBe(1));

  try {
    act(() => {
      localStorage.setItem(AUTH_SESSION_KEY, "another-tab-started-login");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: AUTH_SESSION_KEY,
          newValue: "another-tab-started-login",
        }),
      );
    });
    expect(await screen.findByRole("heading", { name: "술장 로그인" })).toBeInTheDocument();
    expect(setupCalls).toBe(2);
  } finally {
    await act(async () => oldSetup.resolve(response({ needs_setup: false })));
  }
});

it.each([
  AUTH_SESSION_KEY,
  LOCAL_SESSION_KEY,
])("새 로그인 뒤 도착한 이전 %s 이벤트는 현재 요청과 화면을 취소하지 않는다", async (key) => {
  const next = { ...TEST_USER, id: "00000000-0000-0000-0000-000000000002" };
  const old = server(next);
  renderWithQuery(<App />);
  await screen.findByRole("heading", { name: "홈" });
  await logout();
  await login();
  const pending = request("/interests").catch((error: unknown) => error);

  await act(async () => {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: null }));
    old.resolve(response({ items: ["현재 계정"] }));
    expect(await pending).toEqual({ items: ["현재 계정"] });
  });

  expect(screen.getByRole("heading", { name: "홈" })).toBeInTheDocument();
  expect(databaseIdentity().userId).toBe(next.id);
});

it.each([
  "login",
  "setup",
] as const)("%s는 응답 본문이 지연돼도 요청을 보내기 전에 다른 탭에 인증 전환을 알린다", async (kind) => {
  const oldGeneration = localStorage.getItem(AUTH_SESSION_KEY);
  let complete!: (value: unknown) => void;
  const body = new Promise<unknown>((resolve) => {
    complete = resolve;
  });
  const fetch = vi.fn(async () => ({ status: 200, ok: true, json: () => body }));
  vi.stubGlobal("fetch", fetch);
  const input = { email: "fixture@example.com", password: "fixture", display_name: "새 계정" };
  const pending = authApi[kind](input);

  try {
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem(AUTH_SESSION_KEY)).not.toBe(oldGeneration);
  } finally {
    complete({ user: TEST_USER, csrf_token: "fixture", expires_at: "2026-12-01" });
    await pending;
  }
});

it("로그인 본문 확정 전에 시작한 계정 조회는 cookie lock 뒤에서 이전 요청으로 취소한다", async () => {
  const loginResponse = deferred();
  const fetch = vi.fn(async (input: string | URL | Request) =>
    String(input).endsWith("/auth/login") ? loginResponse.promise : response(TEST_USER),
  );
  vi.stubGlobal("fetch", fetch);
  const login = authApi.login({ email: "next@example.com", password: "fixture" });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const me = authApi.me().catch((error: unknown) => error);

  try {
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    loginResponse.resolve(
      response({ user: TEST_USER, csrf_token: "fixture", expires_at: "2026-12-01" }),
    );
    await login;
  }
  expect(await me).toBeInstanceOf(StaleAuthResponseError);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("오프라인 새 창도 다른 탭의 cookie lock이 풀리고 세대가 유지돼야 로컬 계정을 연다", async () => {
  rememberLocalSession(TEST_USER);
  const lock = deferred();
  const lockRequest = vi.fn(async (_name: string, run: () => Promise<unknown>) => {
    await lock.promise;
    return run();
  });
  vi.stubGlobal("navigator", { onLine: false, locks: { request: lockRequest } });
  renderWithQuery(<App />);

  try {
    await waitFor(() => expect(lockRequest).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("heading", { name: "홈" })).not.toBeInTheDocument();
  } finally {
    await act(async () => {
      localStorage.setItem(AUTH_SESSION_KEY, "another-tab-completed-login");
      lock.resolve(response(null, 204));
    });
  }
  expect(await screen.findByRole("alert")).toHaveTextContent("현재 계정을 확인하지 못했습니다");
  expect(databaseIdentity().userId).toBeNull();
});

it("로그인 응답을 받지 못해도 이전 계정의 오프라인 접근 기록은 다시 사용하지 않는다", async () => {
  rememberLocalSession(TEST_USER);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("연결 중단")));
  await expect(authApi.login({ email: "next@example.com", password: "fixture" })).rejects.toThrow(
    "연결 중단",
  );
  expect(offlineSession()).toBeNull();
});
