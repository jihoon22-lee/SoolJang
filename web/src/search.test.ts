import { describe, expect, it } from "vitest";
import { extractChosung, matchesQuery, normalizeNameForMatching, rankByQuery } from "@/search";

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
