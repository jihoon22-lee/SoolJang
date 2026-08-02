import { afterEach, describe, expect, it } from "vitest";
import { getLastVendorName, setLastVendorName } from "@/lastVendor";

afterEach(() => {
  window.localStorage.clear();
});

describe("lastVendor", () => {
  it("기록이 없으면 빈 문자열을 돌려준다", () => {
    expect(getLastVendorName()).toBe("");
  });

  it("저장한 값을 돌려준다", () => {
    setLastVendorName("이마트");
    expect(getLastVendorName()).toBe("이마트");
  });

  it("앞뒤 공백을 지워 저장한다", () => {
    setLastVendorName("  이마트  ");
    expect(getLastVendorName()).toBe("이마트");
  });

  it("빈 값은 저장하지 않는다(기존 값 유지)", () => {
    setLastVendorName("이마트");
    setLastVendorName("   ");
    expect(getLastVendorName()).toBe("이마트");
  });
});
