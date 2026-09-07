import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { categoriesApi, vendorsApi } from "@/api/client";
import { type CleanupPreview, collectionApi } from "@/api/collection";
import { CleanupConfirmation } from "@/components/CleanupConfirmation";
import { formatMoney } from "@/format";
import { useSyncStatus } from "@/sync/SyncStatusProvider";

const REASONS: Record<string, string> = {
  name: "이름 미상",
  category: "주종 미지정",
  vendor: "구매처 미지정",
  volume: "용량 미상",
  price: "가격 미상",
};
export function CollectionQualityPage({
  onSelectProduct,
}: {
  onSelectProduct: (id: string) => void;
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
  const [kind, setKind] = useState("product_category");
  const [selected, setSelected] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const action = useMutation({
    mutationFn: async () => {
      if (preview) {
        await collectionApi.confirm(preview.id);
        setPreview(null);
        setSelected([]);
        triggerSync();
        await cache.invalidateQueries({ queryKey: ["collection"] });
      } else setPreview(await collectionApi.preview(kind, selected, target || null));
    },
  });
  const candidates = (report.data?.items ?? []).filter((item) =>
    kind === "product_category" ? item.kind === "product" : item.kind === "purchase",
  );
  const unique = candidates.filter(
    (item, index) => candidates.findIndex((other) => other.id === item.id) === index,
  );
  return (
    <section className="collection-page">
      <h1>데이터 품질</h1>
      <p>
        누락과 중복 후보를 확인하고 필요한 기록만 정리하세요. 정리 작업은 온라인에서 사용할 수
        있습니다.
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
              구매 {report.data.coverage.purchases}건 · 지출 합계{" "}
              {formatMoney(report.data.coverage.known_paid_total)}
            </p>
            <p>
              용량 미상 {report.data.coverage.unknown_volume_skus}/{report.data.coverage.skus}규격 ·
              보관 위치 미지정 재고 {report.data.coverage.unassigned_stock_bottles}병
            </p>
          </section>
          <h2>누락 항목</h2>
          {report.data.items.length === 0 && <p>확인된 누락이 없습니다.</p>}
          <ul>
            {report.data.items.map((item) => (
              <li key={`${item.id}:${item.reason}`}>
                {REASONS[item.reason]} · {item.name ?? "구매·규격 기록"}{" "}
                {item.product_id && (
                  <button
                    type="button"
                    onClick={() => item.product_id && onSelectProduct(item.product_id)}
                  >
                    해당 제품 확인
                  </button>
                )}
              </li>
            ))}
          </ul>
          <h2>중복 후보</h2>
          <p>
            이름이 비슷해도 제품·규격을 자동 병합하지 않습니다. 구매처의 지점과 판매 조건을
            확인하세요.
          </p>
          <ul>
            {report.data.duplicate_candidates.map((group) => (
              <li key={group.items[0]?.id}>{group.items.map((item) => item.name).join(" / ")}</li>
            ))}
          </ul>
          <h2>선택 항목 일괄 변경</h2>
          <label>
            변경 항목
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value);
                setSelected([]);
                setPreview(null);
                setTarget("");
              }}
            >
              <option value="product_category">제품 주종</option>
              <option value="purchase_vendor">구매처</option>
            </select>
          </label>
          <fieldset disabled={!online || pendingCount > 0 || !!preview}>
            <legend>대상 기록 선택</legend>
            {unique.map((item) => (
              <label key={item.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(item.id)}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selected, item.id]
                        : selected.filter((id) => id !== item.id),
                    )
                  }
                />
                {item.name ?? item.id}
              </label>
            ))}
            <label>
              변경할 값
              <select value={target} onChange={(event) => setTarget(event.target.value)}>
                <option value="">미지정</option>
                {(kind === "product_category"
                  ? (categories.data?.items ?? [])
                  : (vendors.data ?? [])
                ).map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
          {!preview && (
            <button
              type="button"
              disabled={!online || pendingCount > 0 || !selected.length || action.isPending}
              onClick={() => action.mutate()}
            >
              영향 미리보기 ({selected.length}건)
            </button>
          )}
          {preview && (
            <CleanupConfirmation
              preview={preview}
              pending={action.isPending || !online}
              onConfirm={() => action.mutate()}
              onCancel={() => setPreview(null)}
            />
          )}
        </>
      )}
      {action.error && <p role="alert">{action.error.message}</p>}
    </section>
  );
}
