import Decimal from "decimal.js";
import { productEdition } from "@/components/productDisplay";
import { computeProductMetrics } from "@/domain/metrics";
import type { ProductContext } from "@/router";
import type { SyncRow } from "@/sync/db";

export interface InsightSnapshot {
  categories: SyncRow[];
  products: SyncRow[];
  skus: SyncRow[];
  purchases: SyncRow[];
  bottles: SyncRow[];
  tastings: SyncRow[];
  producers: SyncRow[];
  vendors: SyncRow[];
}
export interface InsightFilters {
  from: string;
  to: string;
  categoryId: string;
  status: string;
}
export interface Evidence extends ProductContext {
  id: string;
  productId: string | null;
  label: string;
  detail: string;
}
export interface BottleInsight extends Evidence {
  status: string;
  openedDays: number | null;
  remainingMl: number | null;
  lastTastedOn: string | null;
  daysSinceTasting: number | null;
}
export interface RatingSample {
  count: number;
  average: number | null;
  bins: number[];
  evidence: Evidence[];
}
export interface RatingGroup {
  label: string;
  products: RatingSample;
  sessions: RatingSample;
}
export type RatingDimension = "category" | "producer" | "region" | "price";
interface JoinedPurchase {
  row: SyncRow;
  sku: SyncRow;
  product: SyncRow;
}
interface JoinedBottle extends JoinedPurchase {
  bottle: SyncRow;
}
interface JoinedTasting {
  row: SyncRow;
  sku: SyncRow;
  product: SyncRow;
  bottle: JoinedBottle | undefined;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const numeric = (value: unknown): number | null =>
  value === null || value === undefined || value === "" || !Number.isFinite(Number(value))
    ? null
    : Number(value);
const live = (rows: SyncRow[]) => rows.filter((row) => row.deleted_at === null);
const index = (rows: SyncRow[]) => new Map(rows.map((row) => [row.id, row]));
function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }
  return groups;
}
const money = (value: unknown): Decimal => {
  const text = value === null || value === undefined || value === "" ? "0" : String(value);
  try {
    const number = new Decimal(text);
    return number.isFinite() && number.gte(0) ? number : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
};
export function validDay(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
    ? value
    : null;
}
const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const shift = (day: string, count: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10);
const mean = (values: number[]) =>
  values.length
    ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100
    : null;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle],
    lower = sorted[middle - 1];
  if (upper === undefined) return null;
  return sorted.length % 2 || lower === undefined ? upper : (lower + upper) / 2;
};
const ratingValues = (rows: JoinedTasting[]): number[] =>
  rows.flatMap(({ row }) => {
    const value = rating(row.rating);
    return value === null ? [] : [value];
  });
function rating(value: unknown): number | null {
  const number = numeric(value);
  return number !== null && number >= 0 && number <= 6 ? number : null;
}
const productLabel = (product: SyncRow) =>
  [
    str(product.name),
    productEdition({
      vintage: numeric(product.vintage),
      age_years: numeric(product.age_years)?.toString() ?? null,
      abv: numeric(product.abv)?.toString() ?? null,
    }),
  ]
    .filter(Boolean)
    .join(" · ");
function evidence(product: SyncRow, sku?: SyncRow, bottle?: SyncRow, tasting?: SyncRow): Evidence {
  return {
    id: tasting?.id ?? bottle?.id ?? product.id,
    productId: product.id,
    skuId: sku?.id,
    bottleId: bottle?.id,
    tastingId: tasting?.id,
    label: [
      productLabel(product),
      sku ? (numeric(sku.volume_ml) === null ? "용량 미기록" : `${sku.volume_ml}ml`) : null,
      bottle ? `${bottle.label_no ?? "?"}번 병` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    detail: "",
  };
}
function sample(): RatingSample {
  return { count: 0, average: null, bins: Array<number>(13).fill(0), evidence: [] };
}
function paidBand(purchase: JoinedPurchase, vendors: Map<string, SyncRow>): string {
  const paid = money(purchase.row.unit_paid_price);
  const band = paid.isZero()
    ? "0원"
    : paid.lt(50_000)
      ? "5만원 미만"
      : paid.lt(100_000)
        ? "5~10만원"
        : paid.lt(200_000)
          ? "10~20만원"
          : "20만원 이상";
  return `${str(purchase.row.currency) || "KRW"} 구매 · ${band} · ${numeric(purchase.sku.volume_ml) ?? "?"}ml · ${str(purchase.row.discount_note).trim() || "조건 미기록"} · ${str(vendors.get(str(purchase.row.vendor_id))?.kind) || "구매처 종류 미기록"}`;
}

/** Immutable, account-filtered atomic facts only. No historical inventory is reconstructed. */
export function calculateInsights(
  snapshot: InsightSnapshot,
  filters: InsightFilters,
  today: string,
) {
  const categories = index(live(snapshot.categories)),
    producers = index(live(snapshot.producers)),
    vendors = index(live(snapshot.vendors));
  const categoryName = (id: string): string => {
    const names: string[] = [],
      seen = new Set<string>();
    let current = categories.get(id);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.unshift(str(current.name));
      current = categories.get(str(current.parent_id));
    }
    return names.join(" > ") || "주종 미지정";
  };
  const inCategory = (product: SyncRow) => {
    if (!filters.categoryId) return true;
    const seen = new Set<string>();
    let id = str(product.category_id);
    while (id && !seen.has(id)) {
      if (id === filters.categoryId) return true;
      seen.add(id);
      id = str(categories.get(id)?.parent_id);
    }
    return false;
  };
  const scopedProducts = live(snapshot.products).filter(inCategory),
    productById = index(scopedProducts);
  const skuById = index(live(snapshot.skus).filter((sku) => productById.has(str(sku.product_id))));
  const allPurchases: JoinedPurchase[] = live(snapshot.purchases).flatMap((row) => {
    const sku = skuById.get(str(row.sku_id)),
      product = sku ? productById.get(str(sku.product_id)) : undefined;
    return sku && product ? [{ row, sku, product }] : [];
  });
  const purchaseById = new Map(allPurchases.map((p) => [p.row.id, p]));
  const purchasesByProduct = groupBy(allPurchases, (p) => p.product.id);
  const allBottles: JoinedBottle[] = live(snapshot.bottles).flatMap((bottle) => {
    const purchase = purchaseById.get(str(bottle.purchase_id));
    return purchase ? [{ ...purchase, bottle }] : [];
  });
  const stateMatches = (bottle: SyncRow) =>
    filters.status === "all" ||
    (filters.status === "stock"
      ? ["unopened", "open"].includes(str(bottle.status))
      : bottle.status === filters.status);
  const bottles = allBottles.filter((b) => stateMatches(b.bottle)),
    bottleById = new Map(allBottles.map((b) => [b.bottle.id, b]));
  const productIds = new Set(bottles.map((b) => b.product.id));
  const products = scopedProducts.filter((p) => filters.status === "all" || productIds.has(p.id));
  const selectedBottles = new Set(bottles.map((b) => b.bottle.id));
  const bottlesByPurchase = groupBy(bottles, (b) => b.row.id);
  const allTastings: JoinedTasting[] = live(snapshot.tastings).flatMap((row) => {
    const sku = skuById.get(str(row.sku_id)),
      product = sku ? productById.get(str(sku.product_id)) : undefined;
    const bottle = bottleById.get(str(row.bottle_id));
    if (!sku || !product || (row.bottle_id && (!bottle || bottle.sku.id !== sku.id))) return [];
    return [{ row, sku, product, bottle }];
  });
  const tastingsByBottle = groupBy(allTastings, (t) => str(t.row.bottle_id));
  const tastings = allTastings.filter(
    (t) => filters.status === "all" || selectedBottles.has(str(t.row.bottle_id)),
  );
  const purchases = allPurchases.flatMap((p) => {
    const quantity =
      filters.status === "all"
        ? (numeric(p.row.quantity) ?? 0)
        : (bottlesByPurchase.get(p.row.id)?.length ?? 0);
    return quantity > 0 ? [{ ...p, quantity }] : [];
  });
  const inPeriod = (value: unknown, from = filters.from, to = filters.to) => {
    const day = validDay(value);
    return Boolean(day && (!from || day >= from) && (!to || day <= to));
  };
  const tastingEvidence = (t: JoinedTasting) => ({
    ...evidence(t.product, t.sku, t.bottle?.bottle, t.row),
    purchaseId: t.bottle?.row.id,
    detail: `${str(t.row.tasted_on)} · ${rating(t.row.rating) === null ? "평점 없음" : `${t.row.rating}점`}`,
  });
  const purchaseEvidence = (p: JoinedPurchase & { quantity?: number }) => ({
    ...evidence(p.product, p.sku),
    id: p.row.id,
    purchaseId: p.row.id,
    detail: `${str(p.row.purchased_on) || "구매일 미기록"} · ${str(vendors.get(str(p.row.vendor_id))?.name) || "구매처 미기록"} · 선택 ${p.quantity ?? numeric(p.row.quantity) ?? 0}병 / 구매 ${numeric(p.row.quantity) ?? 0}병 · 병당 ${money(p.row.unit_paid_price).toFixed(2)}원`,
  });
  function aggregate(from: string, to: string) {
    const bought = purchases.filter((p) => inPeriod(p.row.purchased_on, from, to));
    const disposed = bottles.filter(
      (b) =>
        ["finished", "gifted", "sold"].includes(str(b.bottle.status)) &&
        inPeriod(b.bottle.finished_on, from, to),
    );
    const sessions = tastings.filter((t) => inPeriod(t.row.tasted_on, from, to));
    return {
      from,
      to,
      purchaseCount: bought.length,
      purchasedBottles: bought.reduce((sum, p) => sum + p.quantity, 0),
      spend: bought
        .reduce(
          (sum, p) => sum.plus(money(p.row.unit_paid_price).times(p.quantity)),
          new Decimal(0),
        )
        .toFixed(2),
      finished: disposed.filter((b) => b.bottle.status === "finished").length,
      gifted: disposed.filter((b) => b.bottle.status === "gifted").length,
      sold: disposed.filter((b) => b.bottle.status === "sold").length,
      tastings: sessions.length,
      ratedSessions: sessions.filter((t) => rating(t.row.rating) !== null).length,
      averageRating: mean(ratingValues(sessions)),
      evidence: [
        ...bought.map(purchaseEvidence),
        ...disposed.map((b) => ({
          ...evidence(b.product, b.sku, b.bottle),
          detail: `${str(b.bottle.finished_on)} · ${b.bottle.status === "finished" ? "소진" : b.bottle.status === "gifted" ? "증여" : "판매"}`,
        })),
        ...sessions.map(tastingEvidence),
      ],
    };
  }
  const period = aggregate(filters.from, filters.to);
  const span =
    validDay(filters.from) && validDay(filters.to) ? days(filters.from, filters.to) + 1 : 0;
  const previous = span > 0 ? aggregate(shift(filters.from, -span), shift(filters.from, -1)) : null;
  const months = new Set<string>();
  for (const value of [
    ...purchases.map((p) => p.row.purchased_on),
    ...bottles
      .filter((b) => ["finished", "gifted", "sold"].includes(str(b.bottle.status)))
      .map((b) => b.bottle.finished_on),
    ...tastings.map((t) => t.row.tasted_on),
  ])
    if (inPeriod(value)) months.add(str(value).slice(0, 7));
  const monthly = [...months].sort().map((month) => ({
    ...aggregate(
      filters.from > `${month}-01` ? filters.from : `${month}-01`,
      filters.to && filters.to < `${month}-31` ? filters.to : `${month}-31`,
    ),
    month,
  }));
  const stock = bottles.filter((b) => ["unopened", "open"].includes(str(b.bottle.status)));
  const costLots = allPurchases.flatMap((p) => {
    const quantity = numeric(p.row.quantity) ?? 0,
      volumeMl = numeric(p.sku.volume_ml) ?? 0;
    return quantity > 0 && volumeMl > 0
      ? [
          {
            purchaseId: p.row.id,
            skuId: p.sku.id,
            quantity,
            volumeMl,
            unitListPrice: money(p.row.unit_list_price),
            unitPaidPrice: money(p.row.unit_paid_price),
          },
        ]
      : [];
  });
  const costPurchaseIds = new Set(costLots.map((lot) => lot.purchaseId));
  const inventoryCost = computeProductMetrics(
    costLots,
    stock
      .filter((b) => costPurchaseIds.has(b.row.id))
      .map((b) => ({
        purchaseId: b.row.id,
        status: str(b.bottle.status),
        openedOn: validDay(b.bottle.opened_on),
        finishedOn: validDay(b.bottle.finished_on),
      })),
  ).inventoryValueAtCost;
  const remaining = (b: JoinedBottle) =>
    b.bottle.status === "unopened" ? numeric(b.sku.volume_ml) : numeric(b.bottle.remaining_ml);
  const inventory = {
    bottles: stock.length,
    products: new Set(stock.map((b) => b.product.id)).size,
    unopened: stock.filter((b) => b.bottle.status === "unopened").length,
    opened: stock.filter((b) => b.bottle.status === "open").length,
    knownRemainingMl: stock.reduce((sum, b) => sum + (remaining(b) ?? 0), 0),
    unknownRemaining: stock.filter((b) => remaining(b) === null).length,
    cost: inventoryCost?.toFixed(2) ?? null,
  };
  const openBottles: BottleInsight[] = stock
    .filter((b) => b.bottle.status === "open")
    .map((b) => {
      const opened = validDay(b.bottle.opened_on),
        on = opened && opened <= today ? opened : null;
      const latest =
        (tastingsByBottle.get(b.bottle.id) ?? [])
          .filter((t) => validDay(t.row.tasted_on) && str(t.row.tasted_on) <= today)
          .map((t) => str(t.row.tasted_on))
          .sort()
          .at(-1) ?? null;
      return {
        ...evidence(b.product, b.sku, b.bottle),
        detail: `구매 ${str(b.row.purchased_on) || "날짜 미기록"}`,
        status: "open",
        openedDays: on ? days(on, today) : null,
        remainingMl: remaining(b),
        lastTastedOn: latest,
        daysSinceTasting: latest ? days(latest, today) : null,
      };
    })
    .sort((a, b) => (b.openedDays ?? -1) - (a.openedDays ?? -1));
  const aging = [
    {
      label: "30일 미만",
      count: openBottles.filter((b) => b.openedDays !== null && b.openedDays < 30).length,
    },
    {
      label: "30~89일",
      count: openBottles.filter(
        (b) => b.openedDays !== null && b.openedDays >= 30 && b.openedDays < 90,
      ).length,
    },
    {
      label: "90~179일",
      count: openBottles.filter(
        (b) => b.openedDays !== null && b.openedDays >= 90 && b.openedDays < 180,
      ).length,
    },
    {
      label: "180일 이상",
      count: openBottles.filter((b) => b.openedDays !== null && b.openedDays >= 180).length,
    },
    { label: "개봉일 확인 필요", count: openBottles.filter((b) => b.openedDays === null).length },
  ];
  const stockCategories = [...new Set(stock.map((b) => categoryName(str(b.product.category_id))))]
    .sort()
    .map((label) => ({
      label,
      count: stock.filter((b) => categoryName(str(b.product.category_id)) === label).length,
    }));
  const seenProducts = new Set(allTastings.map((t) => t.product.id));
  const untried = [
    ...new Map(
      stock
        .filter((b) => !seenProducts.has(b.product.id))
        .map((b) => [
          b.product.id,
          {
            ...evidence(b.product, b.sku, b.bottle),
            detail: `이 제품의 전체 시음 기록 없음 · 구매 ${str(b.row.purchased_on) || "날짜 미기록"}`,
          },
        ]),
    ).values(),
  ];
  const firstSessions = bottles.flatMap((b) => {
    const purchaseDay = validDay(b.row.purchased_on);
    const first = (tastingsByBottle.get(b.bottle.id) ?? [])
      .filter((t) => t.row.bottle_id === b.bottle.id && validDay(t.row.tasted_on))
      .sort((a, c) => str(a.row.tasted_on).localeCompare(str(c.row.tasted_on)))[0];
    return purchaseDay && first && inPeriod(first.row.tasted_on)
      ? [{ ...tastingEvidence(first), days: days(purchaseDay, str(first.row.tasted_on)) }]
      : [];
  });
  const waits = firstSessions.filter((item) => item.days >= 0);
  const periodTastings = tastings.filter((t) => inPeriod(t.row.tasted_on));
  const periodPurchases = purchases.filter((p) => inPeriod(p.row.purchased_on));
  const periodTastingsByProduct = groupBy(periodTastings, (t) => t.product.id);
  const priceMaps = new Map<string, typeof periodPurchases>();
  for (const p of periodPurchases) {
    const key = JSON.stringify([
      p.sku.id,
      str(p.row.currency) || "KRW",
      str(p.row.discount_note).trim(),
      str(vendors.get(str(p.row.vendor_id))?.kind),
    ]);
    priceMaps.set(key, [...(priceMaps.get(key) ?? []), p]);
  }
  const prices = [...priceMaps.entries()]
    .flatMap(([key, rows]) => {
      const values = rows.map((p) => money(p.row.unit_paid_price)).sort((a, b) => a.comparedTo(b)),
        paid = values.filter((p) => p.gt(0));
      const middle = (items: Decimal[]) => {
        const upper = items[Math.floor(items.length / 2)],
          lower = items[items.length / 2 - 1];
        if (!upper) return null;
        return items.length % 2 || !lower ? upper : lower.plus(upper).div(2);
      };
      const first = rows[0],
        latest = [...rows].sort((a, b) =>
          str(b.row.purchased_on).localeCompare(str(a.row.purchased_on)),
        )[0];
      const minimum = values[0],
        median = middle(values);
      if (!first || !latest || !minimum || !median) return [];
      const latestValues = rows
        .filter((row) => row.row.purchased_on === latest.row.purchased_on)
        .map((row) => money(row.row.unit_paid_price))
        .sort((a, b) => a.comparedTo(b));
      return [
        {
          key,
          ...evidence(first.product, first.sku),
          skuId: first.sku.id,
          currency: str(first.row.currency) || "KRW",
          condition: str(first.row.discount_note).trim() || "조건 미기록",
          vendorKind: str(vendors.get(str(first.row.vendor_id))?.kind) || "구매처 종류 미기록",
          count: rows.length,
          zeroCount: values.length - paid.length,
          paidCount: paid.length,
          minimum: minimum.toFixed(2),
          median: median.toFixed(2),
          paidMedian: middle(paid)?.toFixed(2) ?? null,
          latestCount: latestValues.length,
          latestMinimum: (latestValues[0] ?? money(latest.row.unit_paid_price)).toFixed(2),
          latestMaximum: (latestValues.at(-1) ?? money(latest.row.unit_paid_price)).toFixed(2),
          latestOn: str(latest.row.purchased_on),
          evidence: rows.map(purchaseEvidence),
        },
      ];
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const ratingMaps: Record<
    RatingDimension,
    Map<
      string,
      {
        products: { value: number; record: Evidence }[];
        sessions: { value: number; record: Evidence }[];
      }
    >
  > = { category: new Map(), producer: new Map(), region: new Map(), price: new Map() };
  function groupLabels(
    product: SyncRow,
    purchase: JoinedPurchase | undefined,
    productRating: boolean,
  ) {
    let band = "구매 연결 없음";
    if (purchase) band = paidBand(purchase, vendors);
    else if (productRating) {
      const related = purchasesByProduct.get(product.id) ?? [];
      const signatures = new Set(related.map((p) => `${p.sku.id}|${paidBand(p, vendors)}`));
      const first = related[0];
      if (signatures.size === 1 && first) band = paidBand(first, vendors);
      else if (signatures.size > 1) band = "복수 규격·조건·가격대";
    }
    return {
      category: categoryName(str(product.category_id)),
      producer: str(producers.get(str(product.producer_id))?.name) || "생산자 미기록",
      region:
        [str(product.country), str(product.region)].filter(Boolean).join(" / ") || "지역 미기록",
      price: band,
    };
  }
  function addRating(
    product: SyncRow,
    value: number,
    record: Evidence,
    kind: "products" | "sessions",
    purchase?: JoinedPurchase,
  ) {
    for (const [dimension, label] of Object.entries(
      groupLabels(product, purchase, kind === "products"),
    ) as [RatingDimension, string][]) {
      const group = ratingMaps[dimension].get(label) ?? { products: [], sessions: [] };
      group[kind].push({ value, record });
      ratingMaps[dimension].set(label, group);
    }
  }
  for (const p of products) {
    const value = rating(p.personal_rating);
    if (value !== null) addRating(p, value, evidence(p), "products");
  }
  for (const t of periodTastings) {
    const value = rating(t.row.rating);
    if (value !== null) addRating(t.product, value, tastingEvidence(t), "sessions", t.bottle);
  }
  const toSample = (rows: { value: number; record: Evidence }[]): RatingSample => {
    const result = sample();
    result.count = rows.length;
    result.average = mean(rows.map((r) => r.value));
    result.evidence = rows.map((r) => r.record);
    for (const r of rows) {
      const bin = Math.floor(r.value * 2);
      result.bins[bin] = (result.bins[bin] ?? 0) + 1;
    }
    return result;
  };
  const ratings = Object.fromEntries(
    Object.entries(ratingMaps).map(([dimension, groups]) => [
      dimension,
      [...groups]
        .map(([label, group]) => ({
          label,
          products: toSample(group.products),
          sessions: toSample(group.sessions),
        }))
        .sort((a, b) => b.sessions.count - a.sessions.count || b.products.count - a.products.count),
    ]),
  ) as Record<RatingDimension, RatingGroup[]>;
  const changes = products.flatMap((product) => {
    const sessions = (periodTastingsByProduct.get(product.id) ?? [])
      .filter((t) => t.product.id === product.id && rating(t.row.rating) !== null)
      .sort(
        (a, b) =>
          str(a.row.tasted_on).localeCompare(str(b.row.tasted_on)) ||
          a.row.id.localeCompare(b.row.id),
      );
    const first = sessions[0],
      last = sessions.at(-1);
    if (sessions.length < 2 || !first || !last) return [];
    const firstOn = str(first.row.tasted_on),
      lastOn = str(last.row.tasted_on),
      firstRating = mean(ratingValues(sessions.filter((t) => t.row.tasted_on === firstOn))),
      lastRating = mean(ratingValues(sessions.filter((t) => t.row.tasted_on === lastOn)));
    if (firstRating === null || lastRating === null) return [];
    return [
      {
        ...evidence(product),
        count: sessions.length,
        firstOn,
        lastOn,
        firstRating,
        lastRating,
        delta: firstOn === lastOn ? null : Math.round((lastRating - firstRating) * 100) / 100,
        evidence: sessions.map(tastingEvidence),
      },
    ];
  });
  const coverage: { key: string; label: string; items: Evidence[] }[] = [
    {
      key: "first-before-purchase",
      label: "첫 시음일이 구매일보다 빠름: 구매→첫 시음 간격 제외",
      items: firstSessions
        .filter((item) => item.days < 0)
        .map((item) => ({
          ...item,
          detail: `${item.detail} · 구매일보다 ${-item.days}일 이른 첫 시음`,
        })),
    },
    {
      key: "purchase-date",
      label: "구매일 미기록·오류: 기간 구매/지출/가격 비교 제외",
      items: purchases.filter((p) => !validDay(p.row.purchased_on)).map(purchaseEvidence),
    },
    {
      key: "disposal-date",
      label: "소진·증여·판매일 미기록·오류: 기간 사건 제외",
      items: bottles
        .filter(
          (b) =>
            ["finished", "gifted", "sold"].includes(str(b.bottle.status)) &&
            !validDay(b.bottle.finished_on),
        )
        .map((b) => evidence(b.product, b.sku, b.bottle)),
    },
    {
      key: "tasting-date",
      label: "시음일 미기록·오류: 기간 시음 제외",
      items: tastings.filter((t) => !validDay(t.row.tasted_on)).map(tastingEvidence),
    },
    {
      key: "opening-date",
      label: "개봉일 미기록·미래·오류: 경과일 제외",
      items: openBottles.filter((b) => b.openedDays === null),
    },
    {
      key: "remaining",
      label: "현재 잔량 미기록: 확인된 잔량 합계 제외",
      items: stock
        .filter((b) => remaining(b) === null)
        .map((b) => evidence(b.product, b.sku, b.bottle)),
    },
    {
      key: "volume",
      label: "규격 미등록·용량 미기록: 용량 분석 제한",
      items: products
        .filter(
          (p) =>
            ![...skuById.values()].some(
              (s) => s.product_id === p.id && (numeric(s.volume_ml) ?? 0) > 0,
            ),
        )
        .map((p) => evidence(p)),
    },
    {
      key: "product-rating",
      label: "제품 총평 미기록: 제품 평점 분포 제외",
      items: products.filter((p) => rating(p.personal_rating) === null).map((p) => evidence(p)),
    },
    {
      key: "session-rating",
      label: "선택 기간 시음 평점 없음: 세션 평점 분포 제외",
      items: periodTastings.filter((t) => rating(t.row.rating) === null).map(tastingEvidence),
    },
    {
      key: "zero-paid",
      label: "실구매가 0원·공란: 총액 포함, 유상 중앙값 제외",
      items: purchases.filter((p) => money(p.row.unit_paid_price).isZero()).map(purchaseEvidence),
    },
  ];
  // Orphans cannot be assigned to a category or current status without guessing.
  const allOwnedProducts = index(live(snapshot.products));
  const allOwnedSkus = index(
    live(snapshot.skus).filter((sku) => allOwnedProducts.has(str(sku.product_id))),
  );
  const allOwnedPurchases = index(
    live(snapshot.purchases).filter((p) => allOwnedSkus.has(str(p.sku_id))),
  );
  const allOwnedBottles = index(
    live(snapshot.bottles).filter((b) => allOwnedPurchases.has(str(b.purchase_id))),
  );
  const orphan = [
    ...live(snapshot.skus).filter((s) => !allOwnedSkus.has(s.id)),
    ...live(snapshot.purchases).filter((p) => !allOwnedPurchases.has(p.id)),
    ...live(snapshot.bottles).filter((b) => !allOwnedBottles.has(b.id)),
    ...live(snapshot.tastings).filter((t) => {
      if (!allOwnedSkus.has(str(t.sku_id))) return true;
      if (!t.bottle_id) return false;
      const bottle = allOwnedBottles.get(str(t.bottle_id));
      const purchase = bottle ? allOwnedPurchases.get(str(bottle.purchase_id)) : null;
      return !purchase || purchase.sku_id !== t.sku_id;
    }),
  ];
  coverage.push({
    key: "orphan",
    label: "부모 연결을 확인할 수 없는 기록: 전체 분석 제외 (필터 밖 포함)",
    items: orphan.map((row) => ({
      id: row.id,
      productId: null,
      label: "연결 확인 필요",
      detail: row.id,
    })),
  });
  return {
    today,
    inventory,
    period,
    previous,
    monthly,
    stockCategories,
    openBottles,
    aging,
    untried,
    firstTasting: {
      count: waits.length,
      medianDays: median(waits.map((w) => w.days)),
      evidence: waits,
    },
    prices,
    ratings,
    changes,
    coverage,
    recentTastings: [...periodTastings]
      .sort(
        (a, b) =>
          str(b.row.tasted_on).localeCompare(str(a.row.tasted_on)) ||
          b.row.id.localeCompare(a.row.id),
      )
      .map(tastingEvidence),
    categories: [...categories.values()]
      .map((c) => ({ id: c.id, label: categoryName(c.id) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}
