/**
 * "오늘 마셨어요" — 홈에서 바로 시음을 기록한다.
 *
 * 예전에는 내 술 → 제품 → 병 펼치기 → 8칸 폼을 거쳐야 했다. 이제 병 고르기(열려 있는 병이
 * 먼저) → 별점·따른 양 → 저장 두 단계다. 미개봉 병을 고르면 기록과 함께 개봉된다.
 * 오프라인에서도 outbox 로 저장된다.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";
import { type RefObject, useEffect, useMemo, useState } from "react";
import type { User } from "@/api/types";
import { TastingFields, type TastingFieldValues } from "@/components/TastingFields";
import { useToast } from "@/components/Toast";
import { todayLocal } from "@/format";
import { matchesQuery } from "@/search";
import { type DrinkableBottle, getDrinkableBottles } from "@/sync/queries";
import { lastTastingContext, recordTasting, rememberTastingContext } from "@/sync/tastingActions";
import { useModalDialog } from "@/useModalDialog";

function emptyValues(): TastingFieldValues {
  const context = lastTastingContext();
  return {
    tastedOn: todayLocal(),
    pouredMl: "",
    rating: "",
    nose: "",
    palate: "",
    finish: "",
    place: context.place,
    companions: context.companions,
  };
}

export function QuickTastingSheet({
  onClose,
  returnFocusRef,
}: {
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const dialogRef = useModalDialog(returnFocusRef);
  const bottles = useLiveQuery(() => getDrinkableBottles(), []);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<DrinkableBottle | null>(null);
  const [values, setValues] = useState<TastingFieldValues>(emptyValues);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // 열린 병은 하나씩, 미개봉 병은 술마다 한 줄로 묶는다 — 6병 박스가 6줄로 반복되지 않게.
  // 미개봉 줄을 고르면 번호가 가장 작은 병을 연다.
  const visible = useMemo(() => {
    const unopenedCount = new Map<string, number>();
    const rows: (DrinkableBottle & { unopenedCount?: number })[] = [];
    for (const item of bottles ?? []) {
      if (query.trim() && !matchesQuery(item.productName, query)) continue;
      if (item.status === "unopened") {
        const seen = unopenedCount.get(item.productId) ?? 0;
        unopenedCount.set(item.productId, seen + 1);
        if (seen > 0) continue;
      }
      rows.push(item);
    }
    return rows.map((row) =>
      row.status === "unopened" ? { ...row, unopenedCount: unopenedCount.get(row.productId) } : row,
    );
  }, [bottles, query]);
  const openCount = (bottles ?? []).filter((item) => item.status === "open").length;

  async function save(): Promise<void> {
    if (!chosen) return;
    setSaving(true);
    setError(null);
    try {
      await recordTasting({
        bottleId: chosen.bottleId,
        tastedOn: values.tastedOn,
        pouredMl: values.pouredMl ? Number(values.pouredMl) : null,
        rating: values.rating || null,
        nose: values.nose,
        palate: values.palate,
        finish: values.finish,
        place: values.place,
        companions: values.companions,
        userId: queryClient.getQueryData<User>(["auth", "me"])?.id ?? "",
      });
      rememberTastingContext({ place: values.place.trim(), companions: values.companions.trim() });
      toast.show({
        message: `${chosen.productName} 시음을 기록했습니다${
          chosen.status === "unopened" ? " (개봉 처리)" : ""
        }`,
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "기록하지 못했습니다");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sheet-backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-tasting-heading"
        tabIndex={-1}
        className="bottom-sheet"
      >
        <div className="section-heading-row">
          <h2 id="quick-tasting-heading" className="mb-0">
            {chosen ? chosen.productName : "무엇을 마셨나요?"}
          </h2>
          <button type="button" className="btn-quiet" onClick={onClose}>
            닫기
          </button>
        </div>

        {chosen === null ? (
          <>
            <label className="field">
              <span>술 이름 검색</span>
              <input
                type="search"
                value={query}
                placeholder="한글·초성 검색"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            {bottles === undefined ? <output>불러오는 중…</output> : null}
            {bottles !== undefined && bottles.length === 0 ? (
              <p className="muted">재고가 있는 술이 없습니다. 내 술에서 구매를 먼저 기록하세요.</p>
            ) : null}
            {openCount > 0 && !query ? (
              <p className="muted text-sm">열려 있는 병 {openCount}개를 먼저 보여 줍니다.</p>
            ) : null}
            <ul className="pick-list">
              {visible.slice(0, 40).map((item) => (
                <li key={item.bottleId}>
                  <button type="button" onClick={() => setChosen(item)}>
                    <span>
                      {item.productName}{" "}
                      {item.status === "open" ? (
                        <span className="muted">#{item.labelNo}</span>
                      ) : null}
                    </span>
                    <span className={`bottle-badge bottle-badge-${item.status}`}>
                      {item.status === "open"
                        ? item.remainingMl !== null
                          ? `개봉 · ${item.remainingMl}ml`
                          : "개봉"
                        : `미개봉 ${item.unopenedCount ?? 1}병`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <p className="muted text-sm mt-0">
              #{chosen.labelNo}
              {chosen.status === "unopened" ? " · 저장하면 개봉 처리됩니다" : ""}
            </p>
            <TastingFields
              values={values}
              remainingMl={
                chosen.status === "open" ? (chosen.remainingMl ?? chosen.volumeMl) : chosen.volumeMl
              }
              onChange={(patch) => setValues((current) => ({ ...current, ...patch }))}
            />
            {error ? (
              <p className="alert" role="alert">
                {error}
              </p>
            ) : null}
            <div className="button-row">
              <button type="submit" className="primary" disabled={saving}>
                {saving ? "저장 중…" : "기록 저장"}
              </button>
              <button type="button" onClick={() => setChosen(null)}>
                다른 술 고르기
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
