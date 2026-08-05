/**
 * 도넛 차트. 병 상태(미개봉/개봉/소진/증여/판매) 같은 "전체를 몇 갈래로 나눈" 비율을
 * 보여줄 때 쓴다.
 *
 * SVG `<circle>` 의 `stroke-dasharray`/`stroke-dashoffset` 로 각 조각을 그린다 — 반지름을
 * `100 / (2π)` 로 잡아 둘레가 정확히 100이 되게 하면, 각 조각의 대시 길이가 곧 백분율이라
 * 계산이 단순해진다.
 */

import { colorFor } from "@/components/charts/palette";

export interface DonutChartDatum {
  label: string;
  value: number;
  color?: string;
}

interface DonutChartProps {
  title: string;
  data: DonutChartDatum[];
  formatValue?: (value: number) => string;
  emptyMessage?: string;
}

//: 둘레가 정확히 100이 되는 반지름(100 / (2π)) — 대시 길이를 곧 백분율로 쓸 수 있다.
const RADIUS = 15.9155;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function DonutChart({
  title,
  data,
  formatValue = (value) => value.toLocaleString("ko-KR"),
  emptyMessage = "데이터가 없습니다.",
}: DonutChartProps) {
  const total = data.reduce((sum, datum) => sum + datum.value, 0);

  if (total <= 0) {
    return <p className="muted">{emptyMessage}</p>;
  }

  let drawnSoFar = 0;
  const segments = data
    .filter((datum) => datum.value > 0)
    .map((datum, index) => {
      const dashLength = (datum.value / total) * CIRCUMFERENCE;
      const segment = {
        label: datum.label,
        color: datum.color ?? colorFor(index),
        dashArray: `${dashLength} ${CIRCUMFERENCE - dashLength}`,
        dashOffset: -drawnSoFar,
      };
      drawnSoFar += dashLength;
      return segment;
    });

  return (
    <div className="donut-chart" role="img" aria-label={title}>
      <svg viewBox="0 0 40 40" className="donut-chart-svg" aria-hidden="true">
        <circle cx="20" cy="20" r={RADIUS} fill="none" stroke="var(--border)" strokeWidth="7" />
        {segments.map((segment) => (
          <circle
            key={segment.label}
            cx="20"
            cy="20"
            r={RADIUS}
            fill="none"
            stroke={segment.color}
            strokeWidth="7"
            strokeDasharray={segment.dashArray}
            strokeDashoffset={segment.dashOffset}
            transform="rotate(-90 20 20)"
          />
        ))}
      </svg>

      <ul className="donut-chart-legend">
        {data.map((datum, index) => (
          <li key={datum.label}>
            <span
              className="donut-chart-swatch"
              aria-hidden="true"
              style={{ backgroundColor: datum.color ?? colorFor(index) }}
            />
            <span className="donut-chart-legend-label">{datum.label}</span>
            <span className="numeric">{formatValue(datum.value)}</span>
          </li>
        ))}
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
