import type { SourceOutcome } from "@/api/types";

const LABELS: Record<SourceOutcome, string> = {
  unknown: "미검증",
  success: "조회 성공",
  empty: "검색 결과 없음",
  partial: "일부 자료만 확인",
  authentication_failed: "인증 실패",
  forbidden: "접근 권한 없음",
  rate_limited: "요청 한도 초과",
  network_error: "연결 실패",
  parse_error: "자료 형식 불일치",
  policy_blocked: "요청 정책에 따라 차단",
  invalid_configuration: "조회 설정 확인 필요",
  credential_unavailable: "API 자격증명 확인 필요",
};

export function sourceOutcomeLabel(outcome: SourceOutcome): string {
  return LABELS[outcome] ?? LABELS.unknown;
}
