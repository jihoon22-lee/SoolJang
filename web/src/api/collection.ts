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
    reason: string;
    product_id: string | null;
  }[];
  duplicate_candidates: { kind: string; items: { id: string; name: string }[] }[];
  coverage: {
    purchases: number;
    known_price_purchases: number;
    unknown_price_purchases: number;
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
  observations: { bottle_id: string; result: string }[];
  missing: InventoryBottle[];
  found_notes: string[];
}
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
  found: (id: string, note: string) =>
    request<Stocktake>(`/collection/stocktakes/${id}/found`, { method: "POST", body: { note } }),
};
