/**
 * 병 화면.
 *
 * 재고에 있는 병을 기본으로 보여준다. 이미 마셔 버린 병까지 섞으면 "지금 뭘 마실 수 있는지"를
 * 찾기 어렵다.
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { bottlesApi } from "@/api/client";
import type { Bottle, BottleStatus } from "@/api/types";
import { BottlePanel, formatRemaining } from "@/components/BottlePanel";

type Filter = "in_stock" | "all" | BottleStatus;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "in_stock", label: "재고" },
  { id: "unopened", label: "미개봉" },
  { id: "open", label: "개봉" },
  { id: "finished", label: "소진" },
  { id: "all", label: "전체" },
];

function filterParams(filter: Filter): { status?: string; in_stock?: boolean } {
  if (filter === "in_stock") return { in_stock: true };
  if (filter === "all") return {};
  return { status: filter };
}

export function BottlesPage(): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>("in_stock");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const bottles = useQuery({
    queryKey: ["bottles", filter],
    queryFn: ({ signal }) => bottlesApi.list(filterParams(filter), signal),
  });

  const selected: Bottle | undefined = bottles.data?.find((item) => item.id === selectedId);

  return (
    <div className="bottles-page">
      <h2>병 관리</h2>

      <fieldset className="bottle-filters">
        <legend>보기</legend>
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={filter === item.id}
            onClick={() => {
              setFilter(item.id);
              setSelectedId(null);
            }}
          >
            {item.label}
          </button>
        ))}
      </fieldset>

      {bottles.isPending ? <output>불러오는 중…</output> : null}
      {bottles.isError ? (
        <p role="alert">병 목록을 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.</p>
      ) : null}

      {bottles.data?.length === 0 ? (
        <p className="muted">
          해당하는 병이 없습니다. 술을 등록하고 구매 정보를 넣으면 병이 만들어집니다.
        </p>
      ) : null}

      <ul className="bottle-list">
        {bottles.data?.map((bottle) => (
          <li key={bottle.id}>
            <button
              type="button"
              className="bottle-list-item"
              aria-expanded={selectedId === bottle.id}
              onClick={() => setSelectedId(selectedId === bottle.id ? null : bottle.id)}
            >
              <span className="bottle-list-label">{bottle.label_no}번 병</span>
              <span className={`bottle-badge bottle-badge-${bottle.status}`}>{bottle.status}</span>
              <span className="bottle-list-remaining">{formatRemaining(bottle)}</span>
            </button>
            {selectedId === bottle.id ? <BottlePanel bottle={bottle} /> : null}
          </li>
        ))}
      </ul>

      {selected && selectedId && !bottles.data?.some((item) => item.id === selectedId) ? (
        <BottlePanel bottle={selected} />
      ) : null}
    </div>
  );
}
