# 술장 개발 명령. 모든 명령은 저장소 루트에서 실행한다.

SHELL := /bin/bash
.DEFAULT_GOAL := help

DEV_DB_PORT ?= 54329
DEV_DB_URL ?= postgresql+psycopg://sooljang@127.0.0.1:$(DEV_DB_PORT)/sooljang_dev
TEST_DB_URL ?= postgresql+psycopg://sooljang@127.0.0.1:$(DEV_DB_PORT)/sooljang_test

export SOOLJANG_DATABASE_URL ?= $(DEV_DB_URL)

.PHONY: help
help: ## 사용 가능한 명령 목록
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------------------
# 환경 준비
# ---------------------------------------------------------------------------
.PHONY: install
install: ## 의존성 설치와 git 훅 활성화
	uv sync
	npm ci --prefix web
	bash scripts/install-hooks.sh

# ---------------------------------------------------------------------------
# 데이터베이스
#
# 기본 경로는 Docker Compose 다. 운영과 같은 postgres:17-alpine 이미지를 쓰므로
# 동작 차이가 없다. Docker 를 쓸 수 없는 상황(그룹 반영 전, 데몬 미기동)에서는
# db-local-* 폴백을 쓴다. scripts/dev-db.sh 가 micromamba 로 홈 디렉토리에
# PostgreSQL 17 을 설치해 root 없이 실행한다.
# ---------------------------------------------------------------------------
.PHONY: db-up
db-up: ## PostgreSQL 기동 (Docker, 기본 경로)
	docker compose up -d db
	docker compose exec -T db bash -c 'until pg_isready -U $${POSTGRES_USER:-sooljang}; do sleep 1; done'
	docker compose exec -T db psql -U $${POSTGRES_USER:-sooljang} -d postgres \
		-c "SELECT 'CREATE DATABASE sooljang_test' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'sooljang_test')\gexec"

.PHONY: db-down
db-down: ## PostgreSQL 정지 (Docker)
	docker compose stop db

.PHONY: db-local-setup
db-local-setup: ## 폴백: 사용자 영역 PostgreSQL 설치 (Docker 없이, 최초 1회)
	bash scripts/dev-db.sh setup

.PHONY: db-local-start
db-local-start: ## 폴백: 사용자 영역 PostgreSQL 기동
	bash scripts/dev-db.sh start

.PHONY: db-local-stop
db-local-stop: ## 폴백: 사용자 영역 PostgreSQL 정지
	bash scripts/dev-db.sh stop

.PHONY: db-psql
db-psql: ## psql 셸 열기 (폴백 인스턴스)
	bash scripts/dev-db.sh psql

# ---------------------------------------------------------------------------
# 개발 실행
# ---------------------------------------------------------------------------
.PHONY: migrate
migrate: ## 마이그레이션을 head 까지 적용
	uv run alembic upgrade head

.PHONY: migration
migration: ## 새 마이그레이션 생성 (make migration m="설명")
	uv run alembic revision --autogenerate -m "$(m)"

.PHONY: api
api: ## API 개발 서버 기동
	uv run sooljang-api

.PHONY: web
web: ## 프론트엔드 개발 서버 기동
	npm --prefix web run dev

# ---------------------------------------------------------------------------
# 검증
# ---------------------------------------------------------------------------
.PHONY: lint
lint: ## 린트와 포맷 검사
	uv run ruff check .
	uv run ruff format --check .
	npm --prefix web run lint

.PHONY: format
format: ## 자동 포맷 적용
	uv run ruff check --fix .
	uv run ruff format .
	npm --prefix web run lint:fix

.PHONY: typecheck
typecheck: ## 정적 타입 검사
	uv run ty check
	npm --prefix web run typecheck

.PHONY: test
test: ## 테스트 실행 (브랜치 커버리지 85% / 80% 강제)
	SOOLJANG_DATABASE_URL=$(TEST_DB_URL) uv run pytest
	npm --prefix web run test:coverage

.PHONY: migration-check
migration-check: ## 마이그레이션 up/down 왕복과 모델 드리프트 검사
	SOOLJANG_DATABASE_URL=$(TEST_DB_URL) uv run alembic upgrade head
	SOOLJANG_DATABASE_URL=$(TEST_DB_URL) uv run alembic downgrade base
	SOOLJANG_DATABASE_URL=$(TEST_DB_URL) uv run alembic upgrade head

.PHONY: scan
scan: ## 시크릿·개인 데이터 커밋 여부 확인
	bash scripts/scan-secrets.sh

.PHONY: check
check: lint typecheck test scan ## CI 와 동일한 전체 검증

# ---------------------------------------------------------------------------
# 배포 (Task 21 이후 사용)
# ---------------------------------------------------------------------------
.PHONY: build
build: ## 컨테이너 이미지 로컬 빌드
	docker compose build

.PHONY: deploy
deploy: ## GHCR 에 게시된 이미지를 pull 해 재기동
	docker compose pull
	docker compose up -d
	docker compose ps

.PHONY: backup
backup: ## 데이터베이스 덤프 생성
	@mkdir -p backups
	docker compose exec -T db pg_dump -Fc -U sooljang sooljang \
		> "backups/sooljang-$$(date +%Y%m%d-%H%M%S).dump"
	@echo "backups/ 에 덤프를 만들었습니다"
