import { request } from "@/api/client";

export interface Location {
  id: string;
  name: string;
  kind: "cabinet" | "shelf" | "box";
  note: string | null;
  deleted: boolean;
  bottle_count: number;
}
export interface InventoryBottle {
  sku_id?: string;
  purchase_id?: string;
  volume_ml?: number | null;
  vintage?: number | null;
  abv?: string | null;
  age_years?: string | null;
  purchased_on?: string | null;
  vendor_name?: string | null;
  id: string;
  product_id: string;
  name: string;
  label_no: number;
  status: string;
  location_id: string | null;
  legacy_location: string | null;
  bottle_code: string;
}
export interface CleanupPreview {
  id: string;
  kind: string;
  confirmed: boolean;
  snapshot: {
    rows: { id: string; name?: string }[];
    target: { name?: string } | null;
    affected_count: number;
    bottle_count: number;
    known_paid_total: string;
    unknown_price_count: number;
  };
}
export interface QualityReport {
  items: {
    kind: string;
    id: string;
    name: string | null;
    /** 이름이 없는 구매·규격도 알아볼 수 있는 표시 이름(제품명 · 날짜 · 병수). */
    label?: string;
    reason: string;
    product_id: string | null;
  }[];
  duplicate_candidates: { kind: string; items: { id: string; name: string }[] }[];
  coverage: {
    purchases: number;
    known_price_purchases: number;
    unknown_price_purchases: number;
    zero_paid_purchases?: number;
    known_paid_total: string;
    skus: number;
    unknown_volume_skus: number;
    unassigned_stock_bottles: number;
  };
  rules: string;
}
export interface Stocktake {
  id: string;
  name: string;
  status: "active" | "paused" | "completed";
  location_id: string | null;
  expected_count: number;
  observed_count: number;
  mismatch_count: number;
  unexpected_count: number;
  observations: {
    bottle_id: string;
    result: string;
    recorded_location_id: string | null;
    observed_location_id: string | null;
  }[];
  missing: InventoryBottle[];
  found_notes: string[];
}
/** 서버 `BulkPlacementInput.bottle_ids` 의 최대 길이와 같다. */
export const MOVE_BATCH_LIMIT = 500;

export const collectionApi = {
  quality: () => request<QualityReport>("/collection/quality"),
  preview: (kind: string, ids: string[], target_id: string | null = null) =>
    request<CleanupPreview>("/collection/cleanup/preview", {
      method: "POST",
      body: { kind, ids, target_id },
    }),
  confirm: (id: string) =>
    request<CleanupPreview>(`/collection/cleanup/${id}/confirm`, { method: "POST" }),
  locations: () => request<Location[]>("/collection/locations"),
  saveLocation: (input: { name: string; kind: string }, id?: string) =>
    request<{ id: string }>(`/collection/locations${id ? `/${id}` : ""}`, {
      method: id ? "PATCH" : "POST",
      body: input,
    }),
  bottles: () => request<InventoryBottle[]>("/collection/bottles"),
  move: (id: string, location_id: string | null) =>
    request(`/collection/bottles/${id}/location`, { method: "PUT", body: { location_id } }),
  /** 여러 병을 한 위치로. 전부 성공하거나 전부 취소된다. */
  /**
   * 여러 병을 한 위치로 옮긴다. 서버는 요청당 `MOVE_BATCH_LIMIT` 병까지 받으므로 나눠 보낸다.
   * 묶음마다 전부 성공 또는 전부 취소이며, 앞 묶음이 성공한 뒤 뒤 묶음이 실패하면 앞 묶음은
   * 옮겨진 채로 남는다(오류는 그대로 던진다).
   */
  moveMany: async (bottle_ids: string[], location_id: string | null) => {
    const total = { moved: 0, unchanged: 0 };
    for (let start = 0; start < bottle_ids.length; start += MOVE_BATCH_LIMIT) {
      const result = await request<{ moved: number; unchanged: number }>(
        "/collection/bottles:move",
        {
          method: "PUT",
          body: { bottle_ids: bottle_ids.slice(start, start + MOVE_BATCH_LIMIT), location_id },
        },
      );
      total.moved += result.moved;
      total.unchanged += result.unchanged;
    }
    return total;
  },
  movements: (id: string) =>
    request<
      {
        id: string;
        from_location_id: string | null;
        to_location_id: string | null;
        created_at: string;
      }[]
    >(`/collection/bottles/${id}/movements`),
  stocktakes: () => request<Stocktake[]>("/collection/stocktakes"),
  start: (name: string, location_id: string | null) =>
    request<Stocktake>("/collection/stocktakes", { method: "POST", body: { name, location_id } }),
  status: (id: string, status: Stocktake["status"]) =>
    request<Stocktake>(`/collection/stocktakes/${id}`, { method: "PATCH", body: { status } }),
  scan: (id: string, bottle_code: string, observed_location_id: string | null) =>
    request<{ duplicate: boolean; observation: { result: string } }>(
      `/collection/stocktakes/${id}/scan`,
      { method: "POST", body: { bottle_code, observed_location_id } },
    ),
  applyLocations: (id: string) =>
    request<{ moved: number; skipped: number; stocktake: Stocktake }>(
      `/collection/stocktakes/${id}:apply-locations`,
      { method: "POST" },
    ),
  correctObservation: (
    id: string,
    bottleId: string,
    observedLocationId: string | null,
    expectedObservedLocationId: string | null,
  ) =>
    request<Stocktake>(`/collection/stocktakes/${id}/observations/${bottleId}`, {
      method: "PATCH",
      body: {
        observed_location_id: observedLocationId,
        expected_observed_location_id: expectedObservedLocationId,
      },
    }),
  found: (id: string, note: string) =>
    request<Stocktake>(`/collection/stocktakes/${id}/found`, { method: "POST", body: { note } }),
};
