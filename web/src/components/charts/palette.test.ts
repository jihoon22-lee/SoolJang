import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CHART_PALETTE } from "@/components/charts/palette";

// Vitest 는 CSS import 를 비워 두므로(`css: false`) 원문을 직접 읽는다.
const styles = readFileSync("src/styles.css", "utf8");

it("SVG 팔레트는 CSS 차트 색과 같고 위험 의미색을 쓰지 않는다", () => {
  const cssColors = CHART_PALETTE.map(
    (_, index) => styles.match(new RegExp(`--chart-${index + 1}:\\s*(#[0-9a-fA-F]{6})`))?.[1],
  );
  const danger = styles.match(/--danger:\s*(#[0-9a-fA-F]{6})/)?.[1];

  expect(CHART_PALETTE).toEqual(cssColors);
  expect(CHART_PALETTE).not.toContain(danger);
});
