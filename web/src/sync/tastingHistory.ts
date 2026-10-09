import Decimal from "decimal.js";
import type {
  BottleSnapshot,
  BottleStatus,
  ContextualTasting,
  CorrectionBottleOption,
  ProductSkuContext,
  PurchaseContext,
  TastingFilters,
  TastingSummary,
} from "@/api/types";
import { databaseIdentity, db, type SyncRow } from "@/sync/db";

const textOrNull = (value: unknown): string | null => (value == null ? null : String(value));
const numberOrNull = (value: unknown): number | null => (value == null ? null : Number(value));
const statuses = new Set(["unopened", "open", "finished", "gifted", "sold"]);

async function readLocalContext() {
  const identity = databaseIdentity();
  const store = db;
  const tables = [
    store.product,
    store.sku,
    store.purchase,
    store.bottle,
    store.vendor,
    store.tasting_session,
  ];
  const [products, skus, purchases, bottles, vendors, tastings] = await store.transaction(
    "r",
    tables,
    () =>
      Promise.all(
        tables.map((table) =>
          table
            .filter(
              (row) =>
                Boolean(identity.userId) &&
                row.user_id === identity.userId &&
                row.deleted_at === null,
            )
            .toArray(),
        ),
      ),
  );
  if (
    db !== store ||
    databaseIdentity().generation !== identity.generation ||
    databaseIdentity().userId !== identity.userId
  )
    throw new Error("계정이 변경되어 기록 조회를 중단했습니다.");
  const productById = new Map(products?.map((row) => [row.id, row]));
  const skuContexts = new Map<string, ProductSkuContext>();
  for (const sku of skus ?? []) {
    const product = productById.get(String(sku.product_id));
    if (!product) continue;
    skuContexts.set(sku.id, {
      product_id: product.id,
      product_name: String(product.name),
      vintage: numberOrNull(product.vintage),
      age_years: textOrNull(product.age_years),
      abv: textOrNull(product.abv),
      sku_id: sku.id,
      volume_ml: Number(sku.volume_ml),
    });
  }
  const vendorById = new Map(vendors?.map((row) => [row.id, row]));
  const purchaseContexts = new Map<string, PurchaseContext>();
  for (const purchase of purchases ?? []) {
    if (!skuContexts.has(String(purchase.sku_id))) continue;
    purchaseContexts.set(purchase.id, {
      id: purchase.id,
      updated_at: purchase.updated_at,
      sku_id: String(purchase.sku_id),
      purchased_on: textOrNull(purchase.purchased_on),
      vendor_id: textOrNull(purchase.vendor_id),
      vendor_name: textOrNull(vendorById.get(String(purchase.vendor_id))?.name),
      quantity: Number(purchase.quantity),
    });
  }
  const bottleOptions = new Map<string, CorrectionBottleOption>();
  for (const bottle of bottles ?? []) {
    const purchase = purchaseContexts.get(String(bottle.purchase_id));
    const context = purchase ? skuContexts.get(purchase.sku_id) : undefined;
    if (!purchase || !context || !statuses.has(String(bottle.status))) continue;
    const snapshot: BottleSnapshot = {
      id: bottle.id,
      revision: String(bottle.revision ?? ""),
      purchase_id: purchase.id,
      label_no: Number(bottle.label_no),
      status: bottle.status as BottleStatus,
      remaining_ml: numberOrNull(bottle.remaining_ml),
      opened_on: textOrNull(bottle.opened_on),
      finished_on: textOrNull(bottle.finished_on),
      deleted_at: null,
    };
    bottleOptions.set(bottle.id, { context, purchase, bottle: snapshot });
  }
  return { skuContexts, bottleOptions, tastings: tastings ?? [] };
}

type LocalContext = Awaited<ReturnType<typeof readLocalContext>>;
function contextualTasting(row: SyncRow, data: LocalContext): ContextualTasting | null {
  const context = data.skuContexts.get(String(row.sku_id));
  if (!context) return null;
  const bottleId = textOrNull(row.bottle_id);
  const linked = bottleId ? data.bottleOptions.get(bottleId) : undefined;
  if (bottleId && !linked) return null;
  return {
    id: row.id,
    updated_at: row.updated_at,
    sku_id: context.sku_id,
    bottle_id: bottleId,
    tasted_on: String(row.tasted_on),
    poured_ml: numberOrNull(row.poured_ml),
    rating: textOrNull(row.rating),
    nose: textOrNull(row.nose),
    palate: textOrNull(row.palate),
    finish: textOrNull(row.finish),
    note: textOrNull(row.note),
    place: textOrNull(row.place),
    companions: textOrNull(row.companions),
    context,
    purchase: linked?.purchase ?? null,
    bottle: linked?.bottle ?? null,
  };
}

/** 정정 대상 선택은 소진·증여·판매를 포함한다. 제출에는 별도 최신 서버 snapshot을 쓴다. */
export async function getCorrectionOptions(): Promise<{
  bottles: CorrectionBottleOption[];
  skus: ProductSkuContext[];
}> {
  const data = await readLocalContext();
  const skus = [...data.skuContexts.values()].sort(
    (a, b) =>
      a.product_name.localeCompare(b.product_name, "ko") ||
      (a.vintage ?? 0) - (b.vintage ?? 0) ||
      a.volume_ml - b.volume_ml,
  );
  const order = new Map(skus.map((sku, index) => [sku.sku_id, index]));
  const bottles = [...data.bottleOptions.values()].sort(
    (a, b) =>
      (order.get(a.context.sku_id) ?? 0) - (order.get(b.context.sku_id) ?? 0) ||
      a.purchase.id.localeCompare(b.purchase.id) ||
      a.bottle.label_no - b.bottle.label_no,
  );
  return { bottles, skus };
}

function summarize(items: ContextualTasting[]): TastingSummary {
  const rated = items.filter((item) => item.rating !== null);
  const first = rated.at(-1)?.rating ?? null;
  const latest = rated[0]?.rating ?? null;
  return {
    session_count: items.length,
    rated_count: rated.length,
    average_rating: rated.length
      ? rated
          .reduce((sum, item) => sum.plus(item.rating ?? 0), new Decimal(0))
          .div(rated.length)
          .toFixed(2, Decimal.ROUND_HALF_EVEN)
      : null,
    first_rating: first,
    latest_rating: latest,
    rating_change:
      first !== null && latest !== null ? new Decimal(latest).minus(first).toString() : null,
    total_poured_ml: items.reduce((sum, item) => sum + (item.poured_ml ?? 0), 0),
    first_tasted_on: items.at(-1)?.tasted_on ?? null,
    latest_tasted_on: items[0]?.tasted_on ?? null,
  };
}

export async function getLocalTastingHistory(filters: TastingFilters): Promise<{
  items: ContextualTasting[];
  summary: TastingSummary;
}> {
  if (
    filters.tasted_on_min &&
    filters.tasted_on_max &&
    filters.tasted_on_min > filters.tasted_on_max
  )
    throw new Error("시음 시작일은 종료일보다 늦을 수 없습니다.");
  const data = await readLocalContext();
  const items = data.tastings
    .map((row) => contextualTasting(row, data))
    .filter(
      (item): item is ContextualTasting =>
        item !== null &&
        (!filters.product_id || item.context.product_id === filters.product_id) &&
        (!filters.sku_id || item.sku_id === filters.sku_id) &&
        (!filters.bottle_id || item.bottle_id === filters.bottle_id) &&
        (!filters.tasted_on_min || item.tasted_on >= filters.tasted_on_min) &&
        (!filters.tasted_on_max || item.tasted_on <= filters.tasted_on_max),
    )
    .sort((a, b) =>
      a.tasted_on !== b.tasted_on
        ? a.tasted_on > b.tasted_on
          ? -1
          : 1
        : a.id === b.id
          ? 0
          : a.id > b.id
            ? -1
            : 1,
    );
  return { items, summary: summarize(items) };
}

export async function getLocalTasting(id: string): Promise<ContextualTasting | null> {
  const data = await readLocalContext();
  const row = data.tastings.find((item) => item.id === id);
  return row ? contextualTasting(row, data) : null;
}
