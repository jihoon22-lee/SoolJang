import { registerSW } from "virtual:pwa-register";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import "@/styles.css";
import { initializeDraftTab } from "@/sync/drafts";
import { controllerChanged, markUpdateReady, protectFormUpdates } from "@/sync/update";

initializeDraftTab();
protectFormUpdates();
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh: () => markUpdateReady(() => updateSW(true)),
  onNeedReload: () => controllerChanged(() => window.location.reload()),
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root 요소를 찾을 수 없습니다");
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
