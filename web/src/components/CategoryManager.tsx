import { useEffect, useMemo, useRef, useState } from "react";
import type { CategoryNode, CategoryTree, DeleteStrategy } from "@/api/types";

/**
 * 행 단위 뮤테이션 상태. `useMutation` 결과를 그대로 넘길 수 있도록 필요한 필드만 뽑았다 —
 * 이 컴포넌트가 react-query 를 몰라도 되게 한다.
 */
interface RowActionStatus {
  isPending: boolean;
  isSuccess: boolean;
  variables: { id: string } | undefined;
  error: unknown;
}

const IDLE_STATUS: RowActionStatus = {
  isPending: false,
  isSuccess: false,
  variables: undefined,
  error: null,
};

function byProductCountThenName(a: CategoryNode, b: CategoryNode): number {
  return b.descendant_product_count - a.descendant_product_count || a.name.localeCompare(b.name);
}

interface CategoryManagerProps {
  tree: CategoryTree;
  /** 이동·병합·삭제·기본값 복원은 순환·깊이 재검사가 필요해 온라인 전용이다. */
  offline: boolean;
  createBusy: boolean;
  createError: unknown;
  resetSeedBusy: boolean;
  resetSeedError: unknown;
  renameStatus: RowActionStatus;
  reparentStatus: RowActionStatus;
  mergeStatus: RowActionStatus;
  removeStatus: RowActionStatus;
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
 * 중요하다. 이동·병합은 되돌릴 수 없어(`docs/plan.md` §5-D110~) 대상 선택과 실행 확인을
 * 분리했다 — 값을 고르는 순간 바로 실행되던 이전 동작(select `onChange`)은 실수로 되돌릴
 * 수 없는 변경을 만들기 쉬웠다.
 */
export function CategoryManager({
  tree,
  offline,
  createBusy,
  createError,
  resetSeedBusy,
  resetSeedError,
  renameStatus,
  reparentStatus,
  mergeStatus,
  removeStatus,
  onCreate,
  onRename,
  onReparent,
  onMerge,
  onDelete,
  onResetSeed,
}: CategoryManagerProps) {
  const [newName, setNewName] = useState("");
  const [newParentId, setNewParentId] = useState("");
  const [addOpen, setAddOpen] = useState(false);

  // 술이 많은 주종이 위로 오도록 내림차순 정렬한다(동률은 이름순, 사용자 요청) — 여기서만
  // 적용한다. `getCategoryTree()` 자체의 이름순 정렬은 그대로 둔다(다른 화면의 `<select>`
  // 드롭다운은 타이핑 탐색에 이름순이 더 유리하다, `docs/plan.md` §5-D141).
  const roots = useMemo(
    () => tree.items.filter((item) => item.parent_id === null).sort(byProductCountThenName),
    [tree.items],
  );
  const childrenOf = useMemo(() => {
    const map = new Map<string, CategoryNode[]>();
    for (const item of tree.items) {
      if (item.parent_id === null) continue;
      const list = map.get(item.parent_id) ?? [];
      list.push(item);
      map.set(item.parent_id, list);
    }
    for (const list of map.values()) list.sort(byProductCountThenName);
    return map;
  }, [tree.items]);

  return (
    <section aria-labelledby="category-heading">
      <div className="section-header">
        <h2 id="category-heading">주종 관리</h2>
        <button
          type="button"
          className="primary"
          aria-expanded={addOpen}
          aria-controls="category-create-form"
          onClick={() => setAddOpen((value) => !value)}
        >
          {addOpen ? "닫기" : "+ 주종 추가"}
        </button>
      </div>
      <p className="muted mt-0">
        현재 최대 깊이 {tree.max_depth} / 상한 {tree.depth_limit}. 필요한 만큼 세분화할 수 있습니다.
        삭제해도 소속된 술은 지워지지 않습니다.
      </p>

      {addOpen && (
        <form
          id="category-create-form"
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
          <button type="submit" className="primary" disabled={createBusy || !newName.trim()}>
            추가
          </button>
          {createError instanceof Error && (
            <p className="alert mt-2" role="alert">
              {createError.message}
            </p>
          )}
        </form>
      )}

      <div className="button-row mt-3 mb-3">
        <button type="button" onClick={onResetSeed} disabled={resetSeedBusy || offline}>
          기본 주종 복원
        </button>
        <span className="muted text-sm self-center">
          {offline
            ? "오프라인에서는 사용할 수 없습니다."
            : "직접 만들거나 이름을 바꾼 주종은 그대로 유지됩니다."}
        </span>
      </div>
      {resetSeedError instanceof Error && (
        <p className="alert mb-3" role="alert">
          {resetSeedError.message}
        </p>
      )}

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
              offline={offline}
              renameStatus={renameStatus}
              reparentStatus={reparentStatus}
              mergeStatus={mergeStatus}
              removeStatus={removeStatus}
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
  offline: boolean;
  renameStatus: RowActionStatus;
  reparentStatus: RowActionStatus;
  mergeStatus: RowActionStatus;
  removeStatus: RowActionStatus;
  onRename: (id: string, name: string) => void;
  onReparent: (id: string, newParentId: string | null) => void;
  onMerge: (id: string, targetId: string) => void;
  onDelete: (id: string, strategy: DeleteStrategy, targetId?: string) => void;
}

function statusFor(status: RowActionStatus, id: string): RowActionStatus {
  return status.variables?.id === id ? status : IDLE_STATUS;
}

function CategoryBranch({
  node,
  childrenOf,
  allNodes,
  offline,
  renameStatus,
  reparentStatus,
  mergeStatus,
  removeStatus,
  onRename,
  onReparent,
  onMerge,
  onDelete,
}: BranchProps) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(node.name);
  const [expanded, setExpanded] = useState(true);
  const children = childrenOf.get(node.id) ?? [];

  const ownRename = statusFor(renameStatus, node.id);
  const ownReparent = statusFor(reparentStatus, node.id);
  const ownMerge = statusFor(mergeStatus, node.id);
  const ownRemove = statusFor(removeStatus, node.id);
  const rowBusy =
    ownRename.isPending || ownReparent.isPending || ownMerge.isPending || ownRemove.isPending;
  const rowError = ownRename.error ?? ownReparent.error ?? ownMerge.error ?? ownRemove.error;

  const [highlighted, setHighlighted] = useState(false);
  const highlightedForRef = useRef(false);
  useEffect(() => {
    const justMoved = ownReparent.isSuccess && !ownReparent.isPending;
    if (justMoved && !highlightedForRef.current) {
      highlightedForRef.current = true;
      setHighlighted(true);
      const timer = setTimeout(() => setHighlighted(false), 2000);
      return () => clearTimeout(timer);
    }
    if (!justMoved) highlightedForRef.current = false;
    return undefined;
  }, [ownReparent.isSuccess, ownReparent.isPending]);

  // 자기 자신과 후손은 이동·병합 대상이 될 수 없다. 순환이 생긴다.
  const descendantIds = collectDescendantIds(node.id, childrenOf);
  const moveTargets = allNodes.filter((item) => item.id !== node.id && !descendantIds.has(item.id));

  return (
    <li>
      <div className={`category-row${highlighted ? " category-row--highlight" : ""}`}>
        {children.length > 0 ? (
          <button
            type="button"
            className="sort-button tree-toggle"
            aria-expanded={expanded}
            aria-label={`${node.name} 하위 목록 ${expanded ? "접기" : "펼치기"}`}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="tree-toggle-spacer" aria-hidden="true" />
        )}

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
            <span className="button-row category-row-actions">
              <button
                type="button"
                className="primary"
                disabled={rowBusy || !draftName.trim()}
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
            </span>
          </>
        ) : (
          <>
            <span className="name">{node.name}</span>
            <span className="badge">{node.descendant_product_count}종</span>
            {node.is_seeded && <span className="muted">기본</span>}
            <span className="button-row category-row-actions">
              <button type="button" onClick={() => setEditing(true)} disabled={rowBusy}>
                이름 변경
              </button>

              <ReparentControl
                node={node}
                targets={moveTargets}
                busy={rowBusy}
                offline={offline}
                onReparent={onReparent}
              />

              <MergeControl
                node={node}
                targets={moveTargets}
                busy={rowBusy}
                offline={offline}
                onMerge={onMerge}
              />

              <DeleteControl
                node={node}
                hasChildren={children.length > 0}
                targets={moveTargets}
                busy={rowBusy}
                offline={offline}
                onDelete={onDelete}
              />
            </span>
          </>
        )}
      </div>

      {rowError instanceof Error && (
        <p className="alert row-alert" role="alert">
          {rowError.message}
        </p>
      )}

      {children.length > 0 && expanded && (
        <ul>
          {children.map((child) => (
            <CategoryBranch
              key={child.id}
              node={child}
              childrenOf={childrenOf}
              allNodes={allNodes}
              offline={offline}
              renameStatus={renameStatus}
              reparentStatus={reparentStatus}
              mergeStatus={mergeStatus}
              removeStatus={removeStatus}
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

function ReparentControl({
  node,
  targets,
  busy,
  offline,
  onReparent,
}: {
  node: CategoryNode;
  targets: CategoryNode[];
  busy: boolean;
  offline: boolean;
  onReparent: (id: string, newParentId: string | null) => void;
}) {
  const [asking, setAsking] = useState(false);
  const currentParent = node.parent_id ?? "";
  const [target, setTarget] = useState(currentParent);

  if (!asking) {
    return (
      <button
        type="button"
        disabled={busy || offline}
        onClick={() => {
          setTarget(currentParent);
          setAsking(true);
        }}
      >
        이동
      </button>
    );
  }

  return (
    <span className="button-row">
      <label className="sr-only" htmlFor={`move-target-${node.id}`}>
        {node.name} 을 옮길 상위 주종
      </label>
      <select
        id={`move-target-${node.id}`}
        value={target}
        onChange={(event) => setTarget(event.target.value)}
      >
        <option value="">최상위</option>
        {targets.map((item) => (
          <option key={item.id} value={item.id}>
            {item.path.join(" › ")}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="primary"
        disabled={busy || target === currentParent}
        onClick={() => {
          onReparent(node.id, target || null);
          setAsking(false);
        }}
      >
        이동 확인
      </button>
      <button type="button" onClick={() => setAsking(false)}>
        취소
      </button>
    </span>
  );
}

function MergeControl({
  node,
  targets,
  busy,
  offline,
  onMerge,
}: {
  node: CategoryNode;
  targets: CategoryNode[];
  busy: boolean;
  offline: boolean;
  onMerge: (id: string, targetId: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [target, setTarget] = useState("");

  if (!asking) {
    return (
      <button
        type="button"
        disabled={busy || offline || targets.length === 0}
        onClick={() => setAsking(true)}
      >
        병합
      </button>
    );
  }

  const targetNode = targets.find((item) => item.id === target);

  return (
    <span className="button-row">
      <label className="sr-only" htmlFor={`merge-target-${node.id}`}>
        {node.name} 을 합칠 주종
      </label>
      <select
        id={`merge-target-${node.id}`}
        value={target}
        onChange={(event) => setTarget(event.target.value)}
      >
        <option value="">합칠 주종 선택…</option>
        {targets.map((item) => (
          <option key={item.id} value={item.id}>
            {item.path.join(" › ")}
          </option>
        ))}
      </select>
      {targetNode && (
        <span className="muted text-sm">
          {node.name}(제품 {node.descendant_product_count}종)을 {targetNode.path.join(" › ")} 로
          합치고 삭제합니다. 되돌릴 수 없습니다.
        </span>
      )}
      <button
        type="button"
        className="danger"
        disabled={busy || !target}
        onClick={() => {
          onMerge(node.id, target);
          setAsking(false);
          setTarget("");
        }}
      >
        병합 확인
      </button>
      <button
        type="button"
        onClick={() => {
          setAsking(false);
          setTarget("");
        }}
      >
        취소
      </button>
    </span>
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
