#!/usr/bin/env bash
#
# 데이터베이스 백업과 복원.
#
# 술장의 데이터는 손으로 몇 년간 쌓은 기록이고, 다시 만들 수 없다. 컨테이너 볼륨 하나가
# 유일한 사본이면 실수 한 번에 전부 사라진다.
#
# 사용법:
#   scripts/backup.sh                      # 백업 생성
#   scripts/backup.sh --list               # 백업 목록
#   scripts/backup.sh --restore <파일>     # 복원 (확인을 묻는다)
#   scripts/backup.sh --verify <파일>      # 덤프가 읽을 수 있는지 확인
#
# 백업 파일은 .gitignore 로 커밋을 막아 두었다. 실제 음주 기록이 저장소에 들어가면
# private 저장소라도 되돌릴 수 없다.
set -euo pipefail

readonly BACKUP_DIR="${SOOLJANG_BACKUP_DIR:-${HOME}/sooljang-backups}"
readonly DB_SERVICE="db"
readonly DB_USER="${SOOLJANG_DB_USER:-sooljang}"
readonly DB_NAME="${SOOLJANG_DB_NAME:-sooljang}"
readonly KEEP_COUNT="${SOOLJANG_BACKUP_KEEP:-14}"

log() { printf '%s\n' "$*"; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# docker 그룹이 현재 셸에 반영되지 않은 환경이 있어 `sg docker` 로 감쌀 수 있게 한다.
#
# `sg -c` 는 명령을 문자열 하나로 받으므로, 인자를 그대로 이어 붙이면 `--format '{{.Service}}
# {{.State}}'` 처럼 공백이 든 인자가 두 개로 쪼개진다. `printf %q` 로 각 인자를 이스케이프해
# 원래 경계를 보존한다.
#
# 절대 경로(`/usr/bin/sg`)를 쓴다 — 이 환경에는 `ast-grep` 이 `sg` 라는 이름으로 `PATH`
# 앞쪽(`~/.local/bin`)에 설치돼 있어, 그냥 `sg` 를 쓰면 그룹 전환 대신 ast-grep 이 실행돼
# `compose ps` 결과가 조용히 비고 "db 컨테이너가 실행 중이 아닙니다" 오류로 이어진다
# (docs/handoff.md §5 에 이미 기록된 함정 — 실제로 릴리스 백업 중 재발했다).
compose() {
  if [[ -n "${SOOLJANG_DOCKER_SG:-}" ]]; then
    local quoted
    quoted="$(printf '%q ' "$@")"
    /usr/bin/sg docker -c "docker compose ${quoted}"
  else
    docker compose "$@"
  fi
}

require_db() {
  if ! compose ps --format '{{.Service}} {{.State}}' 2>/dev/null | grep -q "^${DB_SERVICE} running"; then
    fail "db 컨테이너가 실행 중이 아닙니다. 'docker compose up -d db' 를 먼저 실행하세요"
  fi
}

create_backup() {
  require_db
  mkdir -p "${BACKUP_DIR}"

  local stamp file
  stamp="$(date +%Y%m%d-%H%M%S)"
  file="${BACKUP_DIR}/sooljang-${stamp}.dump"

  log "백업 중: ${file}"
  # -Fc 는 압축된 커스텀 형식이다. pg_restore 로 선택 복원이 가능하다.
  if ! compose exec -T "${DB_SERVICE}" pg_dump -U "${DB_USER}" -d "${DB_NAME}" -Fc >"${file}"; then
    rm -f "${file}"
    fail "pg_dump 가 실패했습니다"
  fi

  # 빈 파일이 만들어졌는데 성공으로 착각하면 백업이 없는 상태를 백업이 있다고 믿게 된다.
  local size
  size="$(stat -c %s "${file}" 2>/dev/null || echo 0)"
  if [[ "${size}" -lt 1000 ]]; then
    rm -f "${file}"
    fail "백업 파일이 비정상적으로 작습니다 (${size} 바이트)"
  fi

  chmod 600 "${file}"
  log "완료: ${file} ($(numfmt --to=iec "${size}" 2>/dev/null || echo "${size}B"))"

  verify_backup "${file}"
  prune_backups
}

verify_backup() {
  local file="${1:?백업 파일 경로가 필요합니다}"
  [[ -f "${file}" ]] || fail "파일이 없습니다: ${file}"

  # 덤프를 실제로 읽어 목차를 뽑아 본다. 파일이 존재하는 것과 복원 가능한 것은 다르다.
  local tables
  if ! tables="$(compose exec -T "${DB_SERVICE}" pg_restore --list </"${file}" 2>/dev/null |
    grep -c 'TABLE DATA' || true)"; then
    fail "덤프를 읽을 수 없습니다: ${file}"
  fi
  log "검증: 테이블 데이터 ${tables:-0}개 항목을 읽었습니다"
  [[ "${tables:-0}" -gt 0 ]] || fail "덤프에 테이블 데이터가 없습니다"
}

list_backups() {
  if [[ ! -d "${BACKUP_DIR}" ]]; then
    log "백업이 없습니다 (${BACKUP_DIR})"
    return
  fi
  log "백업 디렉터리: ${BACKUP_DIR}"
  ls -lh "${BACKUP_DIR}"/*.dump 2>/dev/null || log "(백업 파일이 없습니다)"
}

prune_backups() {
  local count
  count="$(find "${BACKUP_DIR}" -maxdepth 1 -name '*.dump' | wc -l)"
  if [[ "${count}" -le "${KEEP_COUNT}" ]]; then
    return
  fi
  log "오래된 백업 정리 (최근 ${KEEP_COUNT}개 유지)"
  find "${BACKUP_DIR}" -maxdepth 1 -name '*.dump' -printf '%T@ %p\n' |
    sort -n | head -n "-${KEEP_COUNT}" | cut -d' ' -f2- |
    while read -r old; do
      log "  삭제: ${old}"
      rm -f "${old}"
    done
}

restore_backup() {
  local file="${1:?백업 파일 경로가 필요합니다}"
  [[ -f "${file}" ]] || fail "파일이 없습니다: ${file}"
  require_db
  verify_backup "${file}"

  # 복원은 기존 데이터를 덮어쓴다. 되돌릴 수 없으므로 반드시 확인을 받는다.
  cat <<WARNING

경고: 복원은 '${DB_NAME}' 데이터베이스의 현재 내용을 덮어씁니다.
      지금 들어 있는 기록은 사라집니다. 되돌릴 수 없습니다.

      복원 전에 현재 상태를 백업하려면 먼저 이렇게 실행하세요:
        scripts/backup.sh

WARNING
  printf "복원을 진행하려면 정확히 'restore' 를 입력하세요: "
  local answer
  read -r answer
  [[ "${answer}" == "restore" ]] || fail "취소했습니다"

  log "복원 중: ${file}"
  # --clean --if-exists 로 기존 객체를 지우고 넣는다. 부분 복원은 스키마가 섞여 더 위험하다.
  compose exec -T "${DB_SERVICE}" pg_restore -U "${DB_USER}" -d "${DB_NAME}" \
    --clean --if-exists --no-owner --no-privileges </"${file}" || {
    log "경고: pg_restore 가 일부 오류를 보고했습니다. 위 메시지를 확인하세요."
    log "      (존재하지 않는 객체를 지우려 할 때 나오는 오류는 무해합니다)"
  }
  log "복원이 끝났습니다. 애플리케이션을 재시작하세요: docker compose restart api"
}

main() {
  case "${1:-}" in
    "" | --backup | backup)
      create_backup
      ;;
    --list | list)
      list_backups
      ;;
    --verify | verify)
      verify_backup "${2:?검증할 백업 파일 경로가 필요합니다}"
      ;;
    --restore | restore)
      restore_backup "${2:?복원할 백업 파일 경로가 필요합니다}"
      ;;
    *)
      fail "알 수 없는 인자: $1 (사용법: --backup | --list | --verify <파일> | --restore <파일>)"
      ;;
  esac
}

main "$@"
