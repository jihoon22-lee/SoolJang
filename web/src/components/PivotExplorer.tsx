/**
 * 커스텀 피벗 빌더 + 시계열 + 저장된 뷰(Task 20).
 *
 * 통계 v2 전체가 온라인 전용이다 — 피벗 집계 자체가 서버 DB 조회를 전제하고, Dexie
 * 미러(원자값만 저장)로는 재현할 수 없다(Task 16·17 의 카메라·LLM 호출과 같은 이유).
 * `StatsPage` 가 오프라인이면 이 컴포넌트 자체를 렌더링하지 않는다.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, savedViewsApi, statsApi, vendorsApi } from "@/api/client";
import type {
  CategoryNode,
  GroupDimension,
  PivotCell,
  PivotMetric,
  PivotRequest,
} from "@/api/types";
import { LineChart } from "@/components/charts/LineChart";
import { formatMoney, formatPercent, formatRating } from "@/format";

const DIMENSION_LABELS: Record<GroupDimension, string> = {
  category: "주종",
  vendor: "구매처",
  country: "국가",
  vintage_decade: "빈티지(10년대)",
};

const METRIC_LABELS: Record<PivotMetric, string> = {
  bottle_count: "병수",
  list_total: "정가 합계",
  paid_total: "실구매 합계",
  avg_price_per_100ml: "평균 100ml당 가격",
  avg_rating: "평균 평점",
  discount_rate: "평균 할인율",
  value_for_money: "가성비",
};

const DIMENSIONS = Object.keys(DIMENSION_LABELS) as GroupDimension[];
const METRICS = Object.keys(METRIC_LABELS) as PivotMetric[];

const DEFAULT_REQUEST: PivotRequest = {
  row_dimension: "vendor",
  column_dimension: "category",
  metric: "discount_rate",
};

function formatPivotValue(metric: PivotMetric, value: string | null): string {
  if (value === null) return "—";
  switch (metric) {
    case "bottle_count":
      return `${Number(value).toLocaleString("ko-KR")}병`;
    case "list_total":
    case "paid_total":
    case "avg_price_per_100ml":
      return formatMoney(value);
    case "discount_rate":
      return formatPercent(value);
    case "avg_rating":
      return formatRating(value);
    case "value_for_money":
      return Number(value).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
  }
}

function downloadCsv(filename: string, rows: string[][]): void {
  const csv = rows
    .map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(","))
    .join("\r\n");
  // Excel 이 UTF-8 을 EUC-KR 로 잘못 해석해 한글이 깨지는 걸 막는 BOM.
  const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

interface PivotExplorerProps {
  categories: CategoryNode[];
}

export function PivotExplorer({ categories }: PivotExplorerProps) {
  const queryClient = useQueryClient();
  const [request, setRequest] = useState<PivotRequest>(DEFAULT_REQUEST);
  const [cells, setCells] = useState<PivotCell[] | null>(null);
  const [viewName, setViewName] = useState("");

  const vendors = useQuery({
    queryKey: ["vendors"],
    queryFn: ({ signal }) => vendorsApi.list(signal),
  });
  const savedViews = useQuery({
    queryKey: ["saved-views"],
    queryFn: ({ signal }) => savedViewsApi.list(signal),
  });
  const timeseries = useQuery({
    queryKey: ["stats", "timeseries"],
    queryFn: ({ signal }) => statsApi.timeseries(signal),
  });

  const runPivot = useMutation({
    mutationFn: (req: PivotRequest) => statsApi.pivot(req),
    onSuccess: (result) => setCells(result),
  });

  const saveView = useMutation({
    mutationFn: () => savedViewsApi.create({ name: viewName.trim(), definition: request }),
    onSuccess: () => {
      setViewName("");
      void queryClient.invalidateQueries({ queryKey: ["saved-views"] });
    },
  });

  const removeView = useMutation({
    mutationFn: (id: string) => savedViewsApi.remove(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["saved-views"] }),
  });

  function set(patch: Partial<PivotRequest>) {
    setRequest((prev) => ({ ...prev, ...patch }));
  }

  function loadView(definition: PivotRequest) {
    setRequest(definition);
    setCells(null);
    runPivot.mutate(definition);
  }

  function exportCsv() {
    if (!cells || cells.length === 0) return;
    const hasColumns = cells.some((cell) => cell.column_label !== "");
    const header = hasColumns
      ? ["행", "열", METRIC_LABELS[request.metric], "병수"]
      : ["행", METRIC_LABELS[request.metric], "병수"];
    const rows = cells.map((cell) =>
      hasColumns
        ? [cell.row_label, cell.column_label, cell.value ?? "", String(cell.bottle_count)]
        : [cell.row_label, cell.value ?? "", String(cell.bottle_count)],
    );
    downloadCsv(`피벗_${request.row_dimension}_${request.metric}.csv`, [header, ...rows]);
  }

  const rowLabels = cells ? [...new Set(cells.map((cell) => cell.row_label))] : [];
  const columnLabels = cells ? [...new Set(cells.map((cell) => cell.column_label))] : [];
  const hasColumns = columnLabels.length > 0 && columnLabels.some((label) => label !== "");
  const cellByKey = new Map(
    cells?.map((cell) => [`${cell.row_label}\u0000${cell.column_label}`, cell]),
  );

  return (
    <section aria-labelledby="pivot-heading" className="panel">
      <h3 id="pivot-heading">커스텀 피벗</h3>

      <form
        className="field-row"
        onSubmit={(event) => {
          event.preventDefault();
          setCells(null);
          runPivot.mutate(request);
        }}
      >
        <div className="field">
          <label htmlFor="pivot-row">행 기준</label>
          <select
            id="pivot-row"
            value={request.row_dimension}
            onChange={(event) => set({ row_dimension: event.target.value as GroupDimension })}
          >
            {DIMENSIONS.map((dim) => (
              <option key={dim} value={dim}>
                {DIMENSION_LABELS[dim]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="pivot-column">열 기준 (선택)</label>
          <select
            id="pivot-column"
            value={request.column_dimension ?? ""}
            onChange={(event) =>
              set({
                column_dimension: event.target.value
                  ? (event.target.value as GroupDimension)
                  : undefined,
              })
            }
          >
            <option value="">없음</option>
            {DIMENSIONS.map((dim) => (
              <option key={dim} value={dim}>
                {DIMENSION_LABELS[dim]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="pivot-metric">지표</label>
          <select
            id="pivot-metric"
            value={request.metric}
            onChange={(event) => set({ metric: event.target.value as PivotMetric })}
          >
            {METRICS.map((metric) => (
              <option key={metric} value={metric}>
                {METRIC_LABELS[metric]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="pivot-vendor-filter">구매처 필터</label>
          <select
            id="pivot-vendor-filter"
            value={request.vendor_id ?? ""}
            onChange={(event) => set({ vendor_id: event.target.value || undefined })}
          >
            <option value="">전체</option>
            {(vendors.data ?? []).map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="pivot-category-filter">주종 필터</label>
          <select
            id="pivot-category-filter"
            value={request.category_id ?? ""}
            onChange={(event) => set({ category_id: event.target.value || undefined })}
          >
            <option value="">전체</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>

        <div className="button-row">
          <button type="submit" className="primary" disabled={runPivot.isPending}>
            {runPivot.isPending ? "계산 중…" : "실행"}
          </button>
          {cells && cells.length > 0 && (
            <button type="button" onClick={exportCsv}>
              CSV 내보내기
            </button>
          )}
        </div>
      </form>

      {runPivot.isError && (
        <p className="alert" role="alert">
          {runPivot.error instanceof ApiError
            ? runPivot.error.message
            : "피벗 계산에 실패했습니다."}
        </p>
      )}

      {cells && cells.length === 0 && <p className="muted">조건에 맞는 구매 기록이 없습니다.</p>}

      {cells && cells.length > 0 && (
        <>
          <div style={{ overflowX: "auto" }}>
            <table className="stats-table">
              <thead>
                <tr>
                  <th scope="col">{DIMENSION_LABELS[request.row_dimension]}</th>
                  {hasColumns ? (
                    columnLabels.map((label) => (
                      <th scope="col" className="numeric" key={label}>
                        {label}
                      </th>
                    ))
                  ) : (
                    <th scope="col" className="numeric">
                      {METRIC_LABELS[request.metric]}
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rowLabels.map((rowLabel) => (
                  <tr key={rowLabel}>
                    <th scope="row">{rowLabel}</th>
                    {hasColumns ? (
                      columnLabels.map((columnLabel) => {
                        const cell = cellByKey.get(`${rowLabel}\u0000${columnLabel}`);
                        return (
                          <td className="numeric" key={columnLabel}>
                            {cell ? formatPivotValue(request.metric, cell.value) : "—"}
                          </td>
                        );
                      })
                    ) : (
                      <td className="numeric">
                        {formatPivotValue(
                          request.metric,
                          cellByKey.get(`${rowLabel}\u0000`)?.value ?? null,
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <form
            className="button-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (viewName.trim()) saveView.mutate();
            }}
          >
            <input
              aria-label="저장할 뷰 이름"
              placeholder="이 뷰의 이름"
              value={viewName}
              onChange={(event) => setViewName(event.target.value)}
            />
            <button type="submit" disabled={saveView.isPending || !viewName.trim()}>
              {saveView.isPending ? "저장 중…" : "이 뷰 저장"}
            </button>
          </form>
        </>
      )}

      {savedViews.data && savedViews.data.length > 0 && (
        <div className="field">
          <h4>저장된 뷰</h4>
          <ul className="quality-record-list saved-view-list">
            {savedViews.data.map((view) => (
              <li className="stats-card" key={view.id}>
                <span>{view.name}</span>
                <div className="button-row">
                  <button type="button" onClick={() => loadView(view.definition)}>
                    불러오기
                  </button>
                  <button
                    type="button"
                    onClick={() => removeView.mutate(view.id)}
                    disabled={removeView.isPending}
                  >
                    삭제
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3>월별 지출·구매 병수</h3>
      {timeseries.data && timeseries.data.length === 0 && (
        <p className="muted">구매일이 기록된 구매 건이 없습니다.</p>
      )}
      {timeseries.data && timeseries.data.length > 0 && (
        <>
          <LineChart
            title="월별 구매 병수"
            data={timeseries.data.map((point) => ({
              label: point.month,
              value: point.bottle_count,
            }))}
            formatValue={(value) => `${value.toLocaleString("ko-KR")}병`}
          />
          <table className="stats-table">
            <caption className="sr-only">
              월별 지출·구매 병수 표. 위 그래프와 같은 데이터입니다.
            </caption>
            <thead>
              <tr>
                <th scope="col">월</th>
                <th scope="col" className="numeric">
                  구매 병수
                </th>
                <th scope="col" className="numeric">
                  실구매 지출
                </th>
              </tr>
            </thead>
            <tbody>
              {timeseries.data.map((point) => (
                <tr key={point.month}>
                  <th scope="row">{point.month}</th>
                  <td className="numeric">{point.bottle_count.toLocaleString("ko-KR")}</td>
                  <td className="numeric">{formatMoney(point.paid_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
