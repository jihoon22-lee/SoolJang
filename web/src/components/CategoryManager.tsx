import { useMemo, useState } from "react";
import type { CategoryNode, CategoryTree, DeleteStrategy } from "@/api/types";

interface CategoryManagerProps {
  tree: CategoryTree;
  busy: boolean;
  error: unknown;
  /** 이동·병합·삭제·기본값 복원은 순환·깊이 재검사가 필요해 온라인 전용이다. */
  offline: boolean;
  onCreate: (name: string, parentId: string | null) => void;
  onRename: (id: string, name: string) => void;
  onReparent: (id: string, newParentId: string | null) => void;
  onMerge: (id: string, targetId: string) => void;
  onDelete: (id: string, strategy: DeleteStrategy, targetId?: string) => void;
  onResetSeed: () => void;
}

/**
 * 주종 계층 관리.
 *
 * 사용자가 최상위부터 말단까지 자유롭게 추가·이름 변경·이동·삭제·병합할 수 있어야 한다
 * (`docs/plan.md` §5-D24).
 *
 * 이동을 드래그 대신 **부모 선택 드롭다운**으로 구현했다. 드래그는 키보드로 조작할 수 없고
 * 모바일에서 스크롤과 충돌한다. 개인 도구에서 계층을 바꾸는 일은 드물어 정확성이 편의보다
 * 중요하다.
 */
export function CategoryManager({
  tree,
  busy,
  error,
  offline,
  onCreate,
  onRename,
  onReparent,
  onMerge,
  onDelete,
  onResetSeed,
}: CategoryManagerProps) {
  const [newName, setNewName] = useState("");
  const [newParentId, setNewParentId] = useState("");

  const roots = useMemo(() => tree.items.filter((item) => item.parent_id === null), [tree.items]);
  const childrenOf = useMemo(() => {
    const map = new Map<string, CategoryNode[]>();
    for (const item of tree.items) {
      if (item.parent_id === null) continue;
      const list = map.get(item.parent_id) ?? [];
      list.push(item);
      map.set(item.parent_id, list);
    }
    return map;
  }, [tree.items]);

  return (
    <section aria-labelledby="category-heading">
      <h2 id="category-heading">주종 관리</h2>
      <p className="muted mt-0">
        현재 최대 깊이 {tree.max_depth} / 상한 {tree.depth_limit}. 필요한 만큼 세분화할 수 있습니다.
        삭제해도 소속된 술은 지워지지 않습니다.
      </p>

      {error instanceof Error && (
        <p className="alert" role="alert">
          {error.message}
        </p>
      )}

      <form
        className="panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (!newName.trim()) return;
          onCreate(newName.trim(), newParentId || null);
          setNewName("");
        }}
      >
        <h3 className="form-heading">주종 추가</h3>
        <div className="field">
          <label htmlFor="new-category-name">이름</label>
          <input
            id="new-category-name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="new-category-parent">상위 주종</label>
          <select
            id="new-category-parent"
            value={newParentId}
            onChange={(event) => setNewParentId(event.target.value)}
          >
            <option value="">최상위로 추가</option>
            {tree.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.path.join(" › ")}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="primary" disabled={busy || !newName.trim()}>
          추가
        </button>
      </form>

      <div className="button-row mt-3 mb-3">
        <button type="button" onClick={onResetSeed} disabled={busy || offline}>
          기본 주종 복원
        </button>
        <span className="muted text-sm self-center">
          {offline
            ? "오프라인에서는 사용할 수 없습니다."
            : "직접 만들거나 이름을 바꾼 주종은 그대로 유지됩니다."}
        </span>
      </div>

      {tree.items.length === 0 ? (
        <output className="notice">
          등록된 주종이 없습니다. 기본 주종을 복원하거나 직접 추가하세요.
        </output>
      ) : (
        <ul className="category-tree">
          {roots.map((root) => (
            <CategoryBranch
              key={root.id}
              node={root}
              childrenOf={childrenOf}
              allNodes={tree.items}
              busy={busy}
              offline={offline}
              onRename={onRename}
              onReparent={onReparent}
              onMerge={onMerge}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface BranchProps {
  node: CategoryNode;
  childrenOf: Map<string, CategoryNode[]>;
  allNodes: CategoryNode[];
  busy: boolean;
  offline: boolean;
  onRename: (id: string, name: string) => void;
  onReparent: (id: string, newParentId: string | null) => void;
  onMerge: (id: string, targetId: string) => void;
  onDelete: (id: string, strategy: DeleteStrategy, targetId?: string) => void;
}

function CategoryBranch({
  node,
  childrenOf,
  allNodes,
  busy,
  offline,
  onRename,
  onReparent,
  onMerge,
  onDelete,
}: BranchProps) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(node.name);
  const children = childrenOf.get(node.id) ?? [];

  // 자기 자신과 후손은 이동·병합 대상이 될 수 없다. 순환이 생긴다.
  const descendantIds = collectDescendantIds(node.id, childrenOf);
  const moveTargets = allNodes.filter((item) => item.id !== node.id && !descendantIds.has(item.id));

  return (
    <li>
      <div className="category-row">
        {editing ? (
          <>
            <label className="sr-only" htmlFor={`rename-${node.id}`}>
              {node.name} 새 이름
            </label>
            <input
              id={`rename-${node.id}`}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
            />
            <button
              type="button"
              className="primary"
              disabled={busy || !draftName.trim()}
              onClick={() => {
                onRename(node.id, draftName.trim());
                setEditing(false);
              }}
            >
              저장
            </button>
            <button
              type="button"
              onClick={() => {
                setDraftName(node.name);
                setEditing(false);
              }}
            >
              취소
            </button>
          </>
        ) : (
          <>
            <span className="name">{node.name}</span>
            <span className="badge">{node.descendant_product_count}종</span>
            {node.is_seeded && <span className="muted">기본</span>}
            <button type="button" onClick={() => setEditing(true)} disabled={busy}>
              이름 변경
            </button>

            <label className="sr-only" htmlFor={`move-${node.id}`}>
              {node.name} 상위 주종 변경
            </label>
            <select
              id={`move-${node.id}`}
              value={node.parent_id ?? ""}
              disabled={busy || offline}
              onChange={(event) => onReparent(node.id, event.target.value || null)}
            >
              <option value="">최상위</option>
              {moveTargets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.path.join(" › ")}
                </option>
              ))}
            </select>

            <label className="sr-only" htmlFor={`merge-${node.id}`}>
              {node.name} 을 다른 주종으로 병합
            </label>
            <select
              id={`merge-${node.id}`}
              value=""
              disabled={busy || offline || moveTargets.length === 0}
              onChange={(event) => {
                if (event.target.value) onMerge(node.id, event.target.value);
              }}
            >
              <option value="">병합…</option>
              {moveTargets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.path.join(" › ")}
                </option>
              ))}
            </select>

            <DeleteControl
              node={node}
              hasChildren={children.length > 0}
              targets={moveTargets}
              busy={busy}
              offline={offline}
              onDelete={onDelete}
            />
          </>
        )}
      </div>

      {children.length > 0 && (
        <ul>
          {children.map((child) => (
            <CategoryBranch
              key={child.id}
              node={child}
              childrenOf={childrenOf}
              allNodes={allNodes}
              busy={busy}
              offline={offline}
              onRename={onRename}
              onReparent={onReparent}
              onMerge={onMerge}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function DeleteControl({
  node,
  hasChildren,
  targets,
  busy,
  offline,
  onDelete,
}: {
  node: CategoryNode;
  hasChildren: boolean;
  targets: CategoryNode[];
  busy: boolean;
  offline: boolean;
  onDelete: (id: string, strategy: DeleteStrategy, targetId?: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [reassignTo, setReassignTo] = useState("");

  const needsChoice = hasChildren || node.product_count > 0;

  if (!asking) {
    return (
      <button
        type="button"
        className="danger"
        disabled={busy || offline}
        onClick={() => setAsking(true)}
      >
        삭제
      </button>
    );
  }

  if (!needsChoice) {
    return (
      <span className="button-row">
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => {
            onDelete(node.id, "reject");
            setAsking(false);
          }}
        >
          정말 삭제
        </button>
        <button type="button" onClick={() => setAsking(false)}>
          취소
        </button>
      </span>
    );
  }

  return (
    <fieldset className="button-row fieldset-plain">
      <legend className="sr-only">{node.name} 삭제 방식 선택</legend>
      {hasChildren && (
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => {
            onDelete(node.id, "promote_children");
            setAsking(false);
          }}
        >
          하위를 상위로 올리고 삭제
        </button>
      )}
      {node.product_count > 0 && (
        <>
          <label className="sr-only" htmlFor={`reassign-${node.id}`}>
            {node.name} 의 술을 옮길 주종
          </label>
          <select
            id={`reassign-${node.id}`}
            value={reassignTo}
            onChange={(event) => setReassignTo(event.target.value)}
          >
            <option value="">술을 옮길 주종 선택…</option>
            {targets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.path.join(" › ")}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="danger"
            disabled={busy || !reassignTo}
            onClick={() => {
              onDelete(node.id, "reassign", reassignTo);
              setAsking(false);
            }}
          >
            옮기고 삭제
          </button>
        </>
      )}
      <button type="button" onClick={() => setAsking(false)}>
        취소
      </button>
    </fieldset>
  );
}

function collectDescendantIds(
  rootId: string,
  childrenOf: Map<string, CategoryNode[]>,
): Set<string> {
  const result = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    for (const child of childrenOf.get(current) ?? []) {
      result.add(child.id);
      queue.push(child.id);
    }
  }
  return result;
}
