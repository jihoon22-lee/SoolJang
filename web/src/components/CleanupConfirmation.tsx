import type { CleanupPreview } from "@/api/collection";
import { formatMoney } from "@/format";

export function CleanupConfirmation({
  preview,
  pending,
  onConfirm,
  onCancel,
}: {
  preview: CleanupPreview;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const facts = preview.snapshot;
  return (
    <section className="card" aria-label="정리 미리보기">
      <h3>정리 미리보기</h3>
      <p>
        {facts.rows.map((row) => row.name ?? row.id).join(", ")} → {facts.target?.name ?? "미지정"}
      </p>
      <p>
        변경 대상 {facts.affected_count}건 · 구매 병수 {facts.bottle_count}병 · 확인된 구매 합계{" "}
        {formatMoney(facts.known_paid_total)}
      </p>
      <p>전체 변경을 한 번에 저장합니다. 그동안 기록이 바뀌면 미리보기를 다시 확인해야 합니다.</p>
      <div className="button-row">
        <button type="button" className="primary" disabled={pending} onClick={onConfirm}>
          확인하고 정리
        </button>
        <button type="button" disabled={pending} onClick={onCancel}>
          취소
        </button>
      </div>
    </section>
  );
}
