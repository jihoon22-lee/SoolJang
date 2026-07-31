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
