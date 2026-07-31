import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { importsApi } from "@/api/client";
import type { ImportAnalysis, ImportCommitResult } from "@/api/types";
import { formatMoney, formatVolume } from "@/format";

/**
 * 레거시 시트 임포트.
 *
 * 반드시 **분석 → 확인 → 적재** 순서로 진행한다. 미리보기 없이 바로 넣으면 잘못된 매핑을
 * 되돌리기 어렵다. 재실행해도 중복이 생기지 않으므로 실수로 두 번 눌러도 안전하다.
 */
export function ImportPage() {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [result, setResult] = useState<ImportCommitResult | null>(null);

  const analyze = useMutation({
    mutationFn: (target: File) => importsApi.analyze(target),
    onSuccess: (data) => {
      setAnalysis(data);
      setResult(null);
    },
  });

  const commit = useMutation({
    mutationFn: (target: File) => importsApi.commit(target),
    onSuccess: (data) => {
      setResult(data);
      void queryClient.invalidateQueries({ queryKey: ["products"] });
      void queryClient.invalidateQueries({ queryKey: ["categories"] });
    },
  });

  const busy = analyze.isPending || commit.isPending;
  const error = analyze.error ?? commit.error;

  return (
    <section aria-labelledby="import-heading">
      <h2 id="import-heading">엑셀 기록 가져오기</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        엑셀에서 CSV 로 저장한 파일을 올리면 내용을 먼저 분석해 보여줍니다. 확인한 뒤에 적재하세요.
        같은 파일을 두 번 넣어도 중복이 생기지 않습니다.
      </p>

      {error instanceof Error && (
        <p className="alert" role="alert">
          {error.message}
        </p>
      )}

      <div className="panel">
        <div className="field">
          <label htmlFor="import-file">CSV 파일</label>
          <input
            id="import-file"
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setAnalysis(null);
              setResult(null);
            }}
          />
        </div>
        <div className="button-row">
          <button
            type="button"
            className="primary"
            disabled={busy || file === null}
            onClick={() => file && analyze.mutate(file)}
          >
            {analyze.isPending ? "분석 중…" : "분석 (미리보기)"}
          </button>
          <button
            type="button"
            disabled={busy || file === null || analysis === null}
            onClick={() => file && commit.mutate(file)}
          >
            {commit.isPending ? "적재 중…" : "적재 실행"}
          </button>
        </div>
      </div>

      {analysis && <AnalysisView analysis={analysis} />}
      {result && <ResultView result={result} />}
    </section>
  );
}

function AnalysisView({ analysis }: { analysis: ImportAnalysis }) {
  const { block, totals, review, sample } = analysis;

  return (
    <>
      <h3>블록 분리 결과</h3>
      <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
        한 시트에 술 목록과 통계 표가 섞여 있어 통계 부분은 제외합니다.
      </p>
      <dl className="metrics-grid">
        <Metric label="본 데이터 행" value={`${block.record_count}행`} />
        <Metric
          label="통과한 빈 행"
          value={block.skipped_blank_lines.join(", ") || "없음"}
          hint="데이터 종료가 아님"
        />
        <Metric label="배제한 합계행" value={block.total_row_lines.join(", ") || "없음"} />
        <Metric label="배제한 행" value={`${block.excluded_line_count}행`} hint="통계 블록" />
      </dl>

      <h3>적재될 내용</h3>
      <dl className="metrics-grid">
        <Metric label="제품" value={`${totals.products}종`} hint={`원본 ${totals.source_rows}행`} />
        <Metric label="규격" value={`${totals.skus}개`} />
        <Metric label="구매 건" value={`${totals.purchases}건`} />
        <Metric label="병" value={`${totals.bottles}병`} />
        <Metric label="주종" value={`${totals.categories}종`} />
        <Metric label="구매처" value={`${totals.vendors}곳`} />
        <Metric label="정가 총액" value={formatMoney(totals.list_amount)} />
        <Metric label="실구매 총액" value={formatMoney(totals.paid_amount)} />
        <Metric label="총 용량" value={formatVolume(totals.volume_ml)} />
      </dl>

      <h3>확인이 필요한 항목</h3>
      <ul>
        {review.merge_group_count > 0 && (
          <li>
            같은 술로 판정되어 합쳐질 행 묶음 <strong>{review.merge_group_count}건</strong>. 이름·
            빈티지·도수가 같으면 한 제품으로 봅니다
          </li>
        )}
        {review.split_vendor_rows.length > 0 && (
          <li>
            구매처를 여러 건으로 나눈 행 <strong>{review.split_vendor_rows.length}행</strong>
          </li>
        )}
        {review.unsplit_vendor_rows.length > 0 && (
          <li>
            구매처가 여러 곳이지만 병수를 나눌 수 없어 하나로 넣을 행{" "}
            <strong>{review.unsplit_vendor_rows.length}행</strong>. 원문을 보존하므로 나중에 구매
            건을 쪼갤 수 있습니다
          </li>
        )}
        {review.warning_summary.map(([kind, count]) => (
          <li key={kind}>
            {kind} <strong>{count}건</strong>
          </li>
        ))}
        {review.merge_group_count === 0 &&
          review.unsplit_vendor_rows.length === 0 &&
          review.warning_summary.length === 0 && <li>확인이 필요한 항목이 없습니다</li>}
      </ul>

      <h3>정규화 표본</h3>
      <table className="product-table" style={{ display: "table" }}>
        <caption className="sr-only">정규화 결과 표본</caption>
        <thead>
          <tr>
            <th scope="col">행</th>
            <th scope="col">이름</th>
            <th scope="col">주종</th>
            <th scope="col" className="numeric">
              빈티지
            </th>
            <th scope="col" className="numeric">
              용량
            </th>
            <th scope="col" className="numeric">
              병당 정가
            </th>
            <th scope="col" className="numeric">
              병수
            </th>
          </tr>
        </thead>
        <tbody>
          {sample.map((row) => (
            <tr key={row.line_number}>
              <td>{row.line_number}</td>
              <td>{row.name}</td>
              <td>{row.category_path.join(" › ") || "미분류"}</td>
              <td className="numeric">{row.vintage ?? "—"}</td>
              <td className="numeric">{formatVolume(row.volume_ml)}</td>
              <td className="numeric">{formatMoney(row.unit_list_price, { short: true })}</td>
              <td className="numeric">{row.quantity}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function ResultView({ result }: { result: ImportCommitResult }) {
  return (
    <>
      <h3>적재 완료</h3>
      <output aria-live="polite" className="notice">
        제품 {result.products_created}종 생성, {result.products_reused}종 재사용. 구매 건{" "}
        {result.purchases_created}건, 병 {result.bottles_created}병.
        {result.purchases_skipped > 0 &&
          ` 이미 있던 구매 건 ${result.purchases_skipped}건은 건너뛰었습니다.`}
      </output>
      {result.failed_rows.length > 0 && (
        <>
          <h4>실패한 행 {result.failed_rows.length}건</h4>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            나머지 행은 정상 적재되었습니다. 아래 행만 확인하세요.
          </p>
          <ul>
            {result.failed_rows.slice(0, 20).map(([line, message]) => (
              <li key={line}>
                <strong>{line}행</strong> {message.slice(0, 200)}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="metric">
      <dt>
        {label}
        {hint && <span className="muted"> ({hint})</span>}
      </dt>
      <dd>{value}</dd>
    </div>
  );
}
