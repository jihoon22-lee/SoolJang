/**
 * 6점 만점 0.5 단위 평점 입력. 별을 누르면 그 점수, 같은 별을 다시 누르면 0.5 내린다.
 *
 * 예전 13개 선택지 select 보다 손가락으로 고르기 쉽다. 키보드로는 별마다 Tab 으로 가서
 * Enter/Space 로 고르고, "평점 없음"으로 지운다. 레거시 시트와 같은 척도(6점, 0.5 단위)다.
 * 시음 평점은 0점이 있고 미평가와 다르다. 제품 평점은 0.5~6만 받으므로 0점을 감춘다.
 */

import { MAX_RATING } from "@/format";

export function RatingStars({
  value,
  onChange,
  label = "평점",
  allowZero = true,
  id,
  describedBy,
}: {
  /** "4.5" 같은 문자열. 빈 문자열이면 평점 없음. */
  value: string;
  onChange: (value: string) => void;
  label?: string;
  allowZero?: boolean;
  id?: string | undefined;
  /** 칸 아래 오류 문구의 id. */
  describedBy?: string | undefined;
}) {
  const current = value === "" ? null : Number(value);
  return (
    <fieldset className="rating-stars" id={id} aria-describedby={describedBy}>
      <legend>
        {label}{" "}
        <span className="muted">({current === null ? "없음" : `${current} / ${MAX_RATING}`})</span>
      </legend>
      {/* 별 여섯 개를 한 묶음으로 먼저 두고 0점·평점 없음은 뒤 묶음이다. 좁은 폼에서는 뒤 묶음만 다음
          줄로 내려가 별 줄이 끊기지 않고, 초점 순서도 보이는 순서와 같다. */}
      <div className="rating-stars-row">
        <div className="rating-stars-scale">
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
        </div>
        <div className="rating-stars-extra">
          {allowZero ? (
            <button
              type="button"
              className="btn-quiet"
              aria-label="0점"
              aria-pressed={current === 0}
              onClick={() => onChange("0.0")}
            >
              0점
            </button>
          ) : null}
          <button type="button" className="btn-quiet rating-clear" onClick={() => onChange("")}>
            평점 없음
          </button>
        </div>
      </div>
    </fieldset>
  );
}
