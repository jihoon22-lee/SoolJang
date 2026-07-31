/** 백엔드 API 클라이언트. */

export const API_PREFIX = "/api/v1";

export interface HealthStatus {
  status: "ok" | "degraded";
  version: string;
  environment: string;
  database_connected: boolean;
  migration_revision: string | null;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * 서비스 상태를 조회한다.
 *
 * `/health` 는 DB 장애 시 503 과 함께 본문을 반환하므로, 503 을 오류로 던지지 않고
 * degraded 상태로 표시한다. 상태 표시 화면 자체가 사라지면 원인을 알 수 없다.
 */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthStatus> {
  const response = await fetch(`${API_PREFIX}/health`, {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });

  if (!response.ok && response.status !== 503) {
    throw new ApiError(response.status, `헬스체크 요청이 실패했습니다 (HTTP ${response.status})`);
  }

  return (await response.json()) as HealthStatus;
}
