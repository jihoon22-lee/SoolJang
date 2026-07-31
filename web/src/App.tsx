import { HealthPanel } from "@/components/HealthPanel";

/** 애플리케이션 루트. Task 10 에서 실제 화면으로 교체된다. */
export function App() {
  return (
    <main>
      <h1>술장</h1>
      <p>개인 주류 컬렉션 기록·관리·분석 플랫폼</p>
      <HealthPanel />
    </main>
  );
}
