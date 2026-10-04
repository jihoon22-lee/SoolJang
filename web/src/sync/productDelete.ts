/**
 * 제품 삭제를 outbox 에 적재한다. 서버(`soft_delete_product`)처럼 하위 규격·구매·병도
 * 로컬에서 함께 지워, 동기화 전에도 재고·통계가 같은 결과를 보이게 한다. 하위 id 는
 * `touchedIds` 로 보호해 다음 pull 이 아직 살아 있는 서버 행으로 되돌리지 않는다.
 */

import { db } from "@/sync/db";
import { enqueue } from "@/sync/outbox";

export async function enqueueProductDelete(productId: string): Promise<void> {
  const skuIds = (await db.sku.where("product_id").equals(productId).toArray())
    .filter((row) => row.deleted_at === null)
    .map((row) => row.id);
  const purchaseIds = (await db.purchase.where("sku_id").anyOf(skuIds).toArray())
    .filter((row) => row.deleted_at === null)
    .map((row) => row.id);
  const bottleIds = (await db.bottle.where("purchase_id").anyOf(purchaseIds).toArray())
    .filter((row) => row.deleted_at === null)
    .map((row) => row.id);
  await enqueue({
    entity: "product",
    op: "delete",
    entityId: productId,
    fields: {},
    touchedIds: [...skuIds, ...purchaseIds, ...bottleIds],
    cascadeDeletes: [
      { entity: "sku", ids: skuIds },
      { entity: "purchase", ids: purchaseIds },
      { entity: "bottle", ids: bottleIds },
    ],
  });
}
