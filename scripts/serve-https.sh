#!/usr/bin/env bash
#
# 폰에서 술장에 접속할 수 있게 Tailscale HTTPS 를 설정한다.
#
# 왜 Tailscale 인가: 술장을 인터넷에 직접 노출하지 않고도 폰에서 쓰려면 사설망이 필요하다.
# 포트 포워딩은 공유기 설정을 건드리고 공격면을 넓힌다. Tailscale 은 기기 간 암호화 터널을
# 만들고, 무료로 신뢰할 수 있는 인증서를 발급해 준다.
#
# HTTPS 가 필요한 이유는 편의가 아니다. 카메라(바코드·라벨 OCR)와 서비스 워커(오프라인
# 입력)는 브라우저가 secure context 를 요구하므로 평문 HTTP 에서는 아예 동작하지 않는다.
#
# 사용법:
#   scripts/serve-https.sh            # 설정하고 접속 주소를 알려준다
#   scripts/serve-https.sh --status   # 현재 상태만 확인
#   scripts/serve-https.sh --stop     # 공개를 중단한다
set -euo pipefail

readonly LOCAL_PORT="${SOOLJANG_WEB_PORT:-8080}"

log() { printf '%s\n' "$*"; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_tailscale() {
  if ! command -v tailscale >/dev/null 2>&1; then
    cat >&2 <<'GUIDE'
error: tailscale 이 설치되지 않았습니다.

설치 (Debian/Ubuntu 계열):
  curl -fsSL https://tailscale.com/install.sh | sh
  sudo tailscale up

설치 후 이 스크립트를 다시 실행하세요. 폰에도 Tailscale 앱을 설치하고 같은 계정으로
로그인해야 접속할 수 있습니다.
GUIDE
    exit 1
  fi
}

check_backend() {
  # 공개하기 전에 실제로 응답하는지 본다. 죽은 포트를 공개하면 폰에서 원인을 찾기 어렵다.
  if ! curl -fsS --max-time 3 "http://127.0.0.1:${LOCAL_PORT}/api/v1/health" >/dev/null 2>&1; then
    log "경고: http://127.0.0.1:${LOCAL_PORT} 이 응답하지 않습니다."
    log "      먼저 스택을 띄우세요:  docker compose up -d"
    log ""
  fi
}

show_status() {
  log "== Tailscale 상태 =="
  tailscale status || true
  log ""
  log "== 공개 중인 서비스 =="
  tailscale serve status || log "(공개 중인 서비스가 없습니다)"
}

stop_serving() {
  tailscale serve --https=443 off || fail "공개 중단에 실패했습니다"
  log "공개를 중단했습니다. 폰에서 더 이상 접속할 수 없습니다."
}

start_serving() {
  check_backend

  log "Tailscale HTTPS 로 로컬 ${LOCAL_PORT} 포트를 공개합니다..."
  # `--bg` 로 백그라운드에 등록해 셸을 닫아도 유지된다.
  tailscale serve --bg --https=443 "http://127.0.0.1:${LOCAL_PORT}" ||
    fail "공개에 실패했습니다. 'sudo tailscale up' 으로 로그인했는지 확인하세요"

  local host
  host="$(tailscale status --json 2>/dev/null | grep -o '"DNSName":"[^"]*"' | head -1 |
    sed 's/"DNSName":"//; s/"$//; s/\.$//')"

  log ""
  if [[ -n "${host}" ]]; then
    log "접속 주소:  https://${host}"
    log ""
    log "폰에서 쓰려면:"
    log "  1) 폰에 Tailscale 앱을 설치하고 같은 계정으로 로그인"
    log "  2) 브라우저에서 위 주소로 접속"
    log "  3) 홈 화면에 추가하면 앱처럼 쓸 수 있습니다 (Task 15 에서 PWA 로 다듬는다)"
  else
    log "접속 주소를 자동으로 알아내지 못했습니다. 'tailscale status' 로 확인하세요."
  fi

  log ""
  log "주의: 이 주소는 내 tailnet 안에서만 열립니다. 인터넷에 공개되지 않습니다."
  log "      'tailscale funnel' 은 인터넷 전체에 노출되므로 쓰지 마세요."
}

main() {
  case "${1:-}" in
    --status | status)
      require_tailscale
      show_status
      ;;
    --stop | stop | off)
      require_tailscale
      stop_serving
      ;;
    "" | --start | start)
      require_tailscale
      start_serving
      ;;
    *)
      fail "알 수 없는 인자: $1 (사용법: --start | --status | --stop)"
      ;;
  esac
}

main "$@"
