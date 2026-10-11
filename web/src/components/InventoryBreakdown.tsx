import { useState } from "react";
import type { CategoryStat, CategoryTree } from "@/api/types";
import { formatDate, formatMoney, formatVolume } from "@/format";
import type { ProductContext } from "@/router";
import { type DrinkableBottle, descendantIdsOfTree } from "@/sync/queries";

interface Props {
  stats: CategoryStat[];
  tree: CategoryTree;
  bottles: DrinkableBottle[];
  onSelectProduct: (id: string, context?: ProductContext) => void;
  onSelectCategory: (id: string) => void;
}
export function InventoryBreakdown({
  stats,
  tree,
  bottles,
  onSelectProduct,
  onSelectCategory,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState(false);
  const [sort, setSort] = useState("stock");
  const [selection, setSelection] = useState<{
    category: string | null;
    status: "all" | "open" | "unopened";
    name: string;
  } | null>(null);
  const rows = stats
    .filter((row) => expanded || !row.parent_category_id)
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name, "ko")
        : b.in_stock_count - a.in_stock_count || a.name.localeCompare(b.name, "ko"),
    );
  const selectedIds = selection?.category
    ? descendantIdsOfTree(selection.category, tree)
    : new Set<string>();
  const matched = selection
    ? bottles.filter((bottle) => {
        const inCategory =
          selection.category === null
            ? bottle.categoryId === null
            : !!bottle.categoryId && selectedIds.has(bottle.categoryId);
        return inCategory && (selection.status === "all" || bottle.status === selection.status);
      })
    : [];
  return (
    <div className="inventory-breakdown">
      <div className="quality-toolbar">
        <label>
          <input
            type="checkbox"
            checked={expanded}
            onChange={(e) => setExpanded(e.target.checked)}
          />{" "}
          하위 주종 함께 보기
        </label>
        <label>
          <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />{" "}
          누적·원가 보기
        </label>
        <label>
          주종 정렬{" "}
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="stock">현재 보유순</option>
            <option value="name">이름순</option>
          </select>
        </label>
      </div>
      <p className="muted text-sm">
        현재 보유 = 미개봉 + 개봉. 숫자를 누르면 해당 병을 볼 수 있습니다.
        {expanded ? " 상위 행에는 하위 주종이 포함됩니다." : ""}
      </p>
      {rows.length === 0 ? (
        <p className="muted">등록한 술이 없습니다. 내 술에서 첫 제품을 추가하세요.</p>
      ) : (
        <div className="table-scroll table-scroll--always">
          <table className="quality-table">
            <thead>
              <tr>
                <th>주종</th>
                <th>현재 보유</th>
                <th>미개봉</th>
                <th>개봉</th>
                {history && (
                  <>
                    <th>제품 종류</th>
                    <th>누적 구매</th>
                    <th>소진</th>
                    <th>증여</th>
                    <th>판매</th>
                    <th>재고 원가</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.category_id ?? "uncategorized"}>
                  <th scope="row">
                    {row.category_id ? (
                      <button
                        type="button"
                        className="entity-link"
                        onClick={() => onSelectCategory(row.category_id as string)}
                      >
                        {row.parent_category_id
                          ? `${tree.items
                              .find((n) => n.id === row.category_id)
                              ?.path.slice(0, -1)
                              .join(" / ")} / `
                          : ""}
                        {row.name}
                      </button>
                    ) : (
                      row.name
                    )}
                  </th>
                  {(
                    [
                      ["all", "현재 보유", row.in_stock_count],
                      ["unopened", "미개봉", row.unopened_count],
                      ["open", "개봉", row.opened_count],
                    ] as const
                  ).map(([status, label, count]) => (
                    <td key={status}>
                      <button
                        type="button"
                        className="inventory-count"
                        aria-label={`${row.name} ${label} ${count}병 보기`}
                        aria-pressed={
                          selection?.category === row.category_id && selection.status === status
                        }
                        onClick={() =>
                          setSelection({
                            category: row.category_id,
                            status,
                            name: `${row.name} · ${label}`,
                          })
                        }
                      >
                        {count.toLocaleString("ko-KR")}
                      </button>
                    </td>
                  ))}
                  {history && (
                    <>
                      <td>{row.product_count}</td>
                      <td>{row.bottle_count}</td>
                      <td>{row.consumed_count}</td>
                      <td>{row.gifted_count}</td>
                      <td>{row.sold_count}</td>
                      <td>{formatMoney(row.inventory_value_at_cost)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selection && (
        <section className="inventory-evidence" aria-label={`${selection.name} 병 목록`}>
          <div className="section-header">
            <h4>
              {selection.name} <span className="muted">{matched.length}병</span>
            </h4>
            <button type="button" onClick={() => setSelection(null)}>
              목록 닫기
            </button>
          </div>
          {matched.length === 0 ? (
            <p>해당 상태의 병이 없습니다.</p>
          ) : (
            <ul className="quality-record-list">
              {matched.map((bottle) => (
                <li key={bottle.bottleId}>
                  <button
                    type="button"
                    className="entity-link"
                    onClick={() =>
                      onSelectProduct(bottle.productId, {
                        skuId: bottle.skuId,
                        bottleId: bottle.bottleId,
                      })
                    }
                  >
                    {bottle.productName}
                  </button>
                  <span className="muted text-sm">
                    {formatVolume(bottle.volumeMl)} · 병 #{bottle.labelNo} ·{" "}
                    {bottle.status === "open" ? "개봉" : "미개봉"}
                    {bottle.vendorName ? ` · ${bottle.vendorName}` : ""}
                    {bottle.purchasedOn ? ` · ${formatDate(bottle.purchasedOn)} 구매` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
