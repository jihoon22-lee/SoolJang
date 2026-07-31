import { useQuery } from "@tanstack/react-query";
import { fetchHealth } from "@/api/client";

/**
 * 백엔드 연결 상태를 표시한다. 골격 단계의 유일한 화면 요소다.
 *
 * 상태 알림에는 `role="status"` 대신 시맨틱 `<output>` 을 쓴다. 암묵적 role 이
 * status 라 스크린리더 동작은 같고, 요소 자체가 의미를 갖는다.
 */
export function HealthPanel() {
  const { data, error, isPending } = useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => fetchHealth(signal),
    retry: false,
  });

  if (isPending) {
    return <output aria-live="polite">서비스 상태를 확인하고 있습니다…</output>;
  }

  if (error) {
    return (
      <p role="alert">
        백엔드에 연결할 수 없습니다: {error instanceof Error ? error.message : "알 수 없는 오류"}
      </p>
    );
  }

  const healthy = data.status === "ok";

  return (
    <section aria-labelledby="health-heading">
      <h2 id="health-heading">서비스 상태</h2>
      <output aria-live="polite">
        {healthy ? "정상 동작 중입니다." : "일부 구성 요소에 문제가 있습니다."}
      </output>
      <dl>
        <dt>상태</dt>
        <dd>{healthy ? "ok" : "degraded"}</dd>
        <dt>버전</dt>
        <dd>{data.version}</dd>
        <dt>실행 환경</dt>
        <dd>{data.environment}</dd>
        <dt>데이터베이스</dt>
        <dd>{data.database_connected ? "연결됨" : "연결 안 됨"}</dd>
        <dt>마이그레이션 리비전</dt>
        <dd>{data.migration_revision ?? "적용된 마이그레이션 없음"}</dd>
      </dl>
    </section>
  );
}
