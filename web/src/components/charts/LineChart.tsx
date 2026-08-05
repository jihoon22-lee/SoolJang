/**
 * 선 그래프. 월별 지출·구매 병수 같은 시계열에 쓴다.
 *
 * 점이 많아도 항상 `viewBox="0 0 100 40"` 안에 맞춰 그린다 — 실제 픽셀 크기는 CSS 가
 * 반응형으로 정한다. x축 라벨은 촘촘해지면(13개 이상) 한 칸씩 걸러 보여준다.
 */

interface LineChartPoint {
  label: string;
  value: number;
}

interface LineChartProps {
  title: string;
  data: LineChartPoint[];
  formatValue?: (value: number) => string;
  emptyMessage?: string;
  color?: string;
}

const VIEW_WIDTH = 100;
const VIEW_HEIGHT = 40;
const TOP_PADDING = 4;
const BOTTOM_PADDING = 8;
//: 라벨이 이보다 많으면 한 칸씩 걸러 보여준다 — 안 그러면 겹쳐서 못 읽는다.
const MAX_DENSE_LABELS = 12;

export function LineChart({
  title,
  data,
  formatValue = (value) => value.toLocaleString("ko-KR"),
  emptyMessage = "데이터가 없습니다.",
  color = "var(--accent-strong)",
}: LineChartProps) {
  if (data.length === 0) {
    return <p className="muted">{emptyMessage}</p>;
  }

  const values = data.map((point) => point.value);
  const maxValue = Math.max(...values, 0);
  const minValue = Math.min(...values, 0);
  const span = maxValue - minValue || 1;
  const plotHeight = VIEW_HEIGHT - TOP_PADDING - BOTTOM_PADDING;

  function xAt(index: number): number {
    return data.length === 1 ? VIEW_WIDTH / 2 : (index / (data.length - 1)) * VIEW_WIDTH;
  }
  function yAt(value: number): number {
    return TOP_PADDING + plotHeight - ((value - minValue) / span) * plotHeight;
  }

  const points = data.map((point, index) => ({ x: xAt(index), y: yAt(point.value), ...point }));
  const linePath = points.map((p) => `${p.x},${p.y}`).join(" ");
  const areaPath = `${xAt(0)},${VIEW_HEIGHT - BOTTOM_PADDING} ${linePath} ${xAt(data.length - 1)},${VIEW_HEIGHT - BOTTOM_PADDING}`;
  const showEveryLabel = data.length <= MAX_DENSE_LABELS;

  return (
    <div className="line-chart" role="img" aria-label={title}>
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        className="line-chart-svg"
        aria-hidden="true"
      >
        <polygon points={areaPath} className="line-chart-area" fill={color} />
        <polyline points={linePath} fill="none" stroke={color} strokeWidth="1" />
        {points.map((p, index) => (
          <circle
            key={p.label}
            cx={p.x}
            cy={p.y}
            r={showEveryLabel || index % 2 === 0 ? 1.2 : 0.7}
            fill={color}
          />
        ))}
      </svg>
      <div className="line-chart-labels">
        {data.map((point, index) => (
          <span key={point.label} className={showEveryLabel || index % 2 === 0 ? "" : "sr-only"}>
            {point.label}
          </span>
        ))}
      </div>

      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">시점</th>
            <th scope="col">값</th>
          </tr>
        </thead>
        <tbody>
          {data.map((point) => (
            <tr key={point.label}>
              <th scope="row">{point.label}</th>
              <td>{formatValue(point.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
