import type { ProductContext } from "@/router";
import { databaseIdentity, db, type SyncRow } from "@/sync/db";

/** URL 자체를 신뢰하지 않고 현재 계정의 살아 있는 원본 연결을 따라간다. */
export async function resolveProductContext(
  productId: string,
  context: ProductContext,
): Promise<ProductContext | null> {
  if (!context.skuId && !context.bottleId && !context.tastingId) return {};
  const identity = databaseIdentity();
  const store = db;
  const liveOwned = (row: SyncRow | undefined): row is SyncRow =>
    Boolean(row && row.deleted_at === null && row.user_id === identity.userId);
  const product = await store.product.get(productId);
  if (!liveOwned(product)) return null;
  let { skuId, bottleId } = context;
  if (context.tastingId) {
    const tasting = await store.tasting_session.get(context.tastingId);
    if (!liveOwned(tasting)) return null;
    if (skuId && skuId !== tasting.sku_id) return null;
    if (bottleId && bottleId !== tasting.bottle_id) return null;
    skuId = String(tasting.sku_id);
    bottleId = tasting.bottle_id ? String(tasting.bottle_id) : undefined;
  }
  if (bottleId) {
    const bottle = await store.bottle.get(bottleId);
    if (!liveOwned(bottle)) return null;
    const purchase = await store.purchase.get(String(bottle.purchase_id));
    if (!liveOwned(purchase) || (skuId && skuId !== purchase.sku_id)) return null;
    skuId = String(purchase.sku_id);
  }
  const sku = skuId ? await store.sku.get(skuId) : undefined;
  if (!liveOwned(sku) || sku.product_id !== productId) return null;
  if (databaseIdentity().generation !== identity.generation || db !== store) return null;
  return { skuId, bottleId, tastingId: context.tastingId };
}
