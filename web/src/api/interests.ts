import { request } from "@/api/client";
export interface InterestIdentity {
  name: string;
  name_en?: string | null;
  producer?: string | null;
  abv?: string | null;
  vintage?: number | null;
  age_years?: string | null;
  volumes_ml?: number[];
}
export interface Interest {
  id: string;
  name: string;
  identity: InterestIdentity;
  source_matches: Record<string, unknown>;
  note: string | null;
  archived: boolean;
  product_id: string | null;
  updated_at: string;
}
export interface InterestPurchase {
  confirmed_identity: true;
  expected_updated_at: string;
  sku_id?: string;
  new_product?: {
    name: string;
    volume_ml: number;
    abv: string | null;
    vintage: number | null;
    name_en?: string | null;
    producer?: string | null;
    age_years?: string | null;
  };
  vendor_id: string | null;
  purchased_on: string | null;
  quantity: number;
  unit_list_price: string | null;
  unit_paid_price: string | null;
}
export const interestsApi = {
  list: () => request<Interest[]>("/interests"),
  create: (identity: InterestIdentity, note: string | null, request_id?: string) =>
    request<Interest>("/interests", { method: "POST", body: { identity, note, request_id } }),
  update: (
    id: string,
    input: { note?: string | null; archived?: boolean; expected_updated_at: string },
  ) => request<Interest>(`/interests/${id}`, { method: "PATCH", body: input }),
  purchase: (id: string, input: InterestPurchase) =>
    request<{ interest_id: string; purchase_id: string; product_id: string }>(
      `/interests/${id}/purchase`,
      { method: "POST", body: input },
    ),
};
