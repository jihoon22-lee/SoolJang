import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Vitest 는 CSS import 를 비워 두므로(`css: false`) 원문을 직접 읽는다.
const styles = readFileSync("src/styles.css", "utf8");

function token(name: string): string {
  const match = styles.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match?.[1]) throw new Error(`--${name} 색을 찾지 못했습니다`);
  return match[1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

describe("입력 컨트롤 시인성", () => {
  it("입력 테두리와 빈 별은 놓이는 모든 배경에서 3:1 이상이다", () => {
    for (const background of ["bg", "bg-raised", "surface", "surface-raised"]) {
      expect(contrast(token("control-border"), token(background))).toBeGreaterThanOrEqual(3);
    }
  });

  it("공통·필드 입력은 이 테두리와 iOS 확대를 막는 16px 글자를 쓴다", () => {
    for (const selector of [
      'input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"]),\nselect,\ntextarea {',
      ".field input,\n.field select,\n.field textarea {",
    ]) {
      const start = styles.indexOf(selector);
      expect(start).toBeGreaterThanOrEqual(0);
      const block = styles.slice(start, styles.indexOf("}", start));
      expect(block).toContain("border: 1px solid var(--control-border)");
      expect(block).toContain("font-size: max(1rem, 16px)");
    }
  });
});
