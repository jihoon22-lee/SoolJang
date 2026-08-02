import { useMutation } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";
import { type FormEvent, useState } from "react";

import type { Vendor, VendorKind } from "@/api/types";
import { formatVendorKind } from "@/format";
import { db } from "@/sync/db";
import { enqueue } from "@/sync/outbox";
import { getVendors } from "@/sync/queries";

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
 */
export function VendorsPage() {
  const vendors = useLiveQuery(() => getVendors(), []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<VendorKind>("other");

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

  if (vendors === undefined) {
    return <output aria-live="polite">구매처를 불러오고 있습니다…</output>;
  }

  const sorted = [...vendors].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <section aria-labelledby="vendors-heading" className="panel">
      <h2 id="vendors-heading">구매처 관리</h2>

      {sorted.length === 0 ? (
        <output className="notice">등록된 구매처가 없습니다.</output>
      ) : (
        <ul className="vendor-list">
          {sorted.map((vendor) =>
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
            ) : (
              <li className="vendor-row" key={vendor.id}>
                <span className="name">{vendor.name}</span>
                <span className="muted">{formatVendorKind(vendor.kind)}</span>
                <span className="muted">
                  구매 {vendor.purchase_count.toLocaleString("ko-KR")}건
                </span>
                <button type="button" onClick={() => startEdit(vendor)}>
                  수정
                </button>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}
