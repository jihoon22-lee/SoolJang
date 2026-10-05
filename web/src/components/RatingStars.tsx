/**
 * 6점 만점 0.5 단위 평점 입력. 별을 누르면 그 점수, 같은 별을 다시 누르면 0.5 내린다.
 *
 * 예전 13개 선택지 select 보다 손가락으로 고르기 쉽다. 키보드로는 별마다 Tab 으로 가서
 * Enter/Space 로 고르고, "평점 없음"으로 지운다. 레거시 시트와 같은 척도(6점, 0.5 단위)다.
 */

import { MAX_RATING } from "@/format";

export function RatingStars({
  value,
  onChange,
  label = "평점",
}: {
  /** "4.5" 같은 문자열. 빈 문자열이면 평점 없음. */
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  const current = value === "" ? null : Number(value);
  return (
    <fieldset className="rating-stars">
      <legend>
        {label}{" "}
        <span className="muted">({current === null ? "없음" : `${current} / ${MAX_RATING}`})</span>
      </legend>
      <div className="rating-stars-row">
        {Array.from({ length: MAX_RATING }, (_, index) => {
          const star = index + 1;
          const fill =
            current === null
              ? "empty"
              : current >= star
                ? "full"
                : current >= star - 0.5
                  ? "half"
                  : "empty";
          return (
            <button
              key={star}
              type="button"
              className={`rating-star rating-star-${fill}`}
              aria-label={`${star}점`}
              aria-pressed={current !== null && current >= star - 0.5}
              onClick={() => {
                // 같은 별을 다시 누르면 반 점 내린다(5 → 4.5). 반 별에서 다시 누르면 다시 온 별.
                const next = current === star ? star - 0.5 : star;
                onChange(next.toFixed(1));
              }}
            >
              <span aria-hidden="true">★</span>
            </button>
          );
        })}
        <button type="button" className="btn-quiet rating-clear" onClick={() => onChange("")}>
          평점 없음
        </button>
      </div>
    </fieldset>
  );
}
