/**
 * 수평 막대 차트.
 *
 * 범주 이름이 긴 한글일 수 있어("싱글몰트 위스키", "라빈리쿼 스타필드 수원점") 라벨은
 * 일반 HTML 텍스트로 렌더링하고(줄바꿈·말줄임을 CSS 가 맡는다), 막대 자체만 SVG `<rect>`
 * 로 그린다 — SVG `<text>` 는 폰트 지표를 몰라 줄바꿈·말줄임을 예측할 수 없다.
 *
 * 시각 장애 사용자를 위해 컨테이너에 `role="img"` + `aria-label` 을 붙이고, 막대 자체가
 * 전달하는 값은 화면에 보이지 않는 `<table>` 로 그대로 남긴다(스크린리더가 표를 순회하며
 * 각 항목·값을 읽을 수 있다).
 */

import { colorFor } from "@/components/charts/palette";

export interface BarChartDatum {
  label: string;
  value: number;
  /** 지정하지 않으면 팔레트에서 순서대로 고른다. */
  color?: string | undefined;
  onSelect?: (() => void) | undefined;
}

interface BarChartProps {
  /** `role="img"` 의 접근성 이름이자 표 대체 텍스트의 캡션. */
  title: string;
  data: BarChartDatum[];
  formatValue?: ((value: number) => string) | undefined;
  emptyMessage?: string;
}

export function BarChart({
  title,
  data,
  formatValue = (value) => value.toLocaleString("ko-KR"),
  emptyMessage = "데이터가 없습니다.",
}: BarChartProps) {
  if (data.length === 0) {
    return <p className="muted">{emptyMessage}</p>;
  }

  const max = Math.max(1, ...data.map((datum) => Math.abs(datum.value)));

  return (
    <div className="bar-chart" role="img" aria-label={title}>
      <ul className="bar-chart-rows">
        {data.map((datum, index) => {
          const pct = (Math.abs(datum.value) / max) * 100;
          const color = datum.color ?? colorFor(index);
          return (
            <li className="bar-chart-row" key={datum.label}>
              {datum.onSelect ? (
                <button
                  type="button"
                  className="sort-button bar-chart-label"
                  onClick={datum.onSelect}
                >
                  {datum.label}
                </button>
              ) : (
                <span className="bar-chart-label">{datum.label}</span>
              )}
              <svg
                className="bar-chart-track"
                viewBox="0 0 100 10"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <rect x="0" y="0" width={pct} height="10" rx="2" fill={color} />
              </svg>
              <span className="bar-chart-value numeric">{formatValue(datum.value)}</span>
            </li>
          );
        })}
      </ul>

      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">항목</th>
            <th scope="col">값</th>
          </tr>
        </thead>
        <tbody>
          {data.map((datum) => (
            <tr key={datum.label}>
              <th scope="row">{datum.label}</th>
              <td>{formatValue(datum.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
