/**
 * 병 잔량 게이지(D262). 장식이 아니라 남은 양을 보이는 정보 요소다.
 *
 * 같은 행에 "Nml 남음"·"잔량 미기록" 글자가 함께 있으므로 그림 자체는 보조 기술에 숨긴다.
 * 잔량을 모르는 병은 빈 병으로 그리지 않고 빗금으로 구분한다(D242).
 */

export type BottleFill = { kind: "known"; ratio: number } | { kind: "unknown" };

export function bottleFill(
  status: string,
  remainingMl: number | null,
  volumeMl: number | null,
): BottleFill {
  if (status === "unopened") return { kind: "known", ratio: 1 };
  if (remainingMl === null || volumeMl === null || volumeMl <= 0) return { kind: "unknown" };
  return { kind: "known", ratio: Math.min(1, Math.max(0, remainingMl / volumeMl)) };
}

export function BottleGauge({
  status,
  remainingMl,
  volumeMl,
}: {
  status: string;
  remainingMl: number | null;
  volumeMl: number | null;
}) {
  const fill = bottleFill(status, remainingMl, volumeMl);
  return (
    <span
      className={`bottle-gauge${fill.kind === "unknown" ? " bottle-gauge--unknown" : ""}`}
      aria-hidden="true"
    >
      {fill.kind === "known" ? (
        <span
          className="bottle-gauge-fill"
          style={{ height: `${Math.round(fill.ratio * 100)}%` }}
        />
      ) : null}
    </span>
  );
}
