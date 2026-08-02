import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
// vitest 4 부터 `test` 설정은 vite 의 defineConfig 타입에 없다. vitest/config 를 쓴다.
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // `docker/nginx.conf` 가 `/sw.js` 를 캐시 안 되게 별도 규칙으로 잡아 뒀다 — 파일명을
      // 맞춰야 한다.
      filename: "sw.js",
      registerType: "autoUpdate",
      // `main.tsx` 에서 `virtual:pwa-register` 로 직접 등록한다 — 플러그인이 자동으로
      // 스크립트 태그를 주입하면 등록이 두 번 일어난다.
      injectRegister: false,
      // 읽기는 이제 Dexie 가 우선이라(§ Task 15) API 응답에 대한 런타임 캐싱 전략은
      // 필요 없다 — 여기 역할은 설치 가능성 + 앱 셸(JS/CSS/HTML) 캐싱으로 좁힌다.
      workbox: {
        navigateFallback: "/index.html",
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
      },
      manifest: {
        name: "술장",
        short_name: "술장",
        description: "개인 주류 컬렉션 기록·관리·분석 플랫폼",
        lang: "ko",
        start_url: "/",
        display: "standalone",
        background_color: "#faf8f5",
        theme_color: "#7a3b2e",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // 개발 중에는 프론트와 API 가 다른 포트에 있다. 프록시로 same-origin 을 만들어
    // 운영(단일 리버스 프록시)과 같은 조건에서 개발한다.
    proxy: {
      "/api": {
        target: process.env.SOOLJANG_API_URL ?? "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
    // 저장소가 WSL2 에서 Windows 드라이브(`/mnt/*`, DrvFs)에 있으면 inotify 이벤트가
    // 전달되지 않아 파일을 고쳐도 HMR 이 반응하지 않는다(개발 서버 재시작 없이는 계속
    // 옛 내용을 서빙한다) — 폴링으로 우회한다.
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/main.tsx", "src/vite-env.d.ts"],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});
