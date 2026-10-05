import { afterEach, describe, expect, it, vi } from "vitest";
import { DISPLAY_PREFERENCES_CHANGED, getDensity, setDensity } from "@/displayPreferences";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("표 밀도 설정", () => {
  it("기본은 넉넉하게이고, 바꾸면 기억하고 알린다", () => {
    const listener = vi.fn();
    window.addEventListener(DISPLAY_PREFERENCES_CHANGED, listener);

    expect(getDensity()).toBe("comfortable");
    setDensity("compact");

    expect(getDensity()).toBe("compact");
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(DISPLAY_PREFERENCES_CHANGED, listener);
  });

  it("저장소를 쓸 수 없어도 기본값으로 동작한다", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(getDensity()).toBe("comfortable");
    expect(() => setDensity("compact")).not.toThrow();
  });
});
