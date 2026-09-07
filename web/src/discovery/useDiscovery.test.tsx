import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DiscoveryDocument, discoveryApi, type SearchResponse } from "@/api/discovery";
import { mergeDocuments, publicLink, useDiscovery } from "@/discovery/useDiscovery";
import * as db from "@/sync/db";

function document(url: string, provider = "one"): DiscoveryDocument {
  return {
    id: url,
    url,
    title: url,
    domain: "example.com",
    excerpt: "발췌",
    fetched_at: "2026-09-07",
    published_at: null,
    kind: "unknown",
    evidence: "search_excerpt",
    discovered_by: [provider],
    rating: null,
    rating_scale: null,
    rating_count: null,
  };
}
function response(url: string): SearchResponse {
  return {
    connection_id: "one",
    outcome: "success",
    documents: [document(url)],
    warning: null,
    requests: 1,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => vi.restoreAllMocks());
describe("discovery request lifecycle", () => {
  it("한 번에 4개만 요청하고 부분 결과와 실패를 보존한다", async () => {
    const pending = Array.from({ length: 5 }, () => deferred<SearchResponse>());
    let index = 0;
    const search = vi
      .spyOn(discoveryApi, "search")
      .mockImplementation(
        () => (pending[index++] as ReturnType<typeof deferred<SearchResponse>>).promise,
      );
    const lookup = vi.spyOn(discoveryApi, "lookup").mockRejectedValue(new Error("전문 소스 실패"));
    const { result } = renderHook(useDiscovery);
    const jobs = Array.from({ length: 5 }, (_, n) => ({
      id: `${n}`,
      name: `${n}`,
      kind: "search" as const,
    }));
    let work!: Promise<void>;
    act(() => {
      work = result.current.run(
        { name: "술" },
        [...jobs, { id: "source", name: "전문", kind: "source" }],
        {},
      );
    });
    expect(search).toHaveBeenCalledTimes(4);
    await act(async () => {
      pending[0]?.resolve(response("https://example.com/first"));
    });
    expect(search).toHaveBeenCalledTimes(5);
    expect(result.current.state.documents).toHaveLength(1);
    expect(result.current.state.running).toBe(true);
    await act(async () => {
      for (let n = 1; n < 5; n++) pending[n]?.resolve(response(`https://example.com/${n}`));
      await work;
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(result.current.state).toMatchObject({ finished: 6, total: 6, running: false });
    expect(result.current.state.notices).toContain("전문: 전문 소스 실패");
  });
  it("취소한 요청의 늦은 응답은 반영하지 않고 완료된 결과를 유지한다", async () => {
    const pending = deferred<SearchResponse>();
    vi.spyOn(discoveryApi, "search")
      .mockResolvedValueOnce(response("https://example.com/complete"))
      .mockReturnValueOnce(pending.promise);
    const { result } = renderHook(useDiscovery);
    let work!: Promise<void>;
    act(() => {
      work = result.current.run(
        { name: "술" },
        [
          { id: "1", name: "one", kind: "search" },
          { id: "2", name: "two", kind: "search" },
        ],
        {},
      );
    });
    await waitFor(() => expect(result.current.state.finished).toBe(1));
    act(() => result.current.cancel());
    await act(async () => {
      pending.resolve(response("https://example.com/late"));
      await work;
    });
    expect(result.current.state.documents.map((doc) => doc.url)).toEqual([
      "https://example.com/complete",
    ]);
    expect(result.current.state.cancelled).toBe(true);
  });
  it("새 질의 또는 계정 변경 전의 응답은 새 화면을 덮지 않는다", async () => {
    let owner = { userId: "one", generation: 1 };
    vi.spyOn(db, "databaseIdentity").mockImplementation(() => owner);
    const old = deferred<SearchResponse>();
    const otherOwner = deferred<SearchResponse>();
    vi.spyOn(discoveryApi, "search")
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(response("https://example.com/new"))
      .mockReturnValueOnce(otherOwner.promise);
    const { result } = renderHook(useDiscovery);
    const jobs = [{ id: "one", name: "one", kind: "search" as const }];
    let first!: Promise<void>;
    act(() => {
      first = result.current.run({ name: "old" }, jobs, {});
    });
    await act(async () => {
      await result.current.run({ name: "new" }, jobs, {});
      old.resolve(response("https://example.com/old"));
      await first;
    });
    expect(result.current.state.documents[0]?.url).toBe("https://example.com/new");
    let switched!: Promise<void>;
    act(() => {
      switched = result.current.run({ name: "account" }, jobs, {});
    });
    owner = { userId: "two", generation: 2 };
    await act(async () => {
      otherOwner.resolve(response("https://example.com/private"));
      await switched;
    });
    expect(result.current.state.documents).toEqual([]);
  });
  it("unmount는 실행중 요청을 중단한다", async () => {
    const pending = deferred<SearchResponse>();
    const spy = vi.spyOn(discoveryApi, "search").mockReturnValue(pending.promise);
    const { result, unmount } = renderHook(useDiscovery);
    let work!: Promise<void>;
    act(() => {
      work = result.current.run({ name: "술" }, [{ id: "one", name: "one", kind: "search" }], {});
    });
    unmount();
    expect(spy.mock.calls[0]?.[2].aborted).toBe(true);
    pending.resolve(response("https://example.com/late"));
    await work;
  });
});
it("동일 원문만 병합하고 판본·규격·조건 URL을 보존한다", () => {
  const base = "https://example.com/item?sku=700";
  const merged = mergeDocuments(
    [document(base)],
    [document(base, "two"), document("https://example.com/item?sku=200")],
  );
  expect(merged).toHaveLength(2);
  expect(merged[0]?.discovered_by).toEqual(["one", "two"]);
});
it("HTML 실행 및 자격증명 URL을 링크로 렌더링하지 않는다", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,x",
    "https://u:p@example.com",
    "invalid",
  ])
    expect(publicLink(url)).toBeUndefined();
  expect(publicLink("https://example.com/a?sku=700")).toBe("https://example.com/a?sku=700");
});
