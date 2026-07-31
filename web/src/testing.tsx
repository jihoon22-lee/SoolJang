import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderResult, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";

import type { User } from "@/api/types";

/** 페이지 테스트용 렌더. 재시도를 끄지 않으면 실패 경로 테스트가 느려진다. */
export function renderWithQuery(node: ReactNode): RenderResult {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/** 테스트용 로그인 사용자. */
export const TEST_USER: User = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "owner@example.com",
  display_name: "테스트 소유자",
  role: "owner",
  last_login_at: null,
};

/**
 * 로그인된 상태를 만드는 스텁.
 *
 * `App` 은 `/auth/me` 로 세션을 확인하므로, 이 스텁이 없으면 어떤 화면 테스트든 로그인
 * 화면만 보게 된다. 각 테스트가 직접 적는 대신 여기 모아 둔다.
 */
export function authenticatedRoutes(): RouteStub[] {
  return [{ match: "/auth/me", body: TEST_USER }];
}

export interface RouteStub {
  /** 요청 URL 에 이 문자열이 포함되면 매칭한다. */
  match: string;
  method?: string;
  status?: number;
  body: unknown;
}

/**
 * URL·메서드로 응답을 고르는 fetch 스텁.
 *
 * 페이지는 여러 엔드포인트를 순차 호출하므로 호출 순서에 의존하는 스텁은 깨지기 쉽다.
 * 경로로 매칭하면 호출 순서가 바뀌어도 테스트가 유지된다.
 */
export function stubRoutes(routes: RouteStub[]) {
  const calls: { url: string; method: string; body: unknown }[] = [];

  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: readBody(init?.body) });

    const route = routes.find(
      (candidate) =>
        url.includes(candidate.match) && (candidate.method ?? "GET").toUpperCase() === method,
    );

    if (!route) {
      return new Response(JSON.stringify({ detail: `스텁 없음: ${method} ${url}` }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const status = route.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(route.body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });

  vi.stubGlobal("fetch", spy);
  return { spy, calls };
}

/**
 * 요청 본문을 검증하기 쉬운 형태로 바꾼다.
 *
 * 파일 업로드는 FormData 이므로 JSON 으로 파싱할 수 없다. 파일 이름만 남겨 어떤 파일이
 * 올라갔는지 확인할 수 있게 한다.
 */
function readBody(body: BodyInit | null | undefined): unknown {
  if (!body) return undefined;
  if (body instanceof FormData) {
    const entries: Record<string, string> = {};
    for (const [key, value] of body.entries()) {
      entries[key] = value instanceof File ? value.name : String(value);
    }
    return entries;
  }
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return undefined;
}
