/**
 * Dexie 로컬 미러에서 화면이 쓰는 모양(`api/types.ts`)을 그대로 만들어 낸다.
 *
 * 오프라인에서도 제품 목록·주종 관리·병 관리·통계 화면이 동작해야 한다(사용자가 선택한
 * "전체 컬렉션 오프라인 탐색" 범위). `application/products.py`·`application/categories.py`
 * 의 필터·조인·롤업 로직을 TS 로 재구현하되, 파생 지표 계산 자체는 `domain/metrics.ts`
 * (Python `domain/metrics.py` 포팅)를 그대로 쓴다 — 공식이 세 번째로 흩어지지 않게 한다.
 *
 * 제품 규모가 수백 건이라 서버처럼 커서 페이지네이션을 하지 않는다. 전체를 메모리에 올려
 * 필터·정렬한다.
 */

import Decimal from "decimal.js";

import type {
  Bottle,
  CategoryNode,
  CategoryStat,
  CategoryTree,
  Product,
  ProductFilters,
  Purchase,
  RankingEntry,
  Rankings,
  SortKey,
  StatsSummary,
  Vendor,
} from "@/api/types";
import {
  averageDaysToFinish,
  type BottleTally,
  bottleTallyInStock,
  computePriceMetrics,
  computeProductMetrics,
  type BottleRecord as MetricsBottleRecord,
  type PriceMetrics,
  type PurchaseLot,
  purchaseLot,
  quantizeMoney,
  quantizeRatio,
  tallyBottles,
  valueForMoney,
} from "@/domain/metrics";
import { matchesQuery } from "@/search";
import { db, type SyncRow } from "@/sync/db";

//: 백엔드 `legacy/categories.py::MAX_CATEGORY_DEPTH` 와 같은 값.
const CATEGORY_DEPTH_LIMIT = 8;

function live(rows: SyncRow[]): SyncRow[] {
  return rows.filter((row) => row.deleted_at === null);
}

type LiveTableName =
  | "category"
  | "producer"
  | "variety"
  | "product"
  | "product_variety"
  | "sku"
  | "vendor"
  | "purchase"
  | "bottle";

async function liveTable(name: LiveTableName): Promise<SyncRow[]> {
  return live(await db.table(name).toArray());
}

// --- 주종 계층 ----------------------------------------------------------------

export async function getCategoryTree(): Promise<CategoryTree> {
  const rows = await liveTable("category");
  const products = await liveTable("product");
  const byId = new Map(rows.map((row) => [row.id, row]));

  function pathOf(id: string): string[] {
    const chain: string[] = [];
    let current: SyncRow | undefined = byId.get(id);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.unshift(current.name as string);
      current = current.parent_id ? byId.get(current.parent_id as string) : undefined;
    }
    return chain;
  }

  const directCounts = new Map<string, number>();
  for (const product of products) {
    const categoryId = product.category_id as string | null;
    if (!categoryId) continue;
    directCounts.set(categoryId, (directCounts.get(categoryId) ?? 0) + 1);
  }

  const childrenOf = new Map<string, string[]>();
  for (const row of rows) {
    const parentId = row.parent_id as string | null;
    if (!parentId) continue;
    const list = childrenOf.get(parentId) ?? [];
    list.push(row.id);
    childrenOf.set(parentId, list);
  }

  function descendantCount(id: string, seen: Set<string> = new Set()): number {
    if (seen.has(id)) return 0;
    seen.add(id);
    let total = directCounts.get(id) ?? 0;
    for (const child of childrenOf.get(id) ?? []) total += descendantCount(child, seen);
    return total;
  }

  const items: CategoryNode[] = rows
    .map((row) => {
      const path = pathOf(row.id);
      return {
        id: row.id,
        parent_id: (row.parent_id as string | null) ?? null,
        name: row.name as string,
        depth: path.length,
        path,
        is_seeded: Boolean(row.is_seeded),
        sort_order: row.sort_order as number,
        product_count: directCounts.get(row.id) ?? 0,
        descendant_product_count: descendantCount(row.id),
      };
    })
    // 이름순 정렬을 의도적으로 고정했다. `categoriesApi.reorder` 는 구현·테스트까지 돼
    // 있지만 호출처를 두지 않기로 했다(`docs/plan.md` §5 결정 로그) — 주종은 수십 개
    // 규모라 이름순으로도 원하는 항목을 바로 찾을 수 있고, 수동 순서를 도입하면 트리
    // UI에 위/아래 이동 버튼과 그 상태를 또 하나 얹어야 해 얻는 편의보다 복잡도가 크다.
    .sort((a, b) => a.path.join("").localeCompare(b.path.join("")));

  return {
    items,
    max_depth: items.reduce((max, item) => Math.max(max, item.depth), 0),
    depth_limit: CATEGORY_DEPTH_LIMIT,
  };
}

/** 카테고리 id → 자기 자신과 모든 후손 id 집합. "위스키" 필터가 하위를 포함해야 한다. */
async function descendantIdsOf(categoryId: string): Promise<Set<string>> {
  const rows = await liveTable("category");
  const childrenOf = new Map<string, string[]>();
  for (const row of rows) {
    const parentId = row.parent_id as string | null;
    if (!parentId) continue;
    const list = childrenOf.get(parentId) ?? [];
    list.push(row.id);
    childrenOf.set(parentId, list);
  }
  const result = new Set<string>([categoryId]);
  const stack = [categoryId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const child of childrenOf.get(current) ?? []) {
      if (!result.has(child)) {
        result.add(child);
        stack.push(child);
      }
    }
  }
  return result;
}

// --- 제품 -------------------------------------------------------------------

function toDecimalOrNull(value: unknown): Decimal | null {
  return value === null || value === undefined ? null : new Decimal(value as string);
}

interface ProductAssembly {
  row: SyncRow;
  skus: SyncRow[];
  lots: PurchaseLot[];
  bottles: MetricsBottleRecord[];
  /** 이 제품의 어느 규격이든 구매한 적 있는 구매처 id 들. `filters.vendor_id` 필터용이다. */
  vendorIds: Set<string>;
}

async function assembleProducts(): Promise<ProductAssembly[]> {
  const [products, skus, purchases, bottles] = await Promise.all([
    liveTable("product"),
    liveTable("sku"),
    liveTable("purchase"),
    liveTable("bottle"),
  ]);

  const skusByProduct = new Map<string, SyncRow[]>();
  for (const sku of skus) {
    const productId = sku.product_id as string;
    const list = skusByProduct.get(productId) ?? [];
    list.push(sku);
    skusByProduct.set(productId, list);
  }
  const purchasesBySku = new Map<string, SyncRow[]>();
  for (const purchase of purchases) {
    const skuId = purchase.sku_id as string;
    const list = purchasesBySku.get(skuId) ?? [];
    list.push(purchase);
    purchasesBySku.set(skuId, list);
  }
  const bottlesByPurchase = new Map<string, SyncRow[]>();
  for (const bottle of bottles) {
    const purchaseId = bottle.purchase_id as string;
    const list = bottlesByPurchase.get(purchaseId) ?? [];
    list.push(bottle);
    bottlesByPurchase.set(purchaseId, list);
  }

  return products.map((product) => {
    const productSkus = skusByProduct.get(product.id) ?? [];
    const lots: PurchaseLot[] = [];
    const bottleRecords: MetricsBottleRecord[] = [];
    const vendorIds = new Set<string>();

    for (const sku of productSkus) {
      const skuPurchases = purchasesBySku.get(sku.id) ?? [];
      for (const purchase of skuPurchases) {
        lots.push(
          purchaseLot(
            purchase.quantity as number,
            sku.volume_ml as number,
            toDecimalOrNull(purchase.unit_list_price),
            toDecimalOrNull(purchase.unit_paid_price),
          ),
        );
        const vendorId = purchase.vendor_id as string | null;
        if (vendorId) vendorIds.add(vendorId);
        for (const bottle of bottlesByPurchase.get(purchase.id) ?? []) {
          bottleRecords.push({
            status: bottle.status as string,
            openedOn: (bottle.opened_on as string | null) ?? null,
            finishedOn: (bottle.finished_on as string | null) ?? null,
          });
        }
      }
    }

    return { row: product, skus: productSkus, lots, bottles: bottleRecords, vendorIds };
  });
}

function toProduct(
  assembly: ProductAssembly,
  categoryPaths: Map<string, string[]>,
  producerNames: Map<string, string>,
  varietyNamesByProduct: Map<string, string[]>,
): Product {
  const { row, skus } = assembly;
  const metrics = computeProductMetrics(assembly.lots, assembly.bottles);
  const categoryId = row.category_id as string | null;
  const producerId = row.producer_id as string | null;
  const personalRating = row.personal_rating as string | null;

  return {
    id: row.id,
    name: row.name as string,
    name_en: (row.name_en as string | null) ?? null,
    category_id: categoryId,
    category_path: categoryId ? (categoryPaths.get(categoryId) ?? []) : [],
    producer_id: producerId,
    producer_name: producerId ? (producerNames.get(producerId) ?? null) : null,
    country: (row.country as string | null) ?? null,
    region: (row.region as string | null) ?? null,
    abv: (row.abv as string | null) ?? null,
    vintage: (row.vintage as number | null) ?? null,
    age_years: (row.age_years as string | null) ?? null,
    personal_rating: personalRating ?? null,
    note: (row.note as string | null) ?? null,
    varieties: varietyNamesByProduct.get(row.id) ?? [],
    created_at: row.created_at,
    updated_at: row.updated_at,
    skus: skus.map((sku) => ({
      id: sku.id,
      volume_ml: sku.volume_ml as number,
      barcode: (sku.barcode as string | null) ?? null,
      barcode_type: (sku.barcode_type as string | null) ?? null,
      package_note: (sku.package_note as string | null) ?? null,
    })),
    metrics: {
      purchased_count: metrics.prices.purchasedCount,
      consumed_count: metrics.bottles.finished,
      in_stock_count: bottleTallyInStock(metrics.bottles),
      unopened_count: metrics.bottles.unopened,
      opened_count: metrics.bottles.open,
      gifted_count: metrics.bottles.gifted,
      sold_count: metrics.bottles.sold,
      avg_list_price: metrics.prices.avgListPrice?.toFixed(2) ?? null,
      avg_paid_price: metrics.prices.avgPaidPrice?.toFixed(2) ?? null,
      price_per_100ml: metrics.prices.pricePer100ml?.toFixed(2) ?? null,
      price_per_100ml_paid: metrics.prices.pricePer100mlPaid?.toFixed(2) ?? null,
      list_total: metrics.prices.listTotal?.toFixed(2) ?? null,
      paid_total: metrics.prices.paidTotal?.toFixed(2) ?? null,
      discount_rate: metrics.prices.discountRate?.toFixed(4) ?? null,
      total_volume_ml: metrics.prices.totalVolumeMl,
      inventory_value_at_cost: metrics.inventoryValueAtCost?.toFixed(2) ?? null,
      value_for_money:
        valueForMoney(
          personalRating ? new Decimal(personalRating) : null,
          metrics.prices.pricePer100ml,
        )?.toFixed(4) ?? null,
    },
  };
}

async function categoryPathMap(): Promise<Map<string, string[]>> {
  const tree = await getCategoryTree();
  return new Map(tree.items.map((node) => [node.id, node.path]));
}

async function producerNameMap(): Promise<Map<string, string>> {
  const producers = await liveTable("producer");
  return new Map(producers.map((row) => [row.id, row.name as string]));
}

async function varietyNameMap(): Promise<Map<string, string[]>> {
  const [links, varieties] = await Promise.all([
    liveTable("product_variety"),
    liveTable("variety"),
  ]);
  const varietyName = new Map(varieties.map((row) => [row.id, row.name as string]));
  const result = new Map<string, string[]>();
  for (const link of links.sort((a, b) => (a.sort_order as number) - (b.sort_order as number))) {
    const name = varietyName.get(link.variety_id as string);
    if (!name) continue;
    const productId = link.product_id as string;
    const list = result.get(productId) ?? [];
    list.push(name);
    result.set(productId, list);
  }
  return result;
}

function matchesText(product: Product, query: string): boolean {
  if (!query.trim()) return true;
  return (
    matchesQuery(product.name, query) ||
    (product.name_en !== null && matchesQuery(product.name_en, query))
  );
}

const SORT_ACCESSORS: Record<SortKey, (p: Product) => number | string | null> = {
  name: (p) => p.name,
  // ISO 8601 문자열은 사전식 비교가 시간순 비교와 같다 — 별도 Date 변환 없이 그대로
  // `<`/`>` 로 비교할 수 있다. 예전엔 이 두 접근자가 항상 `null` 을 돌려줘 정렬이
  // 조용히 id(UUIDv7, 생성 시각순) 순으로 폴백했다 — "등록일" 을 골라도 아무 효과가
  // 없었고, 그 폴백이 오름/내림 방향 반전 전에 끝나 방향 토글도 무효했다.
  created_at: (p) => p.created_at,
  updated_at: (p) => p.updated_at,
  abv: (p) => (p.abv !== null ? Number(p.abv) : null),
  vintage: (p) => p.vintage,
  personal_rating: (p) => (p.personal_rating !== null ? Number(p.personal_rating) : null),
  avg_list_price: (p) =>
    p.metrics.avg_list_price !== null ? Number(p.metrics.avg_list_price) : null,
  avg_paid_price: (p) =>
    p.metrics.avg_paid_price !== null ? Number(p.metrics.avg_paid_price) : null,
  price_per_100ml: (p) =>
    p.metrics.price_per_100ml !== null ? Number(p.metrics.price_per_100ml) : null,
  paid_total: (p) => (p.metrics.paid_total !== null ? Number(p.metrics.paid_total) : null),
  in_stock_count: (p) => p.metrics.in_stock_count,
  purchased_count: (p) => p.metrics.purchased_count,
};

/** 오프라인 제품 목록. `docs/architecture.md` §4.3 필터 규약을 따른다(전부 AND). */
export async function getProducts(filters: ProductFilters): Promise<Product[]> {
  const [assemblies, categoryPaths, producerNames, varietyNames] = await Promise.all([
    assembleProducts(),
    categoryPathMap(),
    producerNameMap(),
    varietyNameMap(),
  ]);

  let products = assemblies.map((assembly) =>
    toProduct(assembly, categoryPaths, producerNames, varietyNames),
  );

  if (filters.q) {
    products = products.filter((p) => matchesText(p, filters.q as string));
  }
  if (filters.vendor_id) {
    const vendorId = filters.vendor_id;
    const vendorIdsByProduct = new Map(assemblies.map((a) => [a.row.id as string, a.vendorIds]));
    products = products.filter((p) => vendorIdsByProduct.get(p.id)?.has(vendorId) ?? false);
  }
  if (filters.category_id) {
    const includeDescendants = filters.include_descendants !== false;
    const scope = includeDescendants
      ? await descendantIdsOf(filters.category_id)
      : new Set([filters.category_id]);
    products = products.filter((p) => p.category_id !== null && scope.has(p.category_id));
  }
  if (filters.country) {
    products = products.filter((p) => p.country === filters.country);
  }
  if (filters.abv_min !== undefined) {
    const min = Number(filters.abv_min);
    products = products.filter((p) => p.abv !== null && Number(p.abv) >= min);
  }
  if (filters.abv_max !== undefined) {
    const max = Number(filters.abv_max);
    products = products.filter((p) => p.abv !== null && Number(p.abv) <= max);
  }
  if (filters.vintage_min !== undefined) {
    products = products.filter(
      (p) => p.vintage !== null && p.vintage >= (filters.vintage_min as number),
    );
  }
  if (filters.vintage_max !== undefined) {
    products = products.filter(
      (p) => p.vintage !== null && p.vintage <= (filters.vintage_max as number),
    );
  }
  if (filters.rating_min !== undefined) {
    const min = Number(filters.rating_min);
    products = products.filter(
      (p) => p.personal_rating !== null && Number(p.personal_rating) >= min,
    );
  }
  if (filters.in_stock === true) {
    products = products.filter((p) => p.metrics.in_stock_count > 0);
  } else if (filters.in_stock === false) {
    products = products.filter((p) => p.metrics.in_stock_count === 0);
  }
  if (filters.variety) {
    const needle = filters.variety.toLowerCase();
    products = products.filter((p) =>
      p.varieties.some((name) => name.toLowerCase().includes(needle)),
    );
  }
  if (filters.price_per_100ml_min !== undefined) {
    const min = Number(filters.price_per_100ml_min);
    products = products.filter(
      (p) => p.metrics.price_per_100ml !== null && Number(p.metrics.price_per_100ml) >= min,
    );
  }
  if (filters.price_per_100ml_max !== undefined) {
    const max = Number(filters.price_per_100ml_max);
    products = products.filter(
      (p) => p.metrics.price_per_100ml !== null && Number(p.metrics.price_per_100ml) <= max,
    );
  }

  const sortKey = filters.sort ?? "name";
  const order = filters.order ?? "asc";
  const accessor = SORT_ACCESSORS[sortKey];
  products.sort((a, b) => {
    const av = accessor(a);
    const bv = accessor(b);
    if (av === null && bv === null) return a.id.localeCompare(b.id);
    if (av === null) return 1;
    if (bv === null) return -1;
    const cmp = av < bv ? -1 : av > bv ? 1 : a.id.localeCompare(b.id);
    return order === "asc" ? cmp : -cmp;
  });

  return products;
}

export async function getProduct(productId: string): Promise<Product | null> {
  const products = await getProducts({});
  return products.find((p) => p.id === productId) ?? null;
}

export async function getPurchasesForProduct(productId: string): Promise<Purchase[]> {
  const [skus, purchases, vendors, bottles] = await Promise.all([
    liveTable("sku"),
    liveTable("purchase"),
    liveTable("vendor"),
    liveTable("bottle"),
  ]);
  const skuIds = new Set(skus.filter((s) => s.product_id === productId).map((s) => s.id));
  const skuById = new Map(skus.map((s) => [s.id, s]));
  const vendorById = new Map(vendors.map((v) => [v.id, v]));
  const bottleCountByPurchase = new Map<string, number>();
  for (const bottle of bottles) {
    const purchaseId = bottle.purchase_id as string;
    bottleCountByPurchase.set(purchaseId, (bottleCountByPurchase.get(purchaseId) ?? 0) + 1);
  }

  return purchases
    .filter((p) => skuIds.has(p.sku_id as string))
    .map((p) => {
      const sku = skuById.get(p.sku_id as string);
      const vendorId = p.vendor_id as string | null;
      const vendor = vendorId ? vendorById.get(vendorId) : undefined;
      const quantity = p.quantity as number;
      const unitList = toDecimalOrNull(p.unit_list_price);
      const unitPaid = toDecimalOrNull(p.unit_paid_price);
      return {
        id: p.id,
        sku_id: p.sku_id as string,
        volume_ml: (sku?.volume_ml as number | undefined) ?? null,
        vendor_id: vendorId,
        vendor_name: vendor ? (vendor.name as string) : null,
        purchased_on: (p.purchased_on as string | null) ?? null,
        quantity,
        unit_list_price: (p.unit_list_price as string | null) ?? null,
        unit_paid_price: (p.unit_paid_price as string | null) ?? null,
        list_total: unitList ? unitList.times(quantity).toFixed(2) : null,
        paid_total: unitPaid ? unitPaid.times(quantity).toFixed(2) : null,
        currency: p.currency as string,
        fx_rate: (p.fx_rate as string | null) ?? null,
        foreign_unit_price: (p.foreign_unit_price as string | null) ?? null,
        discount_note: (p.discount_note as string | null) ?? null,
        import_note: (p.import_note as string | null) ?? null,
        bottle_count: bottleCountByPurchase.get(p.id) ?? 0,
      };
    });
}

// --- 병 ---------------------------------------------------------------------

export async function getBottles(params: {
  status?: string;
  in_stock?: boolean;
}): Promise<Bottle[]> {
  let bottles = await liveTable("bottle");
  if (params.status) {
    bottles = bottles.filter((row) => row.status === params.status);
  } else if (params.in_stock) {
    bottles = bottles.filter((row) => row.status === "unopened" || row.status === "open");
  }
  return bottles.map((row) => ({
    id: row.id,
    purchase_id: row.purchase_id as string,
    label_no: row.label_no as number,
    status: row.status as Bottle["status"],
    opened_on: (row.opened_on as string | null) ?? null,
    finished_on: (row.finished_on as string | null) ?? null,
    remaining_ml: (row.remaining_ml as number | null) ?? null,
    storage_location: (row.storage_location as string | null) ?? null,
    note: (row.note as string | null) ?? null,
  }));
}

/**
 * 한 제품의 병만 모아 반환한다. "병 관리" 가 별도 탭이던 시절엔 전체 병을 평면 목록으로
 * 보여줬는데, 무슨 술인지 알 수 없다는 문제가 있었다 — 제품 상세 안으로 통합하면서
 * 애초에 제품 문맥 안에서만 병을 보여주게 됐다(Task 22). `getPurchasesForProduct` 와
 * 같은 sku → purchase → bottle 조인 패턴을 그대로 쓰되 방향만 반대다.
 */
export async function getBottlesForProduct(productId: string): Promise<Bottle[]> {
  const [skus, purchases, bottles] = await Promise.all([
    liveTable("sku"),
    liveTable("purchase"),
    liveTable("bottle"),
  ]);
  const skuIds = new Set(skus.filter((s) => s.product_id === productId).map((s) => s.id));
  const purchaseIds = new Set(
    purchases.filter((p) => skuIds.has(p.sku_id as string)).map((p) => p.id),
  );

  return bottles
    .filter((row) => purchaseIds.has(row.purchase_id as string))
    .map((row) => ({
      id: row.id,
      purchase_id: row.purchase_id as string,
      label_no: row.label_no as number,
      status: row.status as Bottle["status"],
      opened_on: (row.opened_on as string | null) ?? null,
      finished_on: (row.finished_on as string | null) ?? null,
      remaining_ml: (row.remaining_ml as number | null) ?? null,
      storage_location: (row.storage_location as string | null) ?? null,
      note: (row.note as string | null) ?? null,
    }));
}

// --- 구매처 -----------------------------------------------------------------

export async function getVendors(): Promise<Vendor[]> {
  const [vendors, purchases] = await Promise.all([liveTable("vendor"), liveTable("purchase")]);
  const counts = new Map<string, number>();
  const spend = new Map<string, Decimal>();
  for (const purchase of purchases) {
    const vendorId = purchase.vendor_id as string | null;
    if (!vendorId) continue;
    counts.set(vendorId, (counts.get(vendorId) ?? 0) + 1);

    // 실구매가가 있으면 그걸, 없으면 정가로 보충한다 — 둘 다 없으면 이 구매 건은 합계에서
    // 빠진다("0 원 지출" 과 "가격 정보 없음" 을 구분한다, D35 와 같은 원칙).
    const quantity = purchase.quantity as number;
    const unitPaid = toDecimalOrNull(purchase.unit_paid_price);
    const unitList = toDecimalOrNull(purchase.unit_list_price);
    const unitPrice = unitPaid ?? unitList;
    if (unitPrice === null) continue;
    const current = spend.get(vendorId) ?? new Decimal(0);
    spend.set(vendorId, current.plus(unitPrice.times(quantity)));
  }
  return vendors.map((row) => ({
    id: row.id,
    name: row.name as string,
    kind: row.kind as Vendor["kind"],
    url: (row.url as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    purchase_count: counts.get(row.id) ?? 0,
    total_spend: spend.get(row.id)?.toFixed(2) ?? null,
  }));
}

// --- 통계 --------------------------------------------------------------------
//
// `application/stats.py` 를 그대로 옮긴다. 랭킹·주종별 집계·전체 합계 모두 제품별 한 행
// (`StatsRow`)에서 파생하며, 이 행의 가격 지표는 `computePriceMetrics` 를 그대로 쓴다 —
// SQL 의 `product_price_metrics_query` 와 같은 규칙(product_price_metrics_query 의
// docstring 참고)을 domain 함수로 재사용하는 셈이다.

const UNCATEGORIZED_LABEL = "미분류";
const DEFAULT_RANKING_LIMIT = 10;

interface StatsRow {
  productId: string;
  productName: string;
  categoryId: string | null;
  abv: string | null;
  personalRating: string | null;
  prices: PriceMetrics;
  tally: BottleTally;
  bottles: MetricsBottleRecord[];
}

async function statsRows(): Promise<{ rows: StatsRow[]; vendorIds: Set<string> }> {
  const assemblies = await assembleProducts();
  const liveSkuIds = new Set(assemblies.flatMap((assembly) => assembly.skus.map((sku) => sku.id)));
  const purchases = await liveTable("purchase");

  const vendorIds = new Set<string>();
  for (const purchase of purchases) {
    if (!liveSkuIds.has(purchase.sku_id as string)) continue;
    const vendorId = purchase.vendor_id as string | null;
    if (vendorId) vendorIds.add(vendorId);
  }

  const rows: StatsRow[] = assemblies.map((assembly) => ({
    productId: assembly.row.id,
    productName: assembly.row.name as string,
    categoryId: (assembly.row.category_id as string | null) ?? null,
    abv: (assembly.row.abv as string | null) ?? null,
    personalRating: (assembly.row.personal_rating as string | null) ?? null,
    prices: computePriceMetrics(assembly.lots),
    tally: tallyBottles(assembly.bottles),
    bottles: assembly.bottles,
  }));

  return { rows, vendorIds };
}

function sumDecimal(values: readonly (Decimal | null)[]): Decimal | null {
  let total = new Decimal(0);
  let found = false;
  for (const value of values) {
    if (value === null) continue;
    found = true;
    total = total.plus(value);
  }
  return found ? total : null;
}

/** None 을 건너뛴 평균. Python `_mean` 과 같이 4자리로 quantize 한다(비율·평점 공용). */
function mean(values: readonly (Decimal | null)[]): Decimal | null {
  const items = values.filter((value): value is Decimal => value !== null);
  if (items.length === 0) return null;
  const total = items.reduce((sum, value) => sum.plus(value), new Decimal(0));
  return quantizeRatio(total.dividedBy(items.length));
}

/** 정가·실구매가 총액 합계로부터 할인율. 정가와 실구매가가 모두 있는 건만의 합계여야 한다. */
function aggregateDiscountRate(
  discountListTotal: Decimal | null,
  discountPaidTotal: Decimal | null,
): Decimal | null {
  if (discountListTotal === null || discountListTotal.isZero() || discountPaidTotal === null) {
    return null;
  }
  return quantizeRatio(new Decimal(1).minus(discountPaidTotal.dividedBy(discountListTotal)));
}

/** 금액 합계 ÷ 용량(ml) × 100. 분모로 `list_volume`(정가 기준)과 `total_volume_ml`(전체)
 * 중 무엇을 쓰는지가 주종별 집계와 전체 합계에서 서로 다르다 — 호출부에서 정한다. */
function moneyPer100ml(amount: Decimal | null, volumeMl: number): Decimal | null {
  return amount !== null && volumeMl > 0
    ? quantizeMoney(amount.times(100).dividedBy(volumeMl))
    : null;
}

function topAncestorMap(tree: CategoryTree): Map<string, CategoryNode> {
  const byId = new Map(tree.items.map((node) => [node.id, node]));
  const result = new Map<string, CategoryNode>();
  for (const node of tree.items) {
    let top = node;
    while (top.parent_id !== null) {
      const parent = byId.get(top.parent_id);
      if (!parent) break;
      top = parent;
    }
    result.set(node.id, top);
  }
  return result;
}

export async function getStatsRankings(limit = DEFAULT_RANKING_LIMIT): Promise<Rankings> {
  const { rows } = await statsRows();

  function top(keyFn: (row: StatsRow) => Decimal | null): { row: StatsRow; value: Decimal }[] {
    return rows
      .map((row) => ({ row, value: keyFn(row) }))
      .filter(
        (candidate): candidate is { row: StatsRow; value: Decimal } => candidate.value !== null,
      )
      .sort((a, b) => {
        const cmp = b.value.comparedTo(a.value);
        return cmp !== 0 ? cmp : a.row.productId.localeCompare(b.row.productId);
      })
      .slice(0, limit);
  }

  function toEntries(
    candidates: { row: StatsRow; value: Decimal }[],
    decimals: number,
  ): RankingEntry[] {
    return candidates.map((candidate) => ({
      product_id: candidate.row.productId,
      product_name: candidate.row.productName,
      value: candidate.value.toFixed(decimals),
    }));
  }

  return {
    by_bottle_price: toEntries(
      top((row) => row.prices.avgPaidPrice),
      2,
    ),
    by_total_spend: toEntries(
      top((row) => row.prices.paidTotal),
      2,
    ),
    by_price_per_100ml: toEntries(
      top((row) => row.prices.pricePer100ml),
      2,
    ),
    by_personal_rating: toEntries(
      top((row) => (row.personalRating !== null ? new Decimal(row.personalRating) : null)),
      1,
    ),
    by_value_for_money: toEntries(
      top((row) => valueForMoneyOf(row)),
      2,
    ),
  };
}

/** 평점 대비 가격(가성비). 랭킹·전체 합계 양쪽에서 같은 규칙을 쓰도록 뽑아 둔다. */
function valueForMoneyOf(row: StatsRow): Decimal | null {
  const rating = row.personalRating !== null ? new Decimal(row.personalRating) : null;
  return valueForMoney(rating, row.prices.pricePer100ml);
}

/** 주종별 집계. 하위 카테고리는 최상위 주종으로 롤업한다. */
export async function getCategoryRollup(): Promise<CategoryStat[]> {
  const { rows } = await statsRows();
  const tree = await getCategoryTree();
  const topOf = topAncestorMap(tree);

  const groups = new Map<string | null, StatsRow[]>();
  const names = new Map<string | null, string>();
  for (const row of rows) {
    const top = row.categoryId !== null ? topOf.get(row.categoryId) : undefined;
    const key = top?.id ?? null;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
    names.set(key, top?.name ?? UNCATEGORIZED_LABEL);
  }

  const stats: CategoryStat[] = Array.from(groups.entries()).map(([categoryId, groupRows]) => {
    const bottleCount = groupRows.reduce((sum, row) => sum + row.prices.purchasedCount, 0);
    const listTotal = sumDecimal(groupRows.map((row) => row.prices.listTotal));
    const listVolume = groupRows.reduce((sum, row) => sum + row.prices.listVolume, 0);
    const discountListTotal = sumDecimal(groupRows.map((row) => row.prices.discountListTotal));
    const discountPaidTotal = sumDecimal(groupRows.map((row) => row.prices.discountPaidTotal));

    return {
      category_id: categoryId,
      name: names.get(categoryId) ?? UNCATEGORIZED_LABEL,
      bottle_count: bottleCount,
      total_spend: listTotal !== null ? quantizeMoney(listTotal).toFixed(2) : null,
      avg_abv:
        mean(groupRows.map((row) => (row.abv !== null ? new Decimal(row.abv) : null)))?.toFixed(
          4,
        ) ?? null,
      avg_rating:
        mean(
          groupRows.map((row) =>
            row.personalRating !== null ? new Decimal(row.personalRating) : null,
          ),
        )?.toFixed(4) ?? null,
      avg_price_per_100ml: moneyPer100ml(listTotal, listVolume)?.toFixed(2) ?? null,
      discount_rate:
        aggregateDiscountRate(discountListTotal, discountPaidTotal)?.toFixed(4) ?? null,
    };
  });

  stats.sort((a, b) =>
    b.bottle_count !== a.bottle_count
      ? b.bottle_count - a.bottle_count
      : a.name.localeCompare(b.name),
  );
  return stats;
}

/** 전체 합계. 평균의 분모는 전체 병수·전체 용량이다(가격이 있는 구매 건만이 아니다) —
 * 가격 없는 선물 병도 "컬렉션 전체 평균"에는 한 병으로 들어가야 한다. */
export async function getStatsSummary(): Promise<StatsSummary> {
  const { rows, vendorIds } = await statsRows();

  const purchasedCount = rows.reduce((sum, row) => sum + row.prices.purchasedCount, 0);
  const totalVolumeMl = rows.reduce((sum, row) => sum + row.prices.totalVolumeMl, 0);
  const listTotal = sumDecimal(rows.map((row) => row.prices.listTotal));
  const paidTotal = sumDecimal(rows.map((row) => row.prices.paidTotal));
  const discountListTotal = sumDecimal(rows.map((row) => row.prices.discountListTotal));
  const discountPaidTotal = sumDecimal(rows.map((row) => row.prices.discountPaidTotal));

  const avgListPrice =
    listTotal !== null && purchasedCount > 0
      ? quantizeMoney(listTotal.dividedBy(purchasedCount))
      : null;
  const avgPaidPrice =
    paidTotal !== null && purchasedCount > 0
      ? quantizeMoney(paidTotal.dividedBy(purchasedCount))
      : null;

  return {
    purchased_count: purchasedCount,
    consumed_count: rows.reduce((sum, row) => sum + row.tally.finished, 0),
    in_stock_count: rows.reduce((sum, row) => sum + bottleTallyInStock(row.tally), 0),
    unopened_count: rows.reduce((sum, row) => sum + row.tally.unopened, 0),
    opened_count: rows.reduce((sum, row) => sum + row.tally.open, 0),
    total_volume_ml: totalVolumeMl,
    list_total: listTotal !== null ? quantizeMoney(listTotal).toFixed(2) : null,
    paid_total: paidTotal !== null ? quantizeMoney(paidTotal).toFixed(2) : null,
    avg_list_price: avgListPrice?.toFixed(2) ?? null,
    avg_paid_price: avgPaidPrice?.toFixed(2) ?? null,
    avg_price_per_100ml: moneyPer100ml(listTotal, totalVolumeMl)?.toFixed(2) ?? null,
    discount_rate: aggregateDiscountRate(discountListTotal, discountPaidTotal)?.toFixed(4) ?? null,
    avg_personal_rating:
      mean(
        rows.map((row) => (row.personalRating !== null ? new Decimal(row.personalRating) : null)),
      )?.toFixed(4) ?? null,
    vendor_count: vendorIds.size,
    gifted_count: rows.reduce((sum, row) => sum + row.tally.gifted, 0),
    sold_count: rows.reduce((sum, row) => sum + row.tally.sold, 0),
    avg_days_to_finish: averageDaysToFinish(rows.flatMap((row) => row.bottles))?.toFixed(2) ?? null,
    avg_value_for_money: mean(rows.map((row) => valueForMoneyOf(row)))?.toFixed(4) ?? null,
  };
}
