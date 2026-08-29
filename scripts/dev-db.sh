#!/usr/bin/env bash
# 로컬 개발용 PostgreSQL 을 사용자 영역에서 실행한다.
#
# 이 개발 환경에는 Docker 도, 시스템 PostgreSQL 도 없고 passwordless sudo 도 쓸 수
# 없다. micromamba 로 conda-forge 의 PostgreSQL 을 홈 디렉토리 아래에 설치해 root
# 없이 실행한다. 운영은 docker-compose.yml 의 postgres:17-alpine 을 쓰고, CI 는
# GitHub Actions 의 services: postgres 를 쓴다. 세 환경 모두 PostgreSQL 17 이다.
#
#   scripts/dev-db.sh setup    # 최초 1회: micromamba 와 PostgreSQL 설치
#   scripts/dev-db.sh start
#   scripts/dev-db.sh stop
#   scripts/dev-db.sh status
#   scripts/dev-db.sh psql
#   scripts/dev-db.sh reset     # 데이터 삭제 후 재생성

set -euo pipefail

PREFIX="${SOOLJANG_DEV_DB_PREFIX:-$HOME/.local/share/sooljang}"
ENV_DIR="$PREFIX/pgenv"
DATA_DIR="$PREFIX/pgdata"
SOCKET_DIR="$PREFIX/run"
LOG_FILE="$PREFIX/postgres.log"
MICROMAMBA="$PREFIX/bin/micromamba"
PORT="${SOOLJANG_DEV_DB_PORT:-54329}"
USER_NAME="${SOOLJANG_DEV_DB_USER:-sooljang}"
DEV_DB="${SOOLJANG_DEV_DB_NAME:-sooljang_dev}"
TEST_DB="${SOOLJANG_TEST_DB_NAME:-sooljang_test}"
PG_VERSION="17"

log() { printf '\033[36m[dev-db]\033[0m %s\n' "$1"; }
die() { printf '\033[31m[dev-db]\033[0m %s\n' "$1" >&2; exit 1; }

pg() { "$ENV_DIR/bin/$1" "${@:2}"; }

cmd_setup() {
    mkdir -p "$PREFIX/bin" "$SOCKET_DIR"

    if [[ ! -x "$MICROMAMBA" ]]; then
        log "micromamba 를 설치합니다"
        curl -fsSL https://micro.mamba.pm/api/micromamba/linux-64/latest \
            | tar -xj -C "$PREFIX" bin/micromamba
    fi

    if [[ ! -x "$ENV_DIR/bin/postgres" ]]; then
        log "PostgreSQL $PG_VERSION 을 설치합니다 (몇 분 걸릴 수 있습니다)"
        "$MICROMAMBA" create -y -q -p "$ENV_DIR" -c conda-forge "postgresql=$PG_VERSION"
    fi

    if [[ ! -f "$DATA_DIR/PG_VERSION" ]]; then
        log "데이터 디렉토리를 초기화합니다"
        # 로컬 개발 전용이며 루프백에만 바인딩하므로 trust 인증을 쓴다.
        # 운영은 docker-compose 가 비밀번호 인증을 사용한다.
        pg initdb -D "$DATA_DIR" -U "$USER_NAME" --auth=trust \
            --encoding=UTF8 --locale=C.UTF-8 > /dev/null
    fi

    cmd_start
    for database in "$DEV_DB" "$TEST_DB"; do
        if ! pg psql -h 127.0.0.1 -p "$PORT" -U "$USER_NAME" -d postgres -tAc \
            "SELECT 1 FROM pg_database WHERE datname = '$database'" | grep -q 1; then
            log "데이터베이스 $database 를 만듭니다"
            pg createdb -h 127.0.0.1 -p "$PORT" -U "$USER_NAME" "$database"
        fi
    done

    log "준비 완료"
    log "  SOOLJANG_DATABASE_URL=postgresql+psycopg://$USER_NAME@127.0.0.1:$PORT/$DEV_DB"
}

cmd_start() {
    [[ -x "$ENV_DIR/bin/pg_ctl" ]] || die "먼저 'scripts/dev-db.sh setup' 을 실행하세요"
    if cmd_status > /dev/null 2>&1; then
        log "이미 실행 중입니다 (port $PORT)"
        return 0
    fi
    mkdir -p "$SOCKET_DIR"
    pg pg_ctl -D "$DATA_DIR" -l "$LOG_FILE" \
        -o "-p $PORT -k $SOCKET_DIR -c listen_addresses=127.0.0.1" -w start > /dev/null
    log "기동 완료 (port $PORT, 로그 $LOG_FILE)"
}

cmd_stop() {
    [[ -x "$ENV_DIR/bin/pg_ctl" ]] || die "설치되지 않았습니다"
    pg pg_ctl -D "$DATA_DIR" -m fast -w stop > /dev/null 2>&1 || log "실행 중이 아닙니다"
    log "정지 완료"
}

cmd_status() {
    pg pg_ctl -D "$DATA_DIR" status
}

cmd_psql() {
    pg psql -h 127.0.0.1 -p "$PORT" -U "$USER_NAME" -d "${1:-$DEV_DB}"
}

cmd_reset() {
    log "데이터를 모두 삭제하고 다시 만듭니다"
    cmd_stop || true
    rm -rf "$DATA_DIR"
    cmd_setup
}

case "${1:-}" in
    setup) cmd_setup ;;
    start) cmd_start ;;
    stop) cmd_stop ;;
    status) cmd_status ;;
    psql) cmd_psql "${2:-}" ;;
    reset) cmd_reset ;;
    *)
        echo "사용법: $0 {setup|start|stop|status|psql|reset}" >&2
        exit 2
        ;;
esac
