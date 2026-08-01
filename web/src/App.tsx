import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { ApiError, authApi, setUnauthorizedHandler } from "@/api/client";
import type { User } from "@/api/types";
import { HealthPanel } from "@/components/HealthPanel";
import { LoginScreen } from "@/components/LoginScreen";
import { BottlesPage } from "@/pages/BottlesPage";
import { CategoriesPage } from "@/pages/CategoriesPage";
import { ImportPage } from "@/pages/ImportPage";
import { ProductsPage } from "@/pages/ProductsPage";
import { StatsPage } from "@/pages/StatsPage";

type View = "products" | "bottles" | "categories" | "stats" | "import" | "status";

const VIEWS: { id: View; label: string }[] = [
  { id: "products", label: "내 술" },
  { id: "bottles", label: "병 관리" },
  { id: "categories", label: "주종 관리" },
  { id: "stats", label: "통계" },
  { id: "import", label: "가져오기" },
  { id: "status", label: "서비스 상태" },
];

/**
 * 애플리케이션 루트.
 *
 * 라우터 라이브러리를 쓰지 않고 상태로 화면을 전환한다. 화면이 다섯뿐이고 URL 공유가
 * 요구사항이 아니라 의존성을 늘릴 이유가 없다. Task 15(PWA)에서 딥링크가 필요해지면 그때
 * 라우터를 도입한다.
 *
 * 인증은 여기서 한 번만 막는다. 각 화면이 개별로 확인하면 빠뜨리는 곳이 생긴다.
 */
export function App() {
  const [view, setView] = useState<View>("products");
  const queryClient = useQueryClient();

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

  return (
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
              aria-current={view === item.id ? "page" : undefined}
              onClick={(event) => {
                event.preventDefault();
                setView(item.id);
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="app-account">
          {user ? <span className="app-account-name">{user.display_name}</span> : null}
          <button
            type="button"
            className="app-logout"
            onClick={() => {
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
      </header>

      <main className="app-main" id="main">
        {view === "products" && <ProductsPage />}
        {view === "bottles" && <BottlesPage />}
        {view === "categories" && <CategoriesPage />}
        {view === "stats" && <StatsPage />}
        {view === "import" && <ImportPage />}
        {view === "status" && <HealthPanel />}
      </main>
    </div>
  );
}
