import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";
import { categoriesApi } from "@/api/client";
import type { DeleteStrategy, User } from "@/api/types";
import { CategoryManager } from "@/components/CategoryManager";
import { db } from "@/sync/db";
import { enqueue } from "@/sync/outbox";
import { getCategoryTree } from "@/sync/queries";
import { useSyncStatus } from "@/sync/SyncStatusProvider";
import { newId } from "@/sync/uuid7";

const SLUG_STRIP = /[^0-9a-z가-힣]+/g;

function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(SLUG_STRIP, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "category";
}

/** 주종 관리 화면. */
export function CategoriesPage({
  onSelectCategory,
}: {
  onSelectCategory: (categoryId: string) => void;
}) {
  const queryClient = useQueryClient();
  const { state, triggerSync } = useSyncStatus();
  const offline = state === "offline";

  const tree = useLiveQuery(() => getCategoryTree(), []);

  // 순환·깊이 검사가 필요한 온라인 전용 작업 뒤에는 서버 결과를 즉시 당겨 온다 —
  // 그렇지 않으면 다음 주기적 동기화(최대 60초)까지 로컬 미러가 스테일해진다.
  const invalidateOnline = () => {
    void queryClient.invalidateQueries({ queryKey: ["products"] });
    triggerSync();
  };

  const create = useMutation({
    mutationFn: async ({ name, parentId }: { name: string; parentId: string | null }) => {
      const id = newId();
      const now = new Date().toISOString();
      const currentUser = queryClient.getQueryData<User>(["auth", "me"]);
      await enqueue({
        entity: "category",
        op: "create",
        entityId: id,
        fields: { name, parent_id: parentId, sort_order: 0 },
        optimisticRow: {
          id,
          user_id: currentUser?.id ?? "",
          created_at: now,
          updated_at: now,
          deleted_at: null,
          parent_id: parentId,
          name,
          slug: slugify(name),
          sort_order: 0,
          is_seeded: false,
          note: null,
        },
      });
    },
  });

  const rename = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const current = await db.category.get(id);
      if (!current) throw new Error("주종을 찾을 수 없습니다");
      const now = new Date().toISOString();
      await enqueue({
        entity: "category",
        op: "update",
        entityId: id,
        baseUpdatedAt: current.updated_at,
        fields: { name },
        optimisticRow: { ...current, name, slug: slugify(name), updated_at: now },
      });
    },
  });

  const reparent = useMutation({
    mutationFn: ({ id, parentId }: { id: string; parentId: string | null }) =>
      categoriesApi.reparent(id, parentId),
    onSuccess: invalidateOnline,
  });

  const merge = useMutation({
    mutationFn: ({ id, targetId }: { id: string; targetId: string }) =>
      categoriesApi.merge(id, targetId),
    onSuccess: invalidateOnline,
  });

  const remove = useMutation({
    mutationFn: ({
      id,
      strategy,
      targetId,
    }: {
      id: string;
      strategy: DeleteStrategy;
      targetId?: string | undefined;
    }) => categoriesApi.remove(id, strategy, targetId),
    onSuccess: invalidateOnline,
  });

  const resetSeed = useMutation({
    mutationFn: () => categoriesApi.resetSeed(),
    onSuccess: invalidateOnline,
  });

  if (!tree) {
    return <output aria-live="polite">주종 계층을 불러오고 있습니다…</output>;
  }

  return (
    <CategoryManager
      tree={tree}
      offline={offline}
      createBusy={create.isPending}
      createError={create.error}
      resetSeedBusy={resetSeed.isPending}
      resetSeedError={resetSeed.error}
      renameStatus={rename}
      reparentStatus={reparent}
      mergeStatus={merge}
      removeStatus={remove}
      onCreate={(name, parentId) => create.mutate({ name, parentId })}
      onRename={(id, name) => rename.mutate({ id, name })}
      onReparent={(id, parentId) => reparent.mutate({ id, parentId })}
      onMerge={(id, targetId) => merge.mutate({ id, targetId })}
      onDelete={(id, strategy, targetId) => remove.mutate({ id, strategy, targetId })}
      onResetSeed={() => resetSeed.mutate()}
      onSelectCategory={onSelectCategory}
    />
  );
}
