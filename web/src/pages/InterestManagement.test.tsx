import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Interest, interestsApi } from "@/api/interests";
import { InterestsPage } from "@/pages/InterestsPage";
import { SyncStatusProvider } from "@/sync/SyncStatusProvider";
import { renderWithQuery } from "@/testing";

const item: Interest = {
  id: "one",
  name: "수정할 술",
  identity: {
    name: "수정할 술",
    name_en: "Original",
    producer: "Maker",
    age_years: "12",
    volumes_ml: [700, 1000],
  },
  source_matches: {},
  note: "첫 메모",
  archived: false,
  product_id: null,
  updated_at: "2026-10-11T00:00:00Z",
};
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(interestsApi, "list").mockResolvedValue([item]);
  vi.spyOn(interestsApi, "update").mockResolvedValue(item);
});
afterEach(() => vi.restoreAllMocks());
function renderPage() {
  renderWithQuery(
    <SyncStatusProvider>
      <InterestsPage onSelectProduct={vi.fn()} />
    </SyncStatusProvider>,
  );
}

it("짧은 목록에서 편집을 열어 전체 식별정보를 보존하며 이름을 고친다", async () => {
  renderPage();
  const row = (await screen.findByRole("heading", { name: item.name })).closest(
    "li",
  ) as HTMLElement;
  expect(within(row).queryByRole("textbox")).not.toBeInTheDocument();
  await userEvent.click(within(row).getByRole("button", { name: "수정" }));
  const editor = screen.getByRole("form", { name: "관심 정보 수정" });
  await userEvent.clear(within(editor).getByLabelText("관심 제품 이름"));
  await userEvent.type(within(editor).getByLabelText("관심 제품 이름"), "고친 이름");
  await userEvent.click(within(editor).getByRole("button", { name: "변경 저장" }));
  await waitFor(() =>
    expect(interestsApi.update).toHaveBeenCalledWith(
      item.id,
      expect.objectContaining({
        identity: expect.objectContaining({
          name: "고친 이름",
          name_en: "Original",
          producer: "Maker",
          age_years: "12",
          volumes_ml: [700, 1000],
        }),
        expected_updated_at: item.updated_at,
      }),
    ),
  );
});

it("삭제는 읽은 버전으로 확인하고 삭제 목록에서 같은 관심을 복구한다", async () => {
  const removed = { ...item, deleted: true, updated_at: "2026-10-11T01:00:00Z" };
  const remove = vi.spyOn(interestsApi, "remove").mockResolvedValue(removed);
  const restore = vi.spyOn(interestsApi, "restore").mockResolvedValue(item);
  renderPage();
  const row = (await screen.findByRole("heading", { name: item.name })).closest(
    "li",
  ) as HTMLElement;
  await userEvent.click(within(row).getByRole("button", { name: "삭제" }));
  expect(screen.getByText(/구매·병·가격 관측은 유지/)).toBeInTheDocument();
  vi.mocked(interestsApi.list).mockResolvedValue([removed]);
  await userEvent.click(screen.getByRole("button", { name: "관심 삭제 확인" }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith(item.id, item.updated_at));
  await userEvent.selectOptions(screen.getByLabelText("관심 상태"), "deleted");
  await userEvent.click(await screen.findByRole("button", { name: "삭제 복구" }));
  await waitFor(() => expect(restore).toHaveBeenCalledWith(item.id, removed.updated_at));
});

it("식별 편집 충돌에서도 입력을 유지하고 최신 기록을 명시적으로 불러온다", async () => {
  vi.mocked(interestsApi.update).mockRejectedValue(new Error("다른 화면에서 변경했습니다"));
  renderPage();
  await userEvent.click(await screen.findByRole("button", { name: "수정" }));
  await userEvent.clear(screen.getByLabelText("관심 제품 이름"));
  await userEvent.type(screen.getByLabelText("관심 제품 이름"), "보존할 초안");
  vi.mocked(interestsApi.list).mockResolvedValue([
    {
      ...item,
      name: "서버의 이름",
      identity: { ...item.identity, name: "서버의 이름" },
      updated_at: "2026-10-11T02:00:00Z",
    },
  ]);
  await userEvent.click(screen.getByRole("button", { name: "변경 저장" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("다른 화면에서 변경했습니다");
  expect(screen.getByLabelText("관심 제품 이름")).toHaveValue("보존할 초안");
  await userEvent.click(await screen.findByRole("button", { name: "최신 관심 정보 불러오기" }));
  expect(screen.getByLabelText("관심 제품 이름")).toHaveValue("서버의 이름");
});
