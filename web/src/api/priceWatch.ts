import { request } from "@/api/client";
export interface PriceCriteria {
  product_key: string;
  offer_key: string;
  currency: string;
  volume_ml: string;
  units: number;
  target_amount: string;
  conditions: Record<string, string | boolean | number>;
  max_age_seconds: number;
}
export interface WatchRun {
  id: string;
  watch_id: string;
  status: string;
  outcome: string;
  attempts: number;
  scheduled_for: string;
  finished_at: string | null;
}
export interface PriceWatch {
  id: string;
  interest_id: string;
  interest_name: string;
  source_id: string;
  source_name: string;
  condition_key: string;
  criteria: PriceCriteria;
  config_revision: number;
  is_active: boolean;
  schedule_enabled: boolean;
  push_enabled: boolean;
  interval_seconds: number;
  cooldown_seconds: number;
  next_due_at: string | null;
  last_checked_at: string | null;
  last_outcome: string;
  blocked_reason: string | null;
  last_notified_at: string | null;
  latest_run: WatchRun | null;
}
export interface PriceHistoryRow {
  id: string;
  offer_id: string;
  source_id: string;
  source_name: string;
  condition_key: string;
  amount: string;
  currency: string;
  source_url: string;
  fetched_at: string;
  facts: Record<string, unknown>;
}
export interface WatchPatch {
  expected_revision: number;
  target_amount?: string;
  max_age_seconds?: number;
  is_active?: boolean;
  schedule_enabled?: boolean;
  push_enabled?: boolean;
  interval_seconds?: number;
  cooldown_seconds?: number;
}
export interface PriceNotice {
  id: string;
  watch_id: string | null;
  interest_id: string | null;
  created_at: string;
  read_at: string | null;
  delivery_states: string[];
  amount: string | null;
  currency: string | null;
  source_url: string | null;
  observed_at: string | null;
}
export interface PushConfig {
  configured: boolean;
  public_key: string | null;
  worker_enabled: boolean;
  worker: { state: string; last_tick_at?: string };
}
export interface BrowserPushSubscription {
  id: string;
  endpoint_hash: string;
  is_active: boolean;
  expires_at: string | null;
  last_outcome: string;
  created_at: string;
}

export const priceWatchApi = {
  list: (interestId?: string, signal?: AbortSignal) =>
    request<PriceWatch[]>(
      `/price-watch${interestId ? `?interest_id=${encodeURIComponent(interestId)}` : ""}`,
      { ...(signal ? { signal } : {}), cache: "no-store" },
    ),
  create: (body: {
    interest_id: string;
    offer_id: string;
    target_amount: string;
    max_age_seconds: number;
  }) =>
    request<PriceWatch>("/price-watch", {
      method: "POST",
      body,
      cache: "no-store",
    }),
  update: (id: string, body: WatchPatch) =>
    request<PriceWatch>(`/price-watch/${id}`, {
      method: "PATCH",
      body,
      cache: "no-store",
    }),
  remove: (id: string, revision: number) =>
    request<void>(`/price-watch/${id}`, {
      method: "DELETE",
      body: { expected_revision: revision },
      cache: "no-store",
    }),
  check: (id: string, revision: number, requestId: string) =>
    request<WatchRun>(`/price-watch/${id}/check`, {
      method: "POST",
      body: { expected_revision: revision, request_id: requestId },
      cache: "no-store",
    }),
  run: (id: string, signal?: AbortSignal) =>
    request<WatchRun>(`/price-watch/runs/${id}`, {
      ...(signal ? { signal } : {}),
      cache: "no-store",
    }),
  history: (interestId: string, signal?: AbortSignal) =>
    request<PriceHistoryRow[]>(`/price-watch/interests/${interestId}/history`, {
      ...(signal ? { signal } : {}),
      cache: "no-store",
    }),
  productHistory: (productId: string, signal?: AbortSignal) =>
    request<PriceHistoryRow[]>(`/price-watch/products/${productId}/history`, {
      ...(signal ? { signal } : {}),
      cache: "no-store",
    }),
  notifications: (signal?: AbortSignal) =>
    request<PriceNotice[]>("/price-watch/notifications", {
      ...(signal ? { signal } : {}),
      cache: "no-store",
    }),
  read: (id: string) =>
    request<void>(`/price-watch/notifications/${id}/read`, { method: "POST", cache: "no-store" }),
  pushConfig: (signal?: AbortSignal) =>
    request<PushConfig>("/price-watch/config", {
      ...(signal ? { signal } : {}),
      cache: "no-store",
    }),
  subscriptions: (signal?: AbortSignal) =>
    request<BrowserPushSubscription[]>("/price-watch/subscriptions", {
      ...(signal ? { signal } : {}),
      cache: "no-store",
    }),
  subscribe: (body: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    expires_at: string | null;
  }) =>
    request<BrowserPushSubscription>("/price-watch/subscriptions", {
      method: "POST",
      body,
      cache: "no-store",
    }),
  unsubscribe: (id: string) =>
    request<void>(`/price-watch/subscriptions/${id}`, { method: "DELETE", cache: "no-store" }),
};
