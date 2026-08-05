import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, authApi, setUnauthorizedHandler } from "@/api/client";
import type { User } from "@/api/types";
import { HealthPanel } from "@/components/HealthPanel";
import { LoginScreen } from "@/components/LoginScreen";
import { CategoriesPage } from "@/pages/CategoriesPage";
import { ImportPage } from "@/pages/ImportPage";
import { ProductsPage } from "@/pages/ProductsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SourcesPage } from "@/pages/SourcesPage";
import { StatsPage } from "@/pages/StatsPage";
import { StoreModePage } from "@/pages/StoreModePage";
import { VendorsPage } from "@/pages/VendorsPage";
import { parseHash, type Route, routeToHash, type View } from "@/router";
import { SyncStatusBadge } from "@/sync/SyncStatusBadge";
import { SyncStatusProvider } from "@/sync/SyncStatusProvider";

/** 자주 쓰는 화면만 주 탭에 남긴다(항목 3·6). "매장 모드" 는 nav 에서 빠졌지만 `#scan`
 * 라우트·화면은 그대로 있다 — `ProductsPage` 의 모바일 전용 진입 버튼으로만 들어간다. */
const VIEWS: { id: View; label: string }[] = [
  { id: "products", label: "내 술" },
  { id: "categories", label: "주종 관리" },
  { id: "vendors", label: "구매처" },
  { id: "stats", label: "통계" },
];

/** 자주 쓰지 않는 환경 설정류. 헤더의 설정 메뉴 안에 접어 둔다(항목 3). */
const SETTINGS_VIEWS: { id: View; label: string }[] = [
  { id: "import", label: "가져오기" },
  { id: "sources", label: "외부 소스" },
  { id: "settings", label: "설정" },
  { id: "status", label: "서비스 상태" },
];

/**
 * 애플리케이션 루트.
 *
 * 라우터 라이브러리를 쓰지 않고 `history.pushState`/`popstate` 만으로 URL 해시에 뷰 상태를
 * 동기화한다(`@/router`). 예전에는 순수 `useState` 로만 화면을 전환해 URL 이 안 바뀌고
 * 브라우저 뒤로가기가 앱을 벗어나는 문제가 있었다 — 화면이 몇 개뿐이라 무거운 라우터
 * 라이브러리를 쓰지는 않되, 해시 동기화는 필요해졌다(제품 상세 진입, 통계에서 다른 탭으로
 * 점프하는 크로스 링크가 생기면서).
 *
 * 인증은 여기서 한 번만 막는다. 각 화면이 개별로 확인하면 빠뜨리는 곳이 생긴다.
 */
export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // 메뉴 바깥을 클릭하거나 Esc 를 누르면 닫는다 — 드물게 여는 `SyncStatusBadge` 패널과 달리
  // 이건 자주 여닫는 상시 내비게이션이라 닫는 방법이 트리거 버튼 재클릭뿐이면 불편하다.
  useEffect(() => {
    if (!settingsOpen) return;
    function onPointerDown(event: PointerEvent): void {
      if (!settingsMenuRef.current?.contains(event.target as Node)) {
        setSettingsOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setSettingsOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [settingsOpen]);

  useEffect(() => {
    function onPopState(): void {
      setRoute(parseHash(window.location.hash));
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: Route) => {
    const hash = routeToHash(next);
    if (window.location.hash !== hash) {
      window.history.pushState(null, "", hash);
    }
    setRoute(next);
  }, []);

  const session = useQuery({
    queryKey: ["auth", "me"],
    queryFn: ({ signal }) => authApi.me(signal),
    // 401 은 정상적인 "로그인 안 됨" 상태다. 재시도하면 로그인 화면이 늦게 뜬다.
    retry: false,
  });

  const handleUnauthorized = useCallback(() => {
    // 세션이 끊기면 캐시된 데이터를 남겨 두지 않는다. 다른 사용자의 화면에 남으면 안 된다.
    queryClient.setQueryData(["auth", "me"], null);
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "auth" });
  }, [queryClient]);

  useEffect(() => {
    setUnauthorizedHandler(handleUnauthorized);
    return () => setUnauthorizedHandler(null);
  }, [handleUnauthorized]);

  const isUnauthenticated =
    session.data === null || (session.error instanceof ApiError && session.error.status === 401);

  if (session.isPending) {
    return (
      <div className="app-shell">
        <output className="app-loading">불러오는 중…</output>
      </div>
    );
  }

  if (isUnauthenticated) {
    return (
      <LoginScreen
        onAuthenticated={(result) => {
          queryClient.setQueryData(["auth", "me"], result.user);
          void queryClient.invalidateQueries();
        }}
      />
    );
  }

  const user: User | undefined = session.data ?? undefined;
  const isSettingsView = SETTINGS_VIEWS.some((item) => item.id === route.view);

  return (
    <SyncStatusProvider>
      <div className="app-shell">
        <a className="skip-link" href="#main">
          본문으로 건너뛰기
        </a>

        <header className="app-header">
          <h1>술장</h1>
          <nav className="app-nav" aria-label="주요 화면">
            {VIEWS.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                aria-current={route.view === item.id ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  navigate({ view: item.id });
                }}
              >
                {item.label}
              </a>
            ))}
          </nav>
          <div className="app-account">
            <SyncStatusBadge />
            {user ? <span className="app-account-name">{user.display_name}</span> : null}
            <div className="settings-menu" ref={settingsMenuRef}>
              <button
                type="button"
                className="settings-menu-trigger"
                aria-expanded={settingsOpen}
                aria-haspopup="true"
                aria-current={isSettingsView ? "page" : undefined}
                onClick={() => setSettingsOpen((open) => !open)}
              >
                설정
              </button>
              {settingsOpen && (
                <div className="settings-menu-panel" role="menu" aria-label="설정 메뉴">
                  {SETTINGS_VIEWS.map((item) => (
                    <a
                      key={item.id}
                      role="menuitem"
                      href={`#${item.id}`}
                      aria-current={route.view === item.id ? "page" : undefined}
                      onClick={(event) => {
                        event.preventDefault();
                        navigate({ view: item.id });
                        setSettingsOpen(false);
                      }}
                    >
                      {item.label}
                    </a>
                  ))}
                  <button
                    type="button"
                    role="menuitem"
                    className="settings-menu-logout"
                    onClick={() => {
                      setSettingsOpen(false);
                      void authApi.logout().finally(() => {
                        queryClient.setQueryData(["auth", "me"], null);
                        queryClient.removeQueries({
                          predicate: (query) => query.queryKey[0] !== "auth",
                        });
                      });
                    }}
                  >
                    로그아웃
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="app-main" id="main">
          {route.view === "products" && (
            <ProductsPage
              selectedProductId={route.productId ?? null}
              onSelectProduct={(id) => navigate({ view: "products", productId: id })}
              onDeselectProduct={() => navigate({ view: "products" })}
              initialCategoryId={route.categoryId}
              initialVendorId={route.vendorId}
              onOpenStoreMode={() => navigate({ view: "scan" })}
            />
          )}
          {route.view === "scan" && (
            <StoreModePage onOpenDetail={(id) => navigate({ view: "products", productId: id })} />
          )}
          {route.view === "categories" && <CategoriesPage />}
          {route.view === "vendors" && (
            <VendorsPage onSelectVendor={(id) => navigate({ view: "products", vendorId: id })} />
          )}
          {route.view === "sources" && <SourcesPage />}
          {route.view === "stats" && (
            <StatsPage
              onSelectProduct={(id) => navigate({ view: "products", productId: id })}
              onSelectCategory={(id) => navigate({ view: "products", categoryId: id })}
            />
          )}
          {route.view === "import" && <ImportPage />}
          {route.view === "settings" && <SettingsPage />}
          {route.view === "status" && <HealthPanel />}
        </main>
      </div>
    </SyncStatusProvider>
  );
}
