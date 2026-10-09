import { beforeEach, describe, expect, it } from "vitest";
import type { ProductFilters } from "@/api/types";
import { hasPurchaseScope } from "@/purchaseScope";
import { activateDatabase, db } from "@/sync/db";
import { getProducts } from "@/sync/queries";
import fixture from "../../../tests/fixtures/purchase_filter_cases.json";

const row = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  user_id: "purchase-scope",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
  ...fields,
});
for (const dataset of fixture.datasets) {
  describe(dataset.name, () => {
    beforeEach(async () => {
      await activateDatabase("purchase-scope");
      for (const table of db.tables) await table.clear();
      await db.vendor.bulkPut(
        dataset.vendors.map((vendor) => row(vendor.vendor_id, { name: vendor.name })),
      );
      for (const product of dataset.products) {
        await db.product.put(row(product.product_id, { name: product.name }));
        await db.sku.bulkPut(
          product.skus.map((sku) =>
            row(sku.sku_id, { product_id: product.product_id, volume_ml: sku.volume_ml }),
          ),
        );
        await db.purchase.bulkPut(product.lots.map((lot) => row(lot.purchase_id, { ...lot })));
        await db.bottle.bulkPut(
          product.bottles.map((bottle) => row(bottle.bottle_id, { ...bottle })),
        );
      }
    });
    for (const query of dataset.queries) {
      it(query.name, async () => {
        const filters = query.filters as ProductFilters;
        const products = await getProducts(filters);
        expect(products.map((product) => product.id)).toEqual(query.expected_ids);
        for (const product of products) {
          if (hasPurchaseScope(filters)) expect(product.filtered_prices).not.toBeNull();
          else expect(product.filtered_prices).toBeNull();
        }
        for (const [id, prices] of Object.entries(query.expected_prices)) {
          const product = products.find((product) => product.id === id);
          expect(product).toBeDefined();
          expect(product?.filtered_prices ?? product?.metrics).toMatchObject(prices);
        }
        for (const [id, count] of Object.entries(query.expected_filtered_stock))
          expect(products.find((product) => product.id === id)?.filtered_stock_count).toBe(count);
        if ("expected_metrics" in query)
          for (const [id, metrics] of Object.entries(query.expected_metrics ?? {}))
            expect(products.find((product) => product.id === id)?.metrics).toMatchObject(metrics);
      });
    }
  });
}
