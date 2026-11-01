/**
 * 마실 수 있는 병(`DrinkableBottle`)을 사람이 고르는 이름. 빠른 시음의 병 고르기와 홈의 열린 병이
 * 함께 쓴다. 병 번호는 구매마다 1부터 다시 매기므로, 같은 이름·용량으로 보이는 병이 둘 이상일
 * 때만 번호·구매일·구매처로 구분한다(D264).
 */
import { type PurchaseIdentity, productEdition } from "@/components/productDisplay";
import { formatDate } from "@/format";
import type { DrinkableBottle } from "@/sync/queries";

export function bottlePurchaseIdentity(bottle: DrinkableBottle): PurchaseIdentity {
  return {
    id: bottle.purchaseId,
    productId: bottle.productId,
    volumeMl: bottle.volumeMl,
    purchasedOn: bottle.purchasedOn,
    vendorName: bottle.vendorName,
  };
}

/** "구매 2026-01-01 · 가게" — 같은 맥락의 구매가 둘 이상이면 짧은 참조를 덧붙인다. */
export function bottlePurchaseContext(
  bottle: DrinkableBottle,
  references: ReadonlyMap<string, string>,
): string {
  const reference = references.get(bottle.purchaseId);
  return `구매 ${formatDate(bottle.purchasedOn)} · ${bottle.vendorName ?? "구매처 미기록"}${reference ? ` · ${reference}` : ""}`;
}

/** "#3 · 구매 2026-01-01 · 가게" */
export function bottlePurchaseLabel(
  bottle: DrinkableBottle,
  references: ReadonlyMap<string, string>,
): string {
  return `#${bottle.labelNo} · ${bottlePurchaseContext(bottle, references)}`;
}

export function bottleProductLabel(bottle: DrinkableBottle): string {
  const edition = productEdition({
    vintage: bottle.vintage,
    abv: bottle.abv,
    age_years: bottle.ageYears,
  });
  return edition ? `${bottle.productName} · ${edition}` : bottle.productName;
}

/** 같은 이름·판본·용량으로 보이는 병의 id. `byNumber`면 병 번호까지 같은 병(다른 구매)만 고른다. */
export function sameLookingBottleIds(
  bottles: readonly DrinkableBottle[],
  byNumber = false,
): Set<string> {
  const key = (bottle: DrinkableBottle) =>
    `${bottleProductLabel(bottle)}\u0000${bottle.volumeMl}${byNumber ? `\u0000${bottle.labelNo}` : ""}`;
  const counts = new Map<string, number>();
  for (const bottle of bottles) counts.set(key(bottle), (counts.get(key(bottle)) ?? 0) + 1);
  return new Set(
    bottles.filter((bottle) => (counts.get(key(bottle)) ?? 0) > 1).map((b) => b.bottleId),
  );
}
