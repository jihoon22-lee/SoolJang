import { useState } from "react";
import { HealthPanel } from "@/components/HealthPanel";
import { CategoriesPage } from "@/pages/CategoriesPage";
import { ProductsPage } from "@/pages/ProductsPage";

type View = "products" | "categories" | "status";

const VIEWS: { id: View; label: string }[] = [
  { id: "products", label: "내 술" },
  { id: "categories", label: "주종 관리" },
  { id: "status", label: "서비스 상태" },
];

/**
 * 애플리케이션 루트.
 *
 * 라우터 라이브러리를 쓰지 않고 상태로 화면을 전환한다. 화면이 셋뿐이고 URL 공유가
 * 요구사항이 아니라 의존성을 늘릴 이유가 없다. Task 15(PWA)에서 딥링크가 필요해지면 그때
 * 라우터를 도입한다.
 */
export function App() {
  const [view, setView] = useState<View>("products");

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
      </header>

      <main className="app-main" id="main">
        {view === "products" && <ProductsPage />}
        {view === "categories" && <CategoriesPage />}
        {view === "status" && <HealthPanel />}
      </main>
    </div>
  );
}
