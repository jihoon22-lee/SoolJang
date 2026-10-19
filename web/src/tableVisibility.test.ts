import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

/**
 * `.table-scroll`은 900px 미만에서 숨는다(`styles.css`). 카드 화면이 따로 없는 표는
 * `table-scroll--always`를 써야 폰에서 사라지지 않는다. jsdom은 CSS를 적용하지 않으므로
 * 소스 계약으로 고정한다.
 */
const sources = Object.fromEntries(
  readdirSync("src", { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".tsx") && !path.endsWith(".test.tsx"))
    .map((path) => [path, readFileSync(`src/${path}`, "utf8")]),
);

it("모바일 카드가 없는 표는 좁은 화면에서도 보인다", () => {
  const hidden = Object.entries(sources)
    .filter(([, source]) => source.includes('className="table-scroll"'))
    .filter(([, source]) => !/className="(product-cards|stats-cards)"/.test(source))
    .map(([path]) => path);
  expect(hidden).toEqual([]);
});

it("데스크톱에서 숨는 카드 목록을 저장된 뷰처럼 유일한 목록에 쓰지 않는다", () => {
  const cardOnly = Object.entries(sources)
    .filter(([, source]) => source.includes('className="stats-cards"'))
    .filter(([, source]) => !source.includes('className="table-scroll"'))
    .map(([path]) => path);
  expect(cardOnly).toEqual([]);
});
