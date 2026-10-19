import { describe, expect, it } from "vitest";
import {
  expandSearchQueries,
  extractChosung,
  matchesQuery,
  normalizeNameForMatching,
  normalizeSearchText,
  rankByQuery,
} from "@/search";

describe("extractChosung", () => {
  it("한글 음절을 초성으로 분해한다", () => {
    expect(extractChosung("글렌고인")).toBe("ㄱㄹㄱㅇ");
  });

  it("초성이 아닌 문자는 그대로 둔다", () => {
    expect(extractChosung("Glen고인12")).toBe("Glen고인12".replace("고인", "ㄱㅇ"));
  });
});

describe("normalizeNameForMatching", () => {
  it("공백·구두점·대소문자 차이를 제거한다", () => {
    expect(normalizeNameForMatching("  Glen-Alachie 12Y  ")).toBe("glen alachie 12y");
  });

  it("연속 공백을 하나로 줄인다", () => {
    expect(normalizeNameForMatching("A - B")).toBe("a b");
  });
});

describe("rankByQuery", () => {
  const names = ["글렌알라키 12년", "글렌고인 15년", "발베니 12년", "글렌피딕"];

  it("접두사 일치를 부분 일치보다 우선한다", () => {
    const ranked = rankByQuery(names, "글렌", (n) => n);
    // "글렌"으로 시작하는 셋 모두 "발베니" 보다 앞선다.
    expect(ranked).not.toContain("발베니 12년");
    expect(ranked.slice(0, 3).sort()).toEqual(
      ["글렌알라키 12년", "글렌고인 15년", "글렌피딕"].sort(),
    );
  });

  it("접두사 일치가 여러 개면 동순위는 이름순이다", () => {
    const ranked = rankByQuery(["글렌고인", "글렌알라키"], "글렌", (n) => n);
    expect(ranked).toEqual(["글렌고인", "글렌알라키"]);
  });

  it("단어 시작 일치(구분자 뒤)를 부분 일치보다 우선한다", () => {
    const ranked = rankByQuery(["위스키 글렌 에디션", "발글렌리버"], "글렌", (n) => n);
    // "위스키 글렌 에디션" 은 공백 뒤 단어 시작, "발글렌리버" 는 중간 부분 일치.
    expect(ranked).toEqual(["위스키 글렌 에디션", "발글렌리버"]);
  });

  it("일치하지 않는 항목은 제외한다", () => {
    const ranked = rankByQuery(names, "발베니", (n) => n);
    expect(ranked).toEqual(["발베니 12년"]);
  });

  it("빈 검색어는 전체를 그대로 돌려준다", () => {
    expect(rankByQuery(names, "", (n) => n)).toEqual(names);
    expect(rankByQuery(names, "   ", (n) => n)).toEqual(names);
  });

  it("검색어가 모두 초성이면 후보 이름의 초성과 비교한다", () => {
    const ranked = rankByQuery(names, "ㄱㄹㄱㅇ", (n) => n);
    expect(ranked).toEqual(["글렌고인 15년"]);
  });

  it("초성 검색도 접두사·부분 순위를 따른다", () => {
    const ranked = rankByQuery(["글렌고인", "안글렌고인아님"], "ㄱㄹㄱㅇ", (n) => n);
    expect(ranked).toEqual(["글렌고인", "안글렌고인아님"]);
  });
});

describe("matchesQuery", () => {
  it("일치하면 true", () => {
    expect(matchesQuery("글렌고인 15년", "글렌")).toBe(true);
    expect(matchesQuery("글렌고인 15년", "ㄱㄹㄱㅇ")).toBe(true);
  });

  it("일치하지 않으면 false", () => {
    expect(matchesQuery("발베니 12년", "글렌")).toBe(false);
  });

  it("빈 검색어는 항상 true", () => {
    expect(matchesQuery("아무거나", "")).toBe(true);
  });
});

import searchCases from "../../tests/fixtures/search_cases.json";

describe("한영 검색 공통 정답", () => {
  for (const item of searchCases.cases) {
    it(item.id, () => expect(matchesQuery(item.name, item.query)).toBe(item.match));
  }
});

it("외부 확장 질의는 브랜드 이외의 숙성·규격·배치 단위를 보존한다", () => {
  expect(expandSearchQueries("글렌알라키 12년 700ml 배치 3")).toEqual([
    "글렌알라키 12년 700ml 배치 3",
    "GlenAllachie 12년 700ml 배치 3",
  ]);
  expect(expandSearchQueries("GlenAllachie 12 years old, 0.7L (Batch 3)")[1]).toBe(
    "글렌알라키 12 years old, 0.7L (Batch 3)",
  );
  expect(expandSearchQueries("미확인브랜드")).toEqual(["미확인브랜드"]);
});

it.each([
  ["The Glenlivet 12", "The", true],
  ["The Glenlivet 12", "The Glen", true],
  ["The Glenlivet 12", "The Glenlivet 1", false],
  ["ガ 12", "カ 12", false],
  ["ガ 12", "カ\u3099 12", true],
  ["Kahlúa", "Kahlua", true],
])("원문 부분검색과 비Latin 결합문자 보존: %s / %s", (name, query, expected) => {
  expect(matchesQuery(name as string, query as string)).toBe(expected);
});

// 서버 `tests/domain/test_search.py`의 같은 이름 테스트와 같은 표다(D244 동일 정규화).
const LITER_PARITY: [string, string][] = [
  ["1.1l", "1100ml"],
  ["0.75L", "750ml"],
  ["1.2345l", "1234 5ml"],
  ["0.7l병", "700ml병"],
  ["1 liter", "1 liter"],
  // 단위 뒤에 숫자·밑줄이 이어지면 판본 표기다(용량으로 바꾸지 않는다).
  ["batch 1l2", "batch 1l2"],
  ["cask_1l_a", "cask 1l a"],
];

it.each(
  LITER_PARITY,
)("리터 %s는 부동소수 오차 없이 서버와 같은 %s로 정규화한다", (raw, normalized) => {
  expect(normalizeSearchText(raw)).toBe(normalized);
});

it.each([
  ["합성 진 0.7L", "0.7", true],
  ["합성 진 0.7L", "700ml", true],
  ["합성 위스키 120", "12", false],
  // 원문 소수의 조각은 숫자로 보지 않는다(700ml에 "7"·"0"이 걸리지 않게).
  ["합성 진 0.7L", "7", false],
  ["합성 진 0.7L", "0", false],
  ["합성 몰트 43.5%", "43", true],
] as const)("이름 원문 소수 %s를 %s로 찾되 숫자는 통째로 비교한다", (name, query, match) => {
  expect(matchesQuery(name, query)).toBe(match);
});
