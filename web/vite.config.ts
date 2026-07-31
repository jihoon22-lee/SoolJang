import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
// vitest 4 부터 `test` 설정은 vite 의 defineConfig 타입에 없다. vitest/config 를 쓴다.
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
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
