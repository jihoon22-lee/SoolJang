import type { PurchaseScope } from "@/api/types";
/**
 * URL 해시 기반 최소 라우팅.
 *
 * 라우터 라이브러리를 쓰지 않는다(화면이 몇 개뿐이라 의존성을 늘릴 이유가 없다는 기존
 * 방침 유지) — `history.pushState`/`popstate` 만으로 충분하다. 순수 함수(`parseHash`/
 * `routeToHash`)로 분리해 `App.tsx` 없이도 단위 테스트할 수 있게 한다.
 *
 * "제품 상세로 이동하면 뒤로가기로 목록에 돌아온다"·"통계에서 제품/주종을 눌러 다른 탭으로
 * 점프한다" 두 가지 요구를 만족해야 해서, `products` 뷰만 하위 상태(선택된 제품 또는 주종
 * 필터)를 가진다.
 *
 * `bottles` 뷰가 없는 이유: "병 관리"가 원래 별도 탭이었는데 전체 병을 술 구분 없이 평면
 * 목록으로 보여줘 무슨 술인지 알 수 없다는 문제가 있었다(사용자 실사용 보고) — 제품 상세
 * 화면 안으로 통합했다(`ProductDetail` 의 "병" 섹션).
 */

export type View =
  | "discover"
  | "interests"
  | "inventory"
  | "quality"
  | "home"
  | "products"
  | "categories"
  | "vendors"
  | "sources"
  | "scan"
  | "stats"
  | "import"
  | "price-watch"
  | "settings"
  | "status";

const VIEW_IDS: readonly View[] = [
  "discover",
  "interests",
  "inventory",
  "quality",
  "home",
  "products",
  "categories",
  "vendors",
  "sources",
  "scan",
  "stats",
  "import",
  "price-watch",
  "settings",
  "status",
];

export interface ProductContext {
  purchaseScope?: PurchaseScope | undefined;
  skuId?: string | undefined;
  purchaseId?: string | undefined;
  bottleId?: string | undefined;
  tastingId?: string | undefined;
  editTasting?: boolean | undefined;
}

export interface Route extends ProductContext {
  view: View;
  /** `view === "products"` 일 때만 의미가 있다 — 상세로 진입한 제품 id. */
  productId?: string | undefined;
  /** `view === "products"` 일 때만 의미가 있다 — 목록에 걸린 주종 필터. */
  categoryId?: string | undefined;
  /** `view === "products"` 일 때만 의미가 있다 — 구매처에서 드릴다운할 때 걸리는 구매처 필터. */
  vendorId?: string | undefined;
}

function isView(value: string): value is View {
  return (VIEW_IDS as readonly string[]).includes(value);
}

/** `location.hash`(`#` 포함 여부 무관)를 라우트로 해석한다. 모르는 값은 항상 홈으로 떨어진다. */
export function parseHash(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const [pathPart = "", queryPart] = raw.split("?");
  const segments = pathPart.split("/").filter((segment) => segment.length > 0);
  const viewCandidate = segments[0] ?? "home";
  const view = isView(viewCandidate) ? viewCandidate : "home";

  if (view !== "products") {
    return { view };
  }

  const productId = segments[1];
  const params = new URLSearchParams(queryPart ?? "");
  const categoryId = params.get("category") ?? undefined;
  const vendorId = params.get("vendor") ?? undefined;
  const purchaseScope: PurchaseScope = {
    ...(params.has("scopeVolume") ? { volume_ml: Number(params.get("scopeVolume")) } : {}),
    ...(params.has("scopeVendor") ? { vendor_id: params.get("scopeVendor") ?? undefined } : {}),
    ...(params.has("scopeFrom") ? { purchased_on_min: params.get("scopeFrom") ?? undefined } : {}),
    ...(params.has("scopeTo") ? { purchased_on_max: params.get("scopeTo") ?? undefined } : {}),
    ...(params.get("scopeStock") === "1"
      ? { in_stock: true }
      : params.get("scopeStock") === "0"
        ? { in_stock: false }
        : {}),
  };
  return {
    view,
    productId,
    ...(Object.keys(purchaseScope).length ? { purchaseScope } : {}),
    categoryId,
    vendorId,
    ...(params.has("sku") ? { skuId: params.get("sku") || undefined } : {}),
    ...(params.has("purchase") ? { purchaseId: params.get("purchase") || undefined } : {}),
    ...(params.has("bottle") ? { bottleId: params.get("bottle") || undefined } : {}),
    ...(params.has("tasting") ? { tastingId: params.get("tasting") || undefined } : {}),
    ...(params.get("editTasting") === "1" && params.has("tasting") ? { editTasting: true } : {}),
  };
}

/**
 * 화면 전환 뒤 맨 위로 스크롤할지. 다른 화면으로 가거나 새 제품 상세를 열면 처음부터 보여준다.
 * 같은 목록으로 돌아오는 경우(상세 → 목록)는 목록이 기억한 위치를 복원하므로 건드리지 않는다.
 */
export function shouldResetScroll(previous: Route, next: Route): boolean {
  if (previous.view !== next.view) return true;
  return next.productId !== undefined && next.productId !== previous.productId;
}

/** 라우트를 `#` 로 시작하는 해시 문자열로 되돌린다. `parseHash` 의 역함수다. */
export function routeToHash(route: Route): string {
  if (route.view === "products" && route.productId) {
    const params = new URLSearchParams();
    if (route.skuId) params.set("sku", route.skuId);
    if (route.purchaseId) params.set("purchase", route.purchaseId);
    if (route.bottleId) params.set("bottle", route.bottleId);
    if (route.tastingId) params.set("tasting", route.tastingId);
    if (route.tastingId && route.editTasting) params.set("editTasting", "1");
    const scope = route.purchaseScope;
    if (scope?.volume_ml !== undefined) params.set("scopeVolume", String(scope.volume_ml));
    if (scope?.vendor_id) params.set("scopeVendor", scope.vendor_id);
    if (scope?.purchased_on_min) params.set("scopeFrom", scope.purchased_on_min);
    if (scope?.purchased_on_max) params.set("scopeTo", scope.purchased_on_max);
    if (scope?.in_stock !== undefined) params.set("scopeStock", scope.in_stock ? "1" : "0");
    const query = params.toString();
    return `#products/${route.productId}${query ? `?${query}` : ""}`;
  }
  if (route.view === "products" && route.categoryId) {
    return `#products?category=${route.categoryId}`;
  }
  if (route.view === "products" && route.vendorId) {
    return `#products?vendor=${route.vendorId}`;
  }
  return `#${route.view}`;
}
