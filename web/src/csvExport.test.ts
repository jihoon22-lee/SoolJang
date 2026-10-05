import { describe, expect, it, vi } from "vitest";
import { downloadCsv, toCsv } from "@/csvExport";

describe("toCsv", () => {
  it("쉼표·따옴표·줄바꿈을 감싸고 수식처럼 보이는 칸은 실행되지 않게 한다", () => {
    const csv = toCsv(
      ["이름", "메모"],
      [
        ['샤토 "가상", 2019', "첫 줄\n둘째 줄"],
        ['=HYPERLINK("x")', null],
        [-3, 42],
      ],
    );

    expect(csv.split("\r\n")).toEqual([
      "이름,메모",
      '"샤토 ""가상"", 2019","첫 줄\n둘째 줄"',
      '"\'=HYPERLINK(""x"")",',
      "-3,42",
    ]);
  });
});

describe("downloadCsv", () => {
  it("UTF-8 BOM 을 붙인 파일로 내려받는다", async () => {
    const created: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      created.push(blob as Blob);
      return "blob:test";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    downloadCsv("술장.csv", ["이름"], [["위스키"]]);

    expect(click).toHaveBeenCalledOnce();
    const buffer = await new Promise<ArrayBuffer>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(created[0] as Blob);
    });
    const bytes = new Uint8Array(buffer);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    vi.restoreAllMocks();
  });
});
