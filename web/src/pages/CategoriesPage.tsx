import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { categoriesApi } from "@/api/client";
import type { DeleteStrategy } from "@/api/types";
import { CategoryManager } from "@/components/CategoryManager";

/** 주종 관리 화면. */
export function CategoriesPage() {
  const queryClient = useQueryClient();

  const tree = useQuery({
    queryKey: ["categories"],
    queryFn: ({ signal }) => categoriesApi.tree(signal),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["categories"] });
    // 주종이 바뀌면 목록의 주종 경로·필터 결과도 달라진다.
    void queryClient.invalidateQueries({ queryKey: ["products"] });
  };

  const create = useMutation({
    mutationFn: ({ name, parentId }: { name: string; parentId: string | null }) =>
      categoriesApi.create({ name, parent_id: parentId }),
    onSuccess: invalidate,
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => categoriesApi.rename(id, name),
    onSuccess: invalidate,
  });

  const reparent = useMutation({
    mutationFn: ({ id, parentId }: { id: string; parentId: string | null }) =>
      categoriesApi.reparent(id, parentId),
    onSuccess: invalidate,
  });

  const merge = useMutation({
    mutationFn: ({ id, targetId }: { id: string; targetId: string }) =>
      categoriesApi.merge(id, targetId),
    onSuccess: invalidate,
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
    onSuccess: invalidate,
  });

  const resetSeed = useMutation({
    mutationFn: () => categoriesApi.resetSeed(),
    onSuccess: invalidate,
  });

  if (tree.isPending) {
    return <output aria-live="polite">주종 계층을 불러오고 있습니다…</output>;
  }

  if (tree.error instanceof Error || !tree.data) {
    return (
      <p className="alert" role="alert">
        주종을 불러올 수 없습니다
        {tree.error instanceof Error ? `: ${tree.error.message}` : ""}
      </p>
    );
  }

  const busy =
    create.isPending ||
    rename.isPending ||
    reparent.isPending ||
    merge.isPending ||
    remove.isPending ||
    resetSeed.isPending;

  const error =
    create.error ??
    rename.error ??
    reparent.error ??
    merge.error ??
    remove.error ??
    resetSeed.error;

  return (
    <CategoryManager
      tree={tree.data}
      busy={busy}
      error={error}
      onCreate={(name, parentId) => create.mutate({ name, parentId })}
      onRename={(id, name) => rename.mutate({ id, name })}
      onReparent={(id, parentId) => reparent.mutate({ id, parentId })}
      onMerge={(id, targetId) => merge.mutate({ id, targetId })}
      onDelete={(id, strategy, targetId) => remove.mutate({ id, strategy, targetId })}
      onResetSeed={() => resetSeed.mutate()}
    />
  );
}
