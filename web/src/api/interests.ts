import { request } from "@/api/client";
export interface InterestIdentity {
  name: string;
  name_en?: string | null;
  search_aliases?: string[];
  producer?: string | null;
  abv?: string | null;
  vintage?: number | null;
  age_years?: string | null;
  volumes_ml?: number[];
}
export interface InterestSourceMatch {
  external_url: string;
  external_name: string;
  external_key: string | null;
  product_key: string | null;
  preferred_seller_key?: string | null;
}
export interface Interest {
  id: string;
  name: string;
  identity: InterestIdentity;
  source_matches: Record<string, InterestSourceMatch>;
  note: string | null;
  archived: boolean;
  product_id: string | null;
  updated_at: string;
  created_at?: string;
  deleted?: boolean;
  reference_urls?: string[];
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
    search_aliases?: string[];
  };
  vendor_id: string | null;
  purchased_on: string | null;
  quantity: number;
  unit_list_price: string | null;
  unit_paid_price: string | null;
}
export const interestsApi = {
  list: () => request<Interest[]>("/interests?include_deleted=true", { cache: "no-store" }),
  create: (
    identity: InterestIdentity,
    note: string | null,
    request_id?: string,
    reference_urls?: string[],
  ) =>
    request<Interest>("/interests", {
      method: "POST",
      body: { identity, note, request_id, reference_urls },
    }),
  update: (
    id: string,
    input: {
      note?: string | null;
      archived?: boolean;
      expected_updated_at: string;
      source_matches?: Record<string, InterestSourceMatch>;
      identity?: InterestIdentity;
      reference_urls?: string[];
    },
  ) => request<Interest>(`/interests/${id}`, { method: "PATCH", body: input }),
  remove: (id: string, expected_updated_at: string) =>
    request<Interest>(`/interests/${id}`, { method: "DELETE", body: { expected_updated_at } }),
  restore: (id: string, expected_updated_at: string) =>
    request<Interest>(`/interests/${id}/restore`, {
      method: "POST",
      body: { expected_updated_at },
    }),
  purchase: (id: string, input: InterestPurchase) =>
    request<{ interest_id: string; purchase_id: string; product_id: string }>(
      `/interests/${id}/purchase`,
      { method: "POST", body: input },
    ),
};
