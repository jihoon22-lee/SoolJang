import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, productsApi, purchasesApi } from "@/api/client";
import type { Product } from "@/api/types";
import { ProductsPage } from "@/pages/ProductsPage";
import { StoreModePage } from "@/pages/StoreModePage";
import { activateDatabase, db, lockDatabase } from "@/sync/db";
import { renderWithQuery, stubRoutes } from "@/testing";

const connection = vi.hoisted(() => ({ state: "idle" }));
vi.mock("@/sync/SyncStatusProvider", () => ({
  useSyncStatus: () => ({ state: connection.state, triggerSync: vi.fn() }),
}));

const created = {
  id: "recovery-product",
  name: "복구 확인용 합성 제품",
  name_en: null,
  search_aliases: [],
  category_id: null,
  category_path: [],
  producer_id: null,
  producer_name: null,
  country: null,
  region: null,
  abv: null,
  vintage: null,
  age_years: null,
  personal_rating: null,
  note: null,
  varieties: [],
  skus: [
    { id: "recovery-sku", volume_ml: 700, barcode: null, barcode_type: null, package_note: null },
  ],
  created_at: "2026-10-23T00:00:00Z",
  updated_at: "2026-10-23T00:00:00Z",
} as unknown as Product;

const select = vi.fn();
function page(selectedProductId: string | null = null) {
  return (
    <ProductsPage
      selectedProductId={selectedProductId}
      onSelectProduct={select}
      onDeselectProduct={vi.fn()}
      onOpenStoreMode={vi.fn()}
    />
  );
}

beforeEach(async () => {
  connection.state = "idle";
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem("sooljang-draft-tab", "recovery-ui-tab");
  await activateDatabase("recovery-ui-owner");
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
  select.mockClear();
  stubRoutes([{ match: "/interests", body: [] }]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  lockDatabase();
});

async function startProductSave() {
  let resolve!: (value: Product) => void;
  const create = vi.spyOn(productsApi, "create").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = renderWithQuery(page());
  await userEvent.click(await screen.findByRole("button", { name: "새 술 등록" }));
  await userEvent.type(screen.getByLabelText("이름 *"), created.name);
  await userEvent.type(screen.getByLabelText("메모"), "제출한 메모");
  await userEvent.click(screen.getByRole("button", { name: "등록" }));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  return { view, create, resolve };
}

it("제품 등록을 기다리는 동안 입력·Esc·폼 닫기를 잠그고 재진입한 폼도 같은 완료를 확인한다", async () => {
  const { view, create, resolve } = await startProductSave();
  expect(screen.getByLabelText("메모")).toBeDisabled();
  expect(screen.getByRole("button", { name: "폼 닫기" })).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("heading", { name: "새 술 등록" })).toBeInTheDocument();

  view.rerender(<p>다른 화면</p>);
  view.rerender(page());
  await userEvent.click(await screen.findByRole("button", { name: "등록 이어서 작성" }));
  expect(screen.getByLabelText("이름 *")).toHaveValue(created.name);
  expect(screen.getByLabelText("이름 *")).toBeDisabled();
  await act(async () => {
    resolve(created);
  });
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "새 술 등록" })).not.toBeInTheDocument(),
  );
  await userEvent.click(screen.getByRole("button", { name: "새 술 등록" }));
  expect(screen.getByLabelText("이름 *")).toHaveValue("");
  expect(screen.getByLabelText("메모")).toHaveValue("");
  expect(create).toHaveBeenCalledOnce();
  expect(await db.product.count()).toBe(1);
});

it("다른 버전 초안이 남은 생성 완료는 기존 제품으로 안내하고 명시적 폐기 전에는 신규 등록을 막는다", async () => {
  const { view, create, resolve } = await startProductSave();
  const key = "sooljang-draft-v1:recovery-ui-owner:recovery-ui-tab:product:create";
  const submitted = JSON.parse(localStorage.getItem(key) ?? "null");
  localStorage.setItem(
    key,
    JSON.stringify({
      ...submitted,
      value: { ...submitted.value, note: "보존해야 하는 다음 메모" },
      revision: "newer-draft",
    }),
  );
  await act(async () => {
    resolve(created);
  });
  await screen.findByText(/이 술은 이미 등록됐습니다/);
  expect(await screen.findByRole("button", { name: "등록" })).toBeDisabled();
  view.rerender(<p>다른 화면</p>);
  view.rerender(page());
  await userEvent.click(await screen.findByRole("button", { name: "등록 이어서 작성" }));
  expect(screen.getByLabelText("메모")).toHaveValue("보존해야 하는 다음 메모");
  expect(screen.getByRole("button", { name: "등록" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "등록한 술 열기" }));
  expect(select).toHaveBeenCalledWith(created.id);
  expect(localStorage.getItem(key)).toContain("보존해야 하는 다음 메모");
  await userEvent.click(screen.getByRole("button", { name: "등록 이어서 작성" }));
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await userEvent.click(screen.getByRole("button", { name: "보관 입력 지우고 새로 작성" }));
  await waitFor(() => expect(screen.getByLabelText("이름 *")).toHaveValue(""));
  expect(localStorage.getItem(key)).toBeNull();
  expect(create).toHaveBeenCalledOnce();
});

it("제품 응답 유실 뒤 재진입한 다른 초안은 잠그고 처음 입력으로 결과를 확인해도 보존한다", async () => {
  const create = vi
    .spyOn(productsApi, "create")
    .mockRejectedValueOnce(new TypeError("응답 유실"))
    .mockResolvedValue(created);
  const view = renderWithQuery(page());
  await userEvent.click(await screen.findByRole("button", { name: "새 술 등록" }));
  await userEvent.type(screen.getByLabelText("이름 *"), created.name);
  await userEvent.click(screen.getByRole("button", { name: "등록" }));
  await screen.findByText("응답 유실");
  expect(screen.getByLabelText("이름 *")).toBeDisabled();
  expect(screen.getByLabelText("병수")).not.toBeDisabled();
  const key = "sooljang-draft-v1:recovery-ui-owner:recovery-ui-tab:product:create";
  const submitted = JSON.parse(localStorage.getItem(key) ?? "null");
  localStorage.setItem(
    key,
    JSON.stringify({
      ...submitted,
      value: { ...submitted.value, note: "나중에 쓴 초안" },
      revision: "later",
    }),
  );
  view.rerender(<p>다른 화면</p>);
  view.rerender(page());
  await userEvent.click(await screen.findByRole("button", { name: "등록 이어서 작성" }));
  expect(screen.getByLabelText("메모")).toHaveValue("나중에 쓴 초안");
  expect(screen.getByLabelText("메모")).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "처음 입력으로 이어서 저장" }));
  await screen.findByText(/이 술은 이미 등록됐습니다/);
  expect(localStorage.getItem(key)).toContain("나중에 쓴 초안");
  expect(create.mock.calls[1]?.[0]).toEqual(create.mock.calls[0]?.[0]);
});

it.each([
  "제품 목록",
  "매장 모드",
])("%s의 확정 제품 충돌은 안내와 명시 확인 뒤 새 작성으로 돌아간다", async (entry) => {
  const create = vi
    .spyOn(productsApi, "create")
    .mockRejectedValueOnce(new ApiError(409, "앞선 등록 내역을 확인할 수 없습니다"))
    .mockResolvedValue(created);
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
  if (entry === "제품 목록") {
    renderWithQuery(page());
    await userEvent.click(await screen.findByRole("button", { name: "새 술 등록" }));
    await userEvent.type(screen.getByLabelText("이름 *"), created.name);
  } else {
    renderWithQuery(<StoreModePage onOpenDetail={select} />);
    await userEvent.type(screen.getByLabelText("이름으로 찾기"), created.name);
    await userEvent.click(
      await screen.findByRole("button", { name: `"${created.name}" 새로 등록` }),
    );
  }
  await userEvent.click(screen.getByRole("button", { name: "등록" }));
  await screen.findByText(/기존에 저장된 술이 있을 수/);
  expect(screen.getByRole("button", { name: "등록" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "처음 입력으로 이어서 저장" }),
  ).not.toBeInTheDocument();
  const stop = screen.getByRole("button", { name: "등록 요청 중단하고 새로 작성" });
  await userEvent.click(stop);
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("술 목록"));
  expect(screen.getByLabelText("이름 *")).toHaveValue(created.name);
  expect(create).toHaveBeenCalledOnce();
  await userEvent.click(stop);
  await waitFor(() => expect(screen.getByLabelText("이름 *")).toBeEnabled());
  expect(screen.queryByText(/기존에 저장된 술이 있을 수/)).not.toBeInTheDocument();
  expect(create).toHaveBeenCalledOnce();
  await userEvent.clear(screen.getByLabelText("이름 *"));
  await userEvent.type(screen.getByLabelText("이름 *"), "목록 확인 후 새 술");
  await userEvent.click(screen.getByRole("button", { name: "등록" }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  expect(create.mock.calls[1]?.[0].request_id).not.toBe(create.mock.calls[0]?.[0].request_id);
});

it("매장 모드의 저장 중 검색 복귀는 잠기며 구매 실패 뒤 재열기도 이미 만든 제품을 이어 쓴다", async () => {
  const create = vi.spyOn(productsApi, "create").mockResolvedValue(created);
  let reject!: (error: Error) => void;
  const purchase = vi
    .spyOn(purchasesApi, "create")
    .mockImplementationOnce(
      () =>
        new Promise((_done, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValue({ id: "recovery-purchase" } as never);
  const view = renderWithQuery(<StoreModePage onOpenDetail={select} />);
  await userEvent.type(screen.getByLabelText("이름으로 찾기"), created.name);
  await userEvent.click(await screen.findByRole("button", { name: `"${created.name}" 새로 등록` }));
  await userEvent.type(screen.getByLabelText("용량 (ml)"), "700");
  await userEvent.type(screen.getByLabelText("병수"), "1");
  await userEvent.click(screen.getByRole("button", { name: "등록" }));
  await waitFor(() => expect(purchase).toHaveBeenCalledOnce());
  expect(screen.getByRole("button", { name: "← 검색으로" })).toBeDisabled();
  expect(screen.getByLabelText("병수")).toBeDisabled();
  await act(async () => {
    reject(new Error("구매 응답 유실"));
  });
  await screen.findByText(/나머지 항목 저장에 실패/);
  expect(screen.getByLabelText("이름 *")).toBeDisabled();
  expect(screen.getByLabelText("병수")).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "← 검색으로" }));
  await userEvent.click(screen.getByRole("button", { name: `"${created.name}" 새로 등록` }));
  expect(screen.getByLabelText("이름 *")).toBeDisabled();
  connection.state = "offline";
  view.rerender(<StoreModePage onOpenDetail={select} />);
  await userEvent.click(screen.getByRole("button", { name: "등록" }));
  await screen.findByText(/앞서 보낸 등록은 온라인에서/);
  expect(await db.outbox.count()).toBe(0);
  connection.state = "idle";
  view.rerender(<StoreModePage onOpenDetail={select} />);
  await userEvent.click(screen.getByRole("button", { name: "등록" }));
  await screen.findByRole("heading", { name: created.name });
  expect(create).toHaveBeenCalledOnce();
  expect(purchase).toHaveBeenCalledTimes(2);
  expect(await db.product.count()).toBe(1);
});

it("제품 수정의 늦은 성공은 새 초안을 지우거나 다시 연 수정 폼을 닫지 않는다", async () => {
  await db.product.put({
    ...created,
    user_id: "recovery-ui-owner",
    deleted_at: null,
  });
  let resolve!: (value: Product) => void;
  const update = vi.spyOn(productsApi, "update").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = renderWithQuery(page(created.id));
  await userEvent.click(await screen.findByRole("button", { name: "수정" }));
  await userEvent.type(screen.getByLabelText("메모"), "제출한 수정 메모");
  await userEvent.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(screen.getByLabelText("메모")).toBeDisabled();
  view.rerender(<p>다른 화면</p>);
  view.rerender(page(created.id));
  await userEvent.click(await screen.findByRole("button", { name: "수정" }));
  await userEvent.clear(screen.getByLabelText("메모"));
  await userEvent.type(screen.getByLabelText("메모"), "새 폼에서 작성한 메모");
  await act(async () => {
    resolve(created);
  });
  expect(screen.getByRole("heading", { name: "정보 수정" })).toBeInTheDocument();
  expect(screen.getByLabelText("메모")).toHaveValue("새 폼에서 작성한 메모");
  const key = `sooljang-draft-v1:recovery-ui-owner:recovery-ui-tab:product:edit:${created.id}`;
  expect(localStorage.getItem(key)).toContain("새 폼에서 작성한 메모");
});
