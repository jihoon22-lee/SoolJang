import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderResult, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";

/** 페이지 테스트용 렌더. 재시도를 끄지 않으면 실패 경로 테스트가 느려진다. */
export function renderWithQuery(node: ReactNode): RenderResult {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
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
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });

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
