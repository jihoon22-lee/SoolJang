import { request } from "@/api/client";
import type { Interest, InterestIdentity, InterestSourceMatch } from "@/api/interests";
import type { SourceLookupResult, SourceOutcome } from "@/api/types";

export type ApplyField = "name_en" | "country" | "region" | "abv" | "vintage" | "age_years";
export type ApplicableFields = Partial<Record<ApplyField, string | number>>;
export interface Evidence {
  applicable_fields?: ApplicableFields;
  evidence_token?: string | null;
}
export interface DiscoveryDocument extends Evidence {
  id: string;
  url: string;
  domain: string;
  title: string;
  excerpt: string;
  fetched_at: string;
  published_at: string | null;
  evidence: "search_excerpt" | "provider_text";
  kind: "info" | "review" | "seller_note" | "customer_tasting" | "service_review" | "unknown";
  discovered_by: string[];
  rating: number | null;
  rating_scale: number | null;
  rating_count: number | null;
}
export interface SearchResponse {
  connection_id: string;
  outcome: SourceOutcome;
  documents: DiscoveryDocument[];
  warning: string | null;
  requests: number;
}
export type DiscoverySource = SourceLookupResult & Evidence;
export type SourceMatch = InterestSourceMatch;
export const discoveryApi = {
  search: (connection_id: string, query: string, signal: AbortSignal) =>
    request<SearchResponse>("/discovery/search", {
      method: "POST",
      body: { connection_id, query, page: 1, language: "ko" },
      signal,
      cache: "no-store",
    }),
  lookup: (
    identity: InterestIdentity,
    source_id: string,
    source_matches: Record<string, SourceMatch>,
    signal: AbortSignal,
  ) =>
    request<DiscoverySource[]>("/discovery/lookup", {
      method: "POST",
      body: { identity, source_ids: [source_id], source_matches },
      signal,
      cache: "no-store",
    }),
  productContext: (product_id: string, signal: AbortSignal) =>
    request<{
      identity: InterestIdentity;
      source_matches: Record<string, SourceMatch>;
      updated_at: string;
    }>(`/discovery/products/${product_id}/context`, { signal, cache: "no-store" }),
  interestLookup: (interest_id: string, source_id: string, signal: AbortSignal) =>
    request<DiscoverySource[]>(`/discovery/interests/${interest_id}/lookup`, {
      method: "POST",
      body: { source_ids: [source_id] },
      signal,
      cache: "no-store",
    }),
  productLookup: (product_id: string, source_id: string, signal: AbortSignal) =>
    request<DiscoverySource[]>(`/discovery/products/${product_id}/lookup`, {
      method: "POST",
      body: { source_ids: [source_id] },
      signal,
      cache: "no-store",
    }),
  apply: (
    product_id: string,
    expected_updated_at: string,
    evidence_token: string,
    selected_fields: ApplyField[],
  ) =>
    request<{
      product_id: string;
      updated_at: string;
      applied_fields: ApplicableFields;
      source_url: string;
    }>("/discovery/apply", {
      method: "POST",
      body: { product_id, expected_updated_at, evidence_token, selected_fields },
      cache: "no-store",
    }),
  saveInterest: (
    identity: InterestIdentity,
    source_matches: Record<string, SourceMatch>,
    request_id: string,
  ) =>
    request<Interest>("/interests", {
      method: "POST",
      body: { identity, source_matches, request_id },
    }),
};
