import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DiscoveryDocument, discoveryApi, type SearchResponse } from "@/api/discovery";
import { mergeDocuments, publicLink, queryLanguage, useDiscovery } from "@/discovery/useDiscovery";
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
  it("명시 검색 1회는 선택된 첫 4개만 요청하고 부분 결과와 실패를 보존한다", async () => {
    const pending = Array.from({ length: 3 }, () => deferred<SearchResponse>());
    let index = 0;
    const search = vi
      .spyOn(discoveryApi, "search")
      .mockImplementation(
        () => (pending[index++] as ReturnType<typeof deferred<SearchResponse>>).promise,
      );
    const lookup = vi.spyOn(discoveryApi, "lookup").mockRejectedValue(new Error("전문 소스 실패"));
    const { result } = renderHook(useDiscovery);
    const jobs = Array.from({ length: 3 }, (_, n) => ({
      id: `${n}`,
      name: `${n}`,
      kind: "search" as const,
    }));
    let work!: Promise<void>;
    act(() => {
      work = result.current.run(
        { name: "술" },
        [
          ...jobs,
          { id: "source", name: "전문", kind: "source" },
          { id: "overflow", name: "추가", kind: "search" },
        ],
        {},
      );
    });
    expect(search).toHaveBeenCalledTimes(3);
    expect(lookup).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending[0]?.resolve(response("https://example.com/first"));
    });
    expect(result.current.state.documents).toHaveLength(1);
    expect(result.current.state.running).toBe(true);
    await act(async () => {
      pending[1]?.resolve(response("https://example.com/second"));
      pending[2]?.resolve(response("https://example.com/third"));
      await work;
    });
    expect(search).toHaveBeenCalledTimes(3);
    expect(result.current.state).toMatchObject({ finished: 4, total: 4, running: false });
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
  expect(merged.find((doc) => doc.url === base)?.discovered_by).toEqual(["one", "two"]);
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

it("응답 순서와 무관하게 원래 순위로 정렬하고 동일 문서의 충실한 근거를 보존한다", () => {
  const first = {
    ...document("https://example.com/a", "one"),
    origins: [{ provider: "one", channel: "web", query: "술", language: "ko", rank: 8 }],
  };
  const rich = {
    ...first,
    excerpt: "더 충실한 제품 설명",
    evidence: "provider_text" as const,
    kind: "info" as const,
    discovered_by: ["two"],
    origins: [{ provider: "two", channel: "web", query: "술", language: "ko", rank: 2 }],
  };
  const winner = {
    ...document("https://example.com/b", "one"),
    origins: [{ provider: "one", channel: "web", query: "술", language: "ko", rank: 1 }],
  };
  const forward = mergeDocuments([first, winner], [rich]);
  const backward = mergeDocuments([rich], [winner, first]);
  expect(forward).toEqual(backward);
  expect(forward.find((doc) => doc.url === first.url)).toMatchObject({
    excerpt: rich.excerpt,
    kind: "info",
    discovered_by: ["one", "two"],
  });
});

it("확장 질의는 명시 실행하며 Naver의 두 요청을 포함해 8회 상한을 지킨다", async () => {
  const search = vi
    .spyOn(discoveryApi, "search")
    .mockResolvedValue(response("https://example.com/answer"));
  const { result } = renderHook(useDiscovery);
  expect(search).not.toHaveBeenCalled();
  const jobs = Array.from({ length: 4 }, (_, i) => ({
    id: `${i}`,
    name: `${i}`,
    kind: "search" as const,
    providerKind: "naver_hub",
  }));
  await act(async () => {
    await result.current.run({ name: "글렌알라키 12년 700ml" }, jobs, {});
  });
  expect(search).toHaveBeenCalledTimes(4);
  search.mockClear();
  await act(async () => {
    await result.current.run(
      { name: "글렌알라키 12년 700ml" },
      [jobs[0] as (typeof jobs)[number]],
      {},
    );
  });
  expect(search.mock.calls.map((call) => call[1])).toEqual([
    "글렌알라키 12년 700ml",
    "GlenAllachie 12년 700ml",
  ]);
  expect(result.current.state.queries).toEqual([
    "글렌알라키 12년 700ml",
    "GlenAllachie 12년 700ml",
  ]);
  expect(result.current.state.requests).toBe(2);
  expect(search.mock.calls.map((call) => call[3])).toEqual(["ko", "en"]);
});

it("동일 URL의 여러 부분 근거를 합쳐도 병합 순서가 내용과 순위를 바꾸지 않는다", () => {
  const base = document("https://example.com/shared");
  const a = { ...base, id: "a", title: "A", excerpt: "a".repeat(110), kind: "unknown" as const };
  const b = { ...base, id: "b", title: "B", excerpt: "b".repeat(5), kind: "review" as const };
  const c = { ...base, id: "c", title: "C", excerpt: "c".repeat(20), kind: "review" as const };
  const runs = [
    [a, b, c],
    [b, c, a],
    [c, a, b],
    [c, b, a],
  ].map((rows) =>
    rows.reduce((docs, doc) => mergeDocuments(docs, [doc]), [] as DiscoveryDocument[]),
  );
  expect(runs.every((docs) => JSON.stringify(docs) === JSON.stringify(runs[0]))).toBe(true);
});

describe("queryLanguage", () => {
  it.each([
    ["진 700ml", "ko"],
    ["글렌피딕 12y 700ml", "ko"],
    ["Glenfiddich 12 years 700ml", "en"],
    ["진 12 years old 700ml", "ko"],
    ["Glenfiddich 12 years old", "en"],
    ["Hendrick's Gin 1l", "en"],
    ["발렌타인", "ko"],
  ] as const)("%s는 단위를 빼고 %s로 본다", (query, language) => {
    expect(queryLanguage(query)).toBe(language);
  });
});
