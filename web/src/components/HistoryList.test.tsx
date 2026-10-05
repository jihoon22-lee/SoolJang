import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { describeHistory, HistoryDetails } from "@/components/HistoryList";
import { renderWithQuery } from "@/testing";

describe("HistoryList", () => {
  it("바뀐 칸을 이전 → 이후 문장으로 보인다", () => {
    expect(
      describeHistory({
        at: "2026-10-05T00:00:00Z",
        action: "finish",
        detail: { status: ["open", "finished"], remaining_ml: [300, 0] },
      }),
    ).toBe("상태 개봉 → 소진 · 잔량(ml) 300 → 0");
    expect(
      describeHistory({ at: "x", action: "gift", detail: { note: "친구", vendor_id: ["a", "b"] } }),
    ).toBe("메모 친구 · 구매처 다른 구매처 → 다른 구매처");
  });

  it("펼칠 때만 불러오고 오프라인이면 안내한다", async () => {
    const load = vi.fn(async () => [
      { at: "2026-10-05T01:00:00Z", action: "open", detail: { status: ["unopened", "open"] } },
    ]);
    const { unmount } = renderWithQuery(<HistoryDetails queryKey={["h", 1]} load={load} online />);
    expect(load).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("변경 이력"));
    expect(await screen.findByText("상태 미개봉 → 개봉")).toBeInTheDocument();
    unmount();

    renderWithQuery(<HistoryDetails queryKey={["h", 2]} load={load} online={false} />);
    await userEvent.click(screen.getByText("변경 이력"));
    expect(screen.getByText("변경 이력은 온라인에서 볼 수 있습니다.")).toBeInTheDocument();
  });
});
