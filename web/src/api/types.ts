/**
 * 백엔드 API 타입.
 *
 * 금액 필드가 `null` 인 것은 **0원이 아니라 가격 정보가 없다**는 뜻이다. 화면에서 `0원` 으로
 * 표시하면 사용자가 무료로 받은 술과 가격을 기록하지 않은 술을 구분할 수 없다.
 * (`docs/architecture.md` §3, `docs/plan.md` §5-D35)
 */

/** 금액. 정밀도를 잃지 않도록 문자열로 주고받는다. */
export type Money = string | null;

export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail: string | null;
  instance: string | null;
  errors: FieldError[];
}

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export interface HealthStatus {
  status: "ok" | "degraded";
  version: string;
  environment: string;
  database_connected: boolean;
  migration_revision: string | null;
}

// --- 카테고리 ---------------------------------------------------------------

export interface CategoryNode {
  id: string;
  parent_id: string | null;
  name: string;
  depth: number;
  path: string[];
  is_seeded: boolean;
  sort_order: number;
  product_count: number;
  descendant_product_count: number;
}

export interface CategoryTree {
  items: CategoryNode[];
  max_depth: number;
  depth_limit: number;
}

export type DeleteStrategy = "reject" | "promote_children" | "reassign";

// --- 제품 -------------------------------------------------------------------

export interface Sku {
  id: string;
  volume_ml: number;
  barcode: string | null;
  barcode_type: string | null;
  package_note: string | null;
}

export interface ProductMetrics {
  purchased_count: number;
  consumed_count: number;
  in_stock_count: number;
  unopened_count: number;
  opened_count: number;
  gifted_count: number;
  sold_count: number;
  avg_list_price: Money;
  avg_paid_price: Money;
  /** 정가 기준. 레거시 통계와 일치시키기 위한 결정이다. */
  price_per_100ml: Money;
  price_per_100ml_paid: Money;
  list_total: Money;
  paid_total: Money;
  discount_rate: string | null;
  total_volume_ml: number;
  inventory_value_at_cost: Money;
}

export interface Product {
  id: string;
  name: string;
  name_en: string | null;
  category_id: string | null;
  category_path: string[];
  producer_id: string | null;
  producer_name: string | null;
  country: string | null;
  region: string | null;
  abv: string | null;
  vintage: number | null;
  age_years: string | null;
  personal_rating: string | null;
  note: string | null;
  varieties: string[];
  skus: Sku[];
  metrics: ProductMetrics;
}

export interface ProductPage {
  items: Product[];
  /** null 이면 마지막 페이지. 그대로 다음 요청에 실어 보낸다. */
  next_cursor: string | null;
}

export type SortKey =
  | "name"
  | "created_at"
  | "updated_at"
  | "abv"
  | "vintage"
  | "personal_rating"
  | "avg_list_price"
  | "avg_paid_price"
  | "price_per_100ml"
  | "paid_total"
  | "in_stock_count"
  | "purchased_count";

export type SortOrder = "asc" | "desc";

export interface ProductFilters {
  // exactOptionalPropertyTypes 를 켜 두었으므로 선택 속성에 undefined 를 명시한다.
  // 그러지 않으면 `{ q: undefined }` 같은 부분 갱신이 타입 오류가 된다.
  q?: string | undefined;
  category_id?: string | undefined;
  include_descendants?: boolean | undefined;
  country?: string | undefined;
  abv_min?: string | undefined;
  abv_max?: string | undefined;
  vintage_min?: number | undefined;
  vintage_max?: number | undefined;
  rating_min?: string | undefined;
  in_stock?: boolean | undefined;
  vendor_id?: string | undefined;
  variety?: string | undefined;
  price_per_100ml_min?: string | undefined;
  price_per_100ml_max?: string | undefined;
  sort?: SortKey | undefined;
  order?: SortOrder | undefined;
  limit?: number | undefined;
}

export interface ProductCreateInput {
  name: string;
  name_en?: string | null;
  category_id?: string | null;
  country?: string | null;
  region?: string | null;
  abv?: string | null;
  vintage?: number | null;
  age_years?: string | null;
  personal_rating?: string | null;
  note?: string | null;
  variety_names?: string[];
  skus?: { volume_ml: number; barcode?: string | null }[];
}

// --- 구매처·구매 건 ---------------------------------------------------------

export type VendorKind =
  | "mart"
  | "online"
  | "duty_free"
  | "bottle_shop"
  | "bar"
  | "brewery"
  | "event"
  | "gift"
  | "other";

export interface Vendor {
  id: string;
  name: string;
  kind: VendorKind;
  url: string | null;
  note: string | null;
  purchase_count: number;
}

export interface Purchase {
  id: string;
  sku_id: string;
  volume_ml: number | null;
  vendor_id: string | null;
  vendor_name: string | null;
  purchased_on: string | null;
  quantity: number;
  unit_list_price: Money;
  unit_paid_price: Money;
  list_total: Money;
  paid_total: Money;
  currency: string;
  fx_rate: string | null;
  foreign_unit_price: Money;
  discount_note: string | null;
  import_note: string | null;
  bottle_count: number;
}

export interface PurchaseCreateInput {
  sku_id: string;
  vendor_id?: string | null;
  purchased_on?: string | null;
  quantity: number;
  unit_list_price?: string | null;
  unit_paid_price?: string | null;
  currency?: string;
  fx_rate?: string | null;
  foreign_unit_price?: string | null;
  discount_note?: string | null;
}

export type BottleStatus = "unopened" | "open" | "finished" | "gifted" | "sold";

export interface Bottle {
  id: string;
  purchase_id: string;
  label_no: number;
  status: BottleStatus;
  opened_on: string | null;
  finished_on: string | null;
  /** `null` 이면 미개봉(규격 용량 전량)이라는 뜻이다. 0ml 이 아니다. */
  remaining_ml: number | null;
  storage_location: string | null;
  note: string | null;
}

// --- 레거시 임포트 ----------------------------------------------------------

export interface ImportBlockInfo {
  record_count: number;
  /** 데이터 중간의 빈 행. 종료로 오인하지 않고 통과한 위치 */
  skipped_blank_lines: number[];
  total_row_lines: number[];
  excluded_line_count: number;
}

export interface ImportTotals {
  products: number;
  source_rows: number;
  skus: number;
  purchases: number;
  bottles: number;
  vendors: number;
  categories: number;
  varieties: number;
  list_amount: Money;
  paid_amount: Money;
  volume_ml: number;
}

export interface ImportReview {
  merge_group_count: number;
  merge_examples: number[][];
  split_vendor_rows: number[];
  unsplit_vendor_rows: number[];
  warning_summary: [string, number][];
}

export interface ImportSampleRow {
  line_number: number;
  name: string;
  vintage: number | null;
  volume_ml: number | null;
  abv: string | null;
  category_path: string[];
  varieties: string[];
  unit_list_price: Money;
  unit_paid_price: Money;
  quantity: number;
  vendors: string[];
}

export interface ImportAnalysis {
  block: ImportBlockInfo;
  totals: ImportTotals;
  review: ImportReview;
  sample: ImportSampleRow[];
}

export interface ImportCommitResult {
  products_created: number;
  products_reused: number;
  skus_created: number;
  purchases_created: number;
  purchases_skipped: number;
  bottles_created: number;
  categories_created: number;
  vendors_created: number;
  varieties_created: number;
  failed_rows: [number, string][];
}

// --- 인증 --------------------------------------------------------------------

export type UserRole = "owner" | "viewer";

export interface User {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  last_login_at: string | null;
}

export interface LoginResponse {
  user: User;
  /** 쓰기 요청의 `X-CSRF-Token` 헤더에 실린다. 클라이언트가 쿠키에서도 읽는다. */
  csrf_token: string;
  expires_at: string;
}

export interface SetupStatus {
  needs_setup: boolean;
}

// --- 병과 시음 ----------------------------------------------------------------

export interface Tasting {
  id: string;
  bottle_id: string | null;
  sku_id: string;
  tasted_on: string;
  poured_ml: number | null;
  /** 6점 만점 0.5 단위. 문자열로 오므로 표시 전에 그대로 쓴다. */
  rating: string | null;
  nose: string | null;
  palate: string | null;
  finish: string | null;
  note: string | null;
  place: string | null;
  companions: string | null;
}

export interface TastingInput {
  tasted_on: string;
  bottle_id?: string | undefined;
  sku_id?: string | undefined;
  poured_ml?: number | undefined;
  rating?: string | undefined;
  nose?: string | undefined;
  palate?: string | undefined;
  finish?: string | undefined;
  note?: string | undefined;
  place?: string | undefined;
  companions?: string | undefined;
}

export interface TastingSummary {
  session_count: number;
  rated_count: number;
  average_rating: string | null;
  first_rating: string | null;
  latest_rating: string | null;
  /** 첫 평점 대비 최근 평점의 변화. 양수면 처음보다 좋아졌다는 뜻이다. */
  rating_change: string | null;
  total_poured_ml: number;
  first_tasted_on: string | null;
  latest_tasted_on: string | null;
}

// --- 동기화 ------------------------------------------------------------------
// `entity` 를 `sync/db.ts` 의 `SyncEntity` 로 좁히지 않는다 — 이 파일은 다른 모듈을
// import 하지 않는 순수 타입 선언 파일이라는 기존 관례를 따른다.

export interface SyncPullResponse {
  changes: Record<string, Record<string, unknown>[]>;
  next_cursor: string | null;
  has_more: boolean;
}

export interface SyncOperationRequest {
  idempotency_key: string;
  entity: string;
  op: "create" | "update" | "delete" | "action";
  entity_id: string;
  base_updated_at?: string | undefined;
  action?: string | undefined;
  fields: Record<string, unknown>;
}

export interface SyncOperationResult {
  idempotency_key: string;
  status: "applied" | "conflict" | "failed";
  detail: string | null;
  snapshot: Record<string, unknown> | null;
}

export interface SyncBatchResponse {
  results: SyncOperationResult[];
  stopped: boolean;
}

// --- 통계 --------------------------------------------------------------------

export interface RankingEntry {
  product_id: string;
  product_name: string;
  value: string;
}

export interface Rankings {
  /** 실구매가 기준. */
  by_bottle_price: RankingEntry[];
  /** 실구매가 기준. 같은 제품의 반복 구매를 합산하므로 레거시 엑셀의 행 단위 랭킹과는
   * 다를 수 있다(엑셀은 반복 구매를 별도 행으로 남겼다). */
  by_total_spend: RankingEntry[];
  /** 정가 기준. 레거시 통계와 일치시키기 위한 결정이다. */
  by_price_per_100ml: RankingEntry[];
  by_personal_rating: RankingEntry[];
}

export interface CategoryStat {
  category_id: string | null;
  /** 카테고리가 없으면 "미분류". */
  name: string;
  bottle_count: number;
  total_spend: Money;
  avg_abv: string | null;
  avg_rating: string | null;
  avg_price_per_100ml: Money;
  discount_rate: string | null;
}

export interface StatsSummary {
  purchased_count: number;
  consumed_count: number;
  in_stock_count: number;
  unopened_count: number;
  opened_count: number;
  total_volume_ml: number;
  list_total: Money;
  paid_total: Money;
  avg_list_price: Money;
  avg_paid_price: Money;
  avg_price_per_100ml: Money;
  discount_rate: string | null;
  avg_personal_rating: string | null;
  vendor_count: number;
}
