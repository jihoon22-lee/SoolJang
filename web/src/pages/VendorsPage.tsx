import { useMutation } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";
import { type FormEvent, useMemo, useState } from "react";

import { vendorsApi } from "@/api/client";
import type { Vendor, VendorKind } from "@/api/types";
import { AutocompleteInput } from "@/components/AutocompleteInput";
import { formatMoney, formatVendorKind } from "@/format";
import { matchesQuery, rankByQuery } from "@/search";
import { db } from "@/sync/db";
import { enqueue } from "@/sync/outbox";
import { getVendors } from "@/sync/queries";
import { useSyncStatus } from "@/sync/SyncStatusProvider";

//: `ProductDetail.tsx` 의 구매처 이름 자동완성과 같은 개수 제한이다.
const MAX_SUGGESTIONS = 8;

const VENDOR_KINDS: VendorKind[] = [
  "mart",
  "online",
  "duty_free",
  "bottle_shop",
  "bar",
  "brewery",
  "event",
  "gift",
  "other",
];

/**
 * 구매처 관리 화면.
 *
 * 레거시 임포트가 이름 규칙으로 종류를 **추측**해 채워 넣었다(`guess_vendor_kind`) — 실데이터
 * 64곳 중 틀린 값이 남아 있을 수 있어 고칠 수단이 필요하다. 통합(merge)은 백엔드에 그 API가
 * 없어 이번 범위 밖이다(`docs/plan.md` 백로그).
 *
 * 이름·종류 수정은 `CategoriesPage::rename` 과 같은 패턴(오프라인 낙관적 갱신)이다 — 필드만
 * 바꾸는 단순 갱신이라 온라인 전용으로 둘 이유가 없다.
 *
 * 구매처가 많아지면(실데이터 64곳) 목록 스크롤이 길어져 검색창을 뒀다(사용자 요청, 항목 4).
 * `ProductDetail.tsx` 의 구매처 이름 자동완성과 같은 조합(`AutocompleteInput` +
 * `search.ts::rankByQuery`)을 재사용해 타이핑 중 순위 매긴 후보를 보여주고, 동시에
 * `matchesQuery`(초성 검색 포함)로 아래 목록 자체도 실시간으로 좁힌다.
 */
export function VendorsPage({ onSelectVendor }: { onSelectVendor: (vendorId: string) => void }) {
  const { state, triggerSync } = useSyncStatus();
  const offline = state === "offline";
  const vendors = useLiveQuery(() => getVendors(), []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<VendorKind>("other");
  const [vendorQuery, setVendorQuery] = useState("");
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState("");

  const update = useMutation({
    mutationFn: async (input: { id: string; name: string; kind: VendorKind }) => {
      const current = await db.vendor.get(input.id);
      if (!current) throw new Error("구매처를 찾을 수 없습니다");
      const now = new Date().toISOString();
      await enqueue({
        entity: "vendor",
        op: "update",
        entityId: input.id,
        baseUpdatedAt: current.updated_at,
        fields: { name: input.name, kind: input.kind },
        optimisticRow: { ...current, name: input.name, kind: input.kind, updated_at: now },
      });
    },
    onSuccess: () => setEditingId(null),
  });

  function startEdit(vendor: Vendor): void {
    setEditingId(vendor.id);
    setName(vendor.name);
    setKind(vendor.kind);
    update.reset();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!editingId || !name.trim()) return;
    update.mutate({ id: editingId, name: name.trim(), kind });
  }

  // 구매처 병합은 온라인 전용이다(재배치 + soft delete 전파 — 주종 이동·병합과 같은 판단).
  const merge = useMutation({
    mutationFn: async (input: { sourceId: string; targetId: string }) => {
      await vendorsApi.merge(input.sourceId, input.targetId);
    },
    onSuccess: () => {
      setMergingId(null);
      setMergeTargetId("");
      triggerSync();
    },
  });

  function startMerge(vendor: Vendor): void {
    setMergingId(vendor.id);
    setMergeTargetId("");
    merge.reset();
  }

  // 로딩 중(`vendors === undefined`)에도 훅 호출 순서가 매번 같아야 하므로, 아래 조건부
  // 반환보다 앞에서 빈 배열로라도 계산해 둔다. `vendors ?? []` 를 `useMemo` 안이 아니라
  // 바로 여기서 매핑하면 매 렌더마다 새 배열이 생겨 의존성이 항상 바뀌어 메모가 무효화된다
  // — `vendors` 자체를 의존성으로 둬야 실제로 재사용된다.
  const vendorNames = useMemo(() => (vendors ?? []).map((vendor) => vendor.name), [vendors]);
  const suggestions = useMemo(
    () => rankByQuery(vendorNames, vendorQuery, (name) => name).slice(0, MAX_SUGGESTIONS),
    [vendorNames, vendorQuery],
  );

  if (vendors === undefined) {
    return <output aria-live="polite">구매처를 불러오고 있습니다…</output>;
  }

  const sorted = [...vendors].sort((a, b) => a.name.localeCompare(b.name));
  const visible = vendorQuery.trim()
    ? sorted.filter((vendor) => matchesQuery(vendor.name, vendorQuery))
    : sorted;

  return (
    <section aria-labelledby="vendors-heading" className="panel">
      <h2 id="vendors-heading">구매처 관리</h2>

      {sorted.length > 0 && (
        <div className="field">
          <label htmlFor="vendor-search">검색</label>
          <AutocompleteInput
            id="vendor-search"
            value={vendorQuery}
            placeholder="구매처 이름으로 검색"
            onChange={setVendorQuery}
            suggestions={suggestions}
          />
        </div>
      )}

      {sorted.length === 0 ? (
        <output className="notice">등록된 구매처가 없습니다.</output>
      ) : visible.length === 0 ? (
        <output className="notice">검색 결과가 없습니다.</output>
      ) : (
        <ul className="vendor-list">
          {visible.map((vendor) =>
            editingId === vendor.id ? (
              <li className="vendor-row" key={vendor.id}>
                <form onSubmit={handleSubmit} className="vendor-edit-form">
                  <label htmlFor={`vendor-name-${vendor.id}`}>
                    이름
                    <input
                      id={`vendor-name-${vendor.id}`}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      required
                    />
                  </label>
                  <label htmlFor={`vendor-kind-${vendor.id}`}>
                    종류
                    <select
                      id={`vendor-kind-${vendor.id}`}
                      value={kind}
                      onChange={(event) => setKind(event.target.value as VendorKind)}
                    >
                      {VENDOR_KINDS.map((value) => (
                        <option key={value} value={value}>
                          {formatVendorKind(value)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {update.error ? (
                    <p className="field-error" role="alert">
                      {update.error instanceof Error ? update.error.message : "수정할 수 없습니다"}
                    </p>
                  ) : null}
                  <div className="button-row">
                    <button type="submit" className="primary" disabled={update.isPending}>
                      {update.isPending ? "저장 중…" : "저장"}
                    </button>
                    <button type="button" onClick={() => setEditingId(null)}>
                      취소
                    </button>
                  </div>
                </form>
              </li>
            ) : mergingId === vendor.id ? (
              <li className="vendor-row" key={vendor.id}>
                <div className="vendor-merge-form">
                  <label htmlFor={`vendor-merge-target-${vendor.id}`}>
                    "{vendor.name}" 병합 대상
                  </label>
                  <select
                    id={`vendor-merge-target-${vendor.id}`}
                    value={mergeTargetId}
                    onChange={(event) => setMergeTargetId(event.target.value)}
                  >
                    <option value="">병합할 구매처를 선택하세요</option>
                    {sorted
                      .filter((target) => target.id !== vendor.id)
                      .map((target) => (
                        <option key={target.id} value={target.id}>
                          {target.name}
                        </option>
                      ))}
                  </select>
                  {merge.error ? (
                    <p className="field-error" role="alert">
                      {merge.error instanceof Error ? merge.error.message : "병합할 수 없습니다"}
                    </p>
                  ) : null}
                  <div className="button-row">
                    <button
                      type="button"
                      className="primary"
                      disabled={!mergeTargetId || merge.isPending}
                      onClick={() => merge.mutate({ sourceId: vendor.id, targetId: mergeTargetId })}
                    >
                      {merge.isPending ? "병합 중…" : "병합 확인"}
                    </button>
                    <button type="button" onClick={() => setMergingId(null)}>
                      취소
                    </button>
                  </div>
                </div>
              </li>
            ) : (
              <li className="vendor-row" key={vendor.id}>
                <button
                  type="button"
                  className="link-like"
                  onClick={() => onSelectVendor(vendor.id)}
                >
                  {vendor.name}
                </button>
                <span className="muted">{formatVendorKind(vendor.kind)}</span>
                <span className="muted">
                  구매 {vendor.purchase_count.toLocaleString("ko-KR")}건
                </span>
                <span className="muted">{formatMoney(vendor.total_spend)}</span>
                <button type="button" onClick={() => startEdit(vendor)}>
                  수정
                </button>
                <button type="button" onClick={() => startMerge(vendor)} disabled={offline}>
                  병합
                </button>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}
