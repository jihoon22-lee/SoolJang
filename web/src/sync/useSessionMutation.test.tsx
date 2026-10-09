import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EMPTY_PRODUCT_FORM } from "@/components/ProductForm";
import { activateDatabase, db, lockDatabase } from "@/sync/db";
import { enqueue } from "@/sync/outbox";
import { useCreateProduct } from "@/sync/useCreateProduct";
import { useSessionMutation } from "@/sync/useSessionMutation";

vi.mock("@/sync/SyncStatusProvider", () => ({
  useSyncStatus: () => ({ state: "offline", triggerSync: vi.fn() }),
}));

beforeEach(async () => {
  await activateDatabase("writer");
});
afterEach(async () => {
  onlineManager.setOnline(true);
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
  localStorage.clear();
});
function clientWrapper() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

it("실제 오프라인 상태에서도 제품·규격·구매를 즉시 영속화한다", async () => {
  onlineManager.setOnline(false);
  const hook = renderHook(useCreateProduct, { wrapper: clientWrapper() });
  await act(async () => {
    await hook.result.current.mutateAsync({
      values: { ...EMPTY_PRODUCT_FORM, name: "오프라인 술", volumeMl: "700", quantity: "2" },
    });
  });
  expect(await db.product.count()).toBe(1);
  expect(await db.bottle.count()).toBe(2);
  expect(await db.outbox.count()).toBe(3);
  expect(hook.result.current.isPaused).toBe(false);
});

it("로그아웃 뒤 재개된 온라인 작업은 요청 자체를 실행하지 않는다", async () => {
  onlineManager.setOnline(false);
  const work = vi.fn(async () => "saved");
  const success = vi.fn();
  const hook = renderHook(
    () => useSessionMutation({ networkMode: "online", mutationFn: work, onSuccess: success }),
    { wrapper: clientWrapper() },
  );
  act(() => hook.result.current.mutate(undefined));
  await waitFor(() => expect(hook.result.current.isPaused).toBe(true));
  lockDatabase();
  await act(async () => onlineManager.setOnline(true));
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
  expect(work).not.toHaveBeenCalled();
  expect(success).not.toHaveBeenCalled();
  expect(await db.outbox.count()).toBe(0);
});

it("계정 변경 후 늦은 성공 응답이 초안 삭제나 화면 이동을 실행하지 않는다", async () => {
  let finish!: (value: string) => void;
  const response = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const success = vi.fn();
  const navigate = vi.fn();
  const hook = renderHook(
    () => useSessionMutation({ mutationFn: () => response, onSuccess: success }),
    { wrapper: clientWrapper() },
  );
  act(() => hook.result.current.mutate(undefined, { onSuccess: navigate }));
  await waitFor(() => expect(hook.result.current.isPending).toBe(true));
  await activateDatabase("next-writer");
  await act(async () => finish("saved"));
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
  expect(success).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
});

it("잠긴 DB와 빈 소유자 명령은 저장하지 않는다", async () => {
  const input = {
    entity: "product" as const,
    op: "create" as const,
    entityId: "p1",
    fields: { name: "술" },
    optimisticRow: {
      id: "p1",
      user_id: "",
      created_at: "now",
      updated_at: "now",
      deleted_at: null,
    },
  };
  await expect(enqueue(input)).rejects.toThrow("다른 계정");
  lockDatabase();
  await expect(enqueue(input)).rejects.toThrow("로그인한 계정");
  expect(await db.outbox.count()).toBe(0);
});
