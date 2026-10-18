import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { activateDatabase, lockDatabase } from "@/sync/db";
import { readViewState, useViewState } from "@/viewState";

beforeEach(async () => {
  await activateDatabase("view-owner");
});
afterEach(() => {
  lockDatabase();
});

it("같은 계정의 같은 탭 세션에서 보기 상태를 다시 연다", () => {
  const first = renderHook(() => useViewState("demo:filters", { from: "2026-01-01", to: "" }));
  act(() => first.result.current[1]((old) => ({ ...old, to: "2026-03-31" })));
  first.unmount();

  const again = renderHook(() => useViewState("demo:filters", { from: "", to: "" }));
  expect(again.result.current[0]).toEqual({ from: "2026-01-01", to: "2026-03-31" });
});

it("모양이 다르거나 허용값 밖이면 기본값으로 시작한다", async () => {
  sessionStorage.setItem("sooljang:view:view-owner:demo:tab", JSON.stringify("removed-tab"));
  sessionStorage.setItem("sooljang:view:view-owner:demo:obj", JSON.stringify({ from: 3 }));
  sessionStorage.setItem("sooljang:view:view-owner:demo:bad", "{");

  expect(readViewState("demo:tab", "insights", ["insights", "rankings"])).toBe("insights");
  expect(readViewState("demo:obj", { from: "" })).toEqual({ from: "" });
  expect(readViewState("demo:bad", "x")).toBe("x");
});

it("다른 계정의 보기 상태는 읽지 않는다", async () => {
  const mine = renderHook(() => useViewState("demo:tab", "insights"));
  act(() => mine.result.current[1]("rankings"));
  mine.unmount();
  lockDatabase();
  await activateDatabase("someone-else");

  expect(readViewState("demo:tab", "insights")).toBe("insights");
});
