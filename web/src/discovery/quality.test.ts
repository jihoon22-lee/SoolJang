import { describe, expect, it } from "vitest";
import type { DiscoveryDocument } from "@/api/discovery";
import { buildSearchQueries, documentTab, rankDocuments } from "./quality";

const document = (title: string, kind: DiscoveryDocument["kind"], rank = 1): DiscoveryDocument => ({
  id: title,
  title,
  kind,
  url: `https://example.com/${encodeURIComponent(title)}`,
  domain: "example.com",
  excerpt: "",
  fetched_at: "2026-10-11",
  published_at: null,
  evidence: "search_excerpt",
  discovered_by: ["brave"],
  rating: null,
  rating_scale: null,
  rating_count: null,
  origins: [{ provider: "brave", channel: "web", query: "술", language: "ko", rank }],
});
describe("탐색 제품 품질 규칙", () => {
  it("영문명과 숫자 식별정보를 최대 두 질의 안에서 활용한다", () => {
    expect(
      buildSearchQueries({
        name: "합성 몰트",
        name_en: "Synthetic Malt",
        vintage: 2020,
        volumes_ml: [700],
        abv: "46",
        age_years: "12",
      }),
    ).toEqual(["합성 몰트 2020 12년 700ml 46%", "Synthetic Malt 2020 12년 700ml 46%"]);
    expect(buildSearchQueries({ name: "글렌알라키 12년 700ml" })).toEqual([
      "글렌알라키 12년 700ml",
      "GlenAllachie 12년 700ml",
    ]);
  });
  it("가격·리뷰·판매자 설명·서비스 후기를 별도 목적에 둔다", () => {
    expect(
      [
        "info",
        "offer",
        "review",
        "customer_tasting",
        "service_review",
        "seller_note",
        "unknown",
      ].map((kind) => documentTab(kind as DiscoveryDocument["kind"])),
    ).toEqual(["info", "price", "review", "review", "other", "other", "other"]);
  });
  it("상충 규격·배치보다 일치 이름을 우선하고 응답 순서에 흔들리지 않는다", () => {
    const matching = document("합성 몰트 12년 배치 5 700ml", "info", 5);
    const wrong = document("합성 몰트 12년 배치 6 200ml", "info", 1);
    const unrelated = document("다른 보드카 700ml", "info", 1);
    const identity = { name: "합성 몰트 12년 배치 5", volumes_ml: [700] };
    const a = rankDocuments([wrong, unrelated, matching], identity);
    expect(a[0]).toEqual(matching);
    expect(a).toEqual(rankDocuments([matching, wrong, unrelated], identity));
  });
});

import fixedSearchCases from "../../../tests/fixtures/search_cases.json";

// This is a replayable synthetic ranking acceptance set, not measured provider recall.
describe("고정 120 질의의 합성 순위·부정 후보 평가", () => {
  for (const item of fixedSearchCases.cases) {
    it(`${item.split}: ${item.id}`, () => {
      const candidate = document(item.name, "info", 10);
      const answer = item.match ? candidate : document(item.query, "info", 9);
      const noise = Array.from({ length: 7 }, (_, index) =>
        document(`무관한 자료 ${index}`, "info", index + 1),
      );
      const rows = [...noise, candidate, ...(item.match ? [] : [answer])];
      const ranked = rankDocuments(rows, { name: item.query });
      expect(ranked.slice(0, 5)).toContain(answer);
      if (!item.match) expect(ranked.indexOf(answer)).toBeLessThan(ranked.indexOf(candidate));
      expect(ranked).toEqual(rankDocuments([...rows].reverse(), { name: item.query }));
      expect(ranked).toHaveLength(rows.length); // different URLs/editions stay separate
    });
  }
});

it("최대 길이 질의는 규격 토큰의 일부를 잘라 덧붙이지 않는다", () => {
  const name = "A".repeat(297);
  expect(buildSearchQueries({ name, volumes_ml: [700], abv: "40" })).toEqual([name]);
});
