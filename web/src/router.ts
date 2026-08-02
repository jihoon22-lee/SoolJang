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
 */

export type View =
  | "products"
  | "bottles"
  | "categories"
  | "stats"
  | "import"
  | "settings"
  | "status";

const VIEW_IDS: readonly View[] = [
  "products",
  "bottles",
  "categories",
  "stats",
  "import",
  "settings",
  "status",
];

export interface Route {
  view: View;
  /** `view === "products"` 일 때만 의미가 있다 — 상세로 진입한 제품 id. */
  productId?: string | undefined;
  /** `view === "products"` 일 때만 의미가 있다 — 목록에 걸린 주종 필터. */
  categoryId?: string | undefined;
}

function isView(value: string): value is View {
  return (VIEW_IDS as readonly string[]).includes(value);
}

/** `location.hash`(`#` 포함 여부 무관)를 라우트로 해석한다. 모르는 값은 항상 목록으로 떨어진다. */
export function parseHash(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const [pathPart = "", queryPart] = raw.split("?");
  const segments = pathPart.split("/").filter((segment) => segment.length > 0);
  const viewCandidate = segments[0] ?? "products";
  const view = isView(viewCandidate) ? viewCandidate : "products";

  if (view !== "products") {
    return { view };
  }

  const productId = segments[1];
  const categoryId = new URLSearchParams(queryPart ?? "").get("category") ?? undefined;
  return { view, productId, categoryId };
}

/** 라우트를 `#` 로 시작하는 해시 문자열로 되돌린다. `parseHash` 의 역함수다. */
export function routeToHash(route: Route): string {
  if (route.view === "products" && route.productId) {
    return `#products/${route.productId}`;
  }
  if (route.view === "products" && route.categoryId) {
    return `#products?category=${route.categoryId}`;
  }
  return `#${route.view}`;
}
