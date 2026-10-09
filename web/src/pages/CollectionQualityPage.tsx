import type { ProductContext } from "@/router";
/**
 * 데이터 품질 — 누락·중복을 찾아 필요한 것만 한 번에 정리한다.
 *
 * 누락 목록과 "일괄 변경 대상" 목록을 따로 두면 같은 항목을 두 번 찾아야 했다. 이제 사유별
 * 목록에서 바로 골라 하단 막대로 바꾼다. 정리는 서버의 미리보기 → 확인 두 단계로 원자적으로
 * 적용하며(미리보기 이후 바뀐 기록이 있으면 거부), 비슷한 이름의 제품은 자동 병합하지 않는다.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { categoriesApi, vendorsApi } from "@/api/client";
import { type CleanupPreview, collectionApi, type QualityReport } from "@/api/collection";
import { CleanupConfirmation } from "@/components/CleanupConfirmation";
import { formatMoney } from "@/format";
import { useSyncStatus } from "@/sync/SyncStatusProvider";

type Item = QualityReport["items"][number];
type FixKind = "product_category" | "purchase_vendor";

const SECTIONS: { reason: string; title: string; fix?: FixKind; hint: string }[] = [
  {
    reason: "category",
    title: "주종 미지정 제품",
    fix: "product_category",
    hint: "골라서 한 번에 주종을 정할 수 있습니다.",
  },
  {
    reason: "vendor",
    title: "구매처 미지정 구매",
    fix: "purchase_vendor",
    hint: "골라서 한 번에 구매처를 정할 수 있습니다.",
  },
  { reason: "volume", title: "용량(규격) 미등록", hint: "제품 상세에서 규격을 추가하세요." },
  { reason: "name", title: "이름 미상", hint: "제품 상세에서 이름을 고치세요." },
];

export function CollectionQualityPage({
  onSelectProduct,
}: {
  onSelectProduct: (id: string, context?: ProductContext) => void;
}) {
  const { state, pendingCount, triggerSync } = useSyncStatus();
  const online = state !== "offline";
  const cache = useQueryClient();
  const report = useQuery({
    queryKey: ["collection", "quality"],
    queryFn: collectionApi.quality,
    enabled: online,
  });
  const categories = useQuery({
    queryKey: ["collection", "categories"],
    queryFn: () => categoriesApi.tree(),
    enabled: online,
  });
  const vendors = useQuery({
    queryKey: ["collection", "vendors"],
    queryFn: () => vendorsApi.list(),
    enabled: online,
  });
  const [kind, setKind] = useState<FixKind | "vendor_merge" | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const blocked = !online || pendingCount > 0;

  const action = useMutation({
    mutationFn: async (input?: {
      kind: FixKind | "vendor_merge";
      ids: string[];
      target: string;
    }) => {
      if (preview) {
        await collectionApi.confirm(preview.id);
        setPreview(null);
        setSelected([]);
        setKind(null);
        triggerSync();
        await cache.invalidateQueries({ queryKey: ["collection"] });
        return;
      }
      const request = input ?? { kind: kind ?? "product_category", ids: selected, target };
      setPreview(await collectionApi.preview(request.kind, request.ids, request.target || null));
    },
  });

  function toggle(item: Item, fix: FixKind): void {
    if (preview) return;
    // 한 번에 한 종류만 고친다 — 다른 사유 목록에서 고르면 이전 선택을 비운다.
    if (kind !== fix) {
      setKind(fix);
      setTarget("");
      setSelected([item.id]);
      return;
    }
    setSelected((current) =>
      current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id],
    );
  }

  const items = report.data?.items ?? [];
  const byReason = (reason: string) =>
    items.filter(
      (item, index) =>
        item.reason === reason &&
        items.findIndex((other) => other.id === item.id && other.reason === reason) === index,
    );
  const targets =
    kind === "product_category"
      ? (categories.data?.items ?? []).map((item) => ({ id: item.id, name: item.path.join(" > ") }))
      : (vendors.data ?? []).map((item) => ({ id: item.id, name: item.name }));

  return (
    <section className="collection-page">
      <h1>데이터 품질</h1>
      <p className="muted">
        누락과 중복 후보를 확인하고 필요한 기록만 정리하세요. 정리는 영향 미리보기를 거쳐 한 번에
        적용되며 온라인에서만 할 수 있습니다.
      </p>
      {!online && <output>오프라인입니다. 연결한 뒤 최신 기록을 확인하세요.</output>}
      {pendingCount > 0 && (
        <output>동기화 대기 {pendingCount}건이 있습니다. 정리 전에 동기화를 완료하세요.</output>
      )}
      {report.error && <p role="alert">{report.error.message}</p>}
      {report.data && (
        <>
          <section className="card">
            <h2>통계 포함 근거</h2>
            <p>{report.data.rules}</p>
            <p>
              구매 {report.data.coverage.purchases}건
              {report.data.coverage.zero_paid_purchases !== undefined
                ? ` (0원 ${report.data.coverage.zero_paid_purchases}건 포함)`
                : ""}{" "}
              · 지출 합계 {formatMoney(report.data.coverage.known_paid_total)} · 보관 위치 미지정
              재고 {report.data.coverage.unassigned_stock_bottles}병
            </p>
          </section>

          {items.length === 0 && <p>확인된 누락이 없습니다.</p>}
          {SECTIONS.map((section) => {
            const rows = byReason(section.reason);
            if (rows.length === 0) return null;
            const fix = section.fix;
            return (
              <section key={section.reason} aria-labelledby={`quality-${section.reason}`}>
                <h2 id={`quality-${section.reason}`}>
                  {section.title} <span className="muted">{rows.length}</span>
                </h2>
                <p className="muted text-sm">{section.hint}</p>
                {fix ? (
                  <button
                    type="button"
                    className="sort-button"
                    disabled={blocked || !!preview}
                    onClick={() => {
                      setKind(fix);
                      setTarget("");
                      setSelected(rows.map((row) => row.id));
                    }}
                  >
                    {rows.length}건 모두 선택
                  </button>
                ) : null}
                <ul className="check-list">
                  {rows.map((item) => (
                    <li key={`${item.id}:${item.reason}`}>
                      {fix ? (
                        <label>
                          <input
                            type="checkbox"
                            disabled={blocked || !!preview}
                            checked={kind === fix && selected.includes(item.id)}
                            onChange={() => toggle(item, fix)}
                          />
                          {item.label ?? item.name ?? "기록"}
                        </label>
                      ) : (
                        <span>{item.label ?? item.name ?? "기록"}</span>
                      )}{" "}
                      {item.product_id && (
                        <button
                          type="button"
                          className="sort-button"
                          onClick={() => item.product_id && onSelectProduct(item.product_id)}
                        >
                          제품 보기
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}

          <h2>중복 후보</h2>
          <p className="muted text-sm">
            이름이 비슷해도 제품·규격은 자동 병합하지 않습니다. 구매처는 같은 곳이 확실할 때
            한쪽으로 합칠 수 있습니다(구매 기록은 남은 쪽으로 옮겨집니다).
          </p>
          {report.data.duplicate_candidates.length === 0 ? (
            <p>중복 후보가 없습니다.</p>
          ) : (
            <ul className="duplicate-list">
              {report.data.duplicate_candidates.map((group) => (
                <li key={group.items[0]?.id}>
                  <span className="muted text-sm">
                    {group.kind === "vendor" ? "구매처" : "제품"}
                  </span>{" "}
                  {group.items.map((item) => item.name).join(" / ")}
                  {group.kind === "vendor" && group.items.length >= 2 ? (
                    <div className="button-row">
                      {group.items.map((keep) => (
                        <button
                          key={keep.id}
                          type="button"
                          disabled={blocked || !!preview || action.isPending}
                          onClick={() => {
                            const source = group.items.find((item) => item.id !== keep.id);
                            if (!source) return;
                            setKind("vendor_merge");
                            action.mutate({
                              kind: "vendor_merge",
                              ids: [source.id],
                              target: keep.id,
                            });
                          }}
                        >
                          "{keep.name}"(으)로 합치기
                          {group.items.length > 2 ? " (하나씩)" : ""}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {group.kind === "product" ? (
                    <div className="button-row">
                      {group.items.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className="sort-button"
                          onClick={() => onSelectProduct(item.id)}
                        >
                          {item.name} 보기
                        </button>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {kind && kind !== "vendor_merge" && selected.length > 0 && !preview ? (
            <div className="bulk-bar" role="toolbar" aria-label="선택한 기록 고치기">
              <span className="bulk-bar-count">{selected.length}건</span>
              <label htmlFor="quality-target" className="sr-only">
                {kind === "product_category" ? "정할 주종" : "정할 구매처"}
              </label>
              <select
                id="quality-target"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              >
                <option value="">
                  {kind === "product_category" ? "주종 선택" : "구매처 선택"}
                </option>
                {targets.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="primary"
                disabled={blocked || !target || action.isPending}
                onClick={() => action.mutate(undefined)}
              >
                영향 미리보기
              </button>
              <button type="button" onClick={() => setSelected([])}>
                선택 해제
              </button>
            </div>
          ) : null}
          {preview && (
            <CleanupConfirmation
              preview={preview}
              pending={action.isPending || !online}
              onConfirm={() => action.mutate(undefined)}
              onCancel={() => {
                setPreview(null);
                if (kind === "vendor_merge") setKind(null);
              }}
            />
          )}
        </>
      )}
      {action.error && <p role="alert">{action.error.message}</p>}
    </section>
  );
}
