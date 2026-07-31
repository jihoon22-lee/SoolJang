# 세션 인계 문서

**다른 세션에서 이 작업을 이어받는 사람을 위한 문서다.** 이것을 먼저 읽고,
[plan.md](plan.md) §1(현재 위치)로 넘어가면 된다.

- 최종 갱신: **2026-08-01 00:35 KST**
- 저장소: `https://github.com/jihoon22-lee/SoolJang` (private, 소유자 `jihoon22-lee`)
- 로컬 경로: `/mnt/e/projects/SoolJang`
- 현재 브랜치: `feature/domain-model` (Task 7)
- 버전: `0.1.0` (**태그 없음.** 릴리스는 Task 23에서 1회만)

---

## 1. 5분 안에 작업 재개하기

```bash
cd /mnt/e/projects/SoolJang

# 1) 상태 확인
git status -sb && git log --oneline -5
gh pr list --state all --limit 5

# 2) 훅 활성화 (클론 직후 1회)
bash scripts/install-hooks.sh

# 3) 의존성
uv sync
npm ci --prefix web

# 4) 데이터베이스 (Docker 기본)
sg docker -c "docker compose up -d db"     # ← sg 가 필요한 이유는 §5 참조
export SOOLJANG_DATABASE_URL="postgresql+psycopg://sooljang:<암호>@127.0.0.1:5432/sooljang"
uv run alembic upgrade head

# 5) 검증
uv run pytest                  # 145 passed, 14 skipped 가 정상
npm --prefix web run check

# 6) 이어서 작업
#    plan.md §1 의 "다음 착수 Task" 를 확인하고 해당 브랜치를 만든다
```

`.env` 가 없으면 `.env.example` 을 복사하고 `POSTGRES_PASSWORD` 를 채운다.
Docker 를 쓸 수 없으면 `make db-local-setup` → `make db-local-start` 폴백을 쓴다
(micromamba 로 홈 디렉토리에 PostgreSQL 17 설치, root 불필요, 포트 54329).

---

## 2. 지금까지 한 일

전체 23개 Task 중 **7개 완료**. PR 6개 머지.

| Task | 상태 | PR | 핵심 산출물 |
|---|---|---|---|
| 1. 환경 부트스트랩 | ✅ | — | private repo, `.gitignore`, `README.md`, `AGENTS.md` |
| 2. 아키텍처 설계 문서 | ✅ | [#1](https://github.com/jihoon22-lee/SoolJang/pull/1) | `docs/architecture.md`, `docs/legacy-schema.md` |
| 3. 작업 계획 문서 | ✅ | [#2](https://github.com/jihoon22-lee/SoolJang/pull/2) | `docs/plan.md` |
| 4. CI/CD | ✅ | [#3](https://github.com/jihoon22-lee/SoolJang/pull/3) | 품질 게이트 9잡, 릴리스 워크플로(미실행), git 훅 |
| 5. 애플리케이션 골격 | ✅ | [#4](https://github.com/jihoon22-lee/SoolJang/pull/4) | FastAPI + React PWA + Docker Compose |
| 6. 레거시 CSV 파서 | ✅ | [#5](https://github.com/jihoon22-lee/SoolJang/pull/5) | `src/sooljang/infrastructure/legacy/` |
| 7. 도메인 모델 | ✅ | [#6](https://github.com/jihoon22-lee/SoolJang/pull/6) | 테이블 9개, 마이그레이션 `0002_domain_model`, 카테고리 계층 서비스 |

### 검증된 사실 (다시 확인할 필요 없음)

| 항목 | 증거 |
|---|---|
| CI 9개 잡 전부 통과 | GitHub Actions run `30638155479` |
| 릴리스 워크플로 dry-run 정상 | run `30635176940` — 게시 3단계 skipped, 릴리스·태그 0건 |
| Docker Compose 전체 스택 동작 | `db`/`api`/`web` 모두 `healthy`, web(8080) 경유 `/health` → `200 ok` |
| Alembic 왕복 | 사용자 영역 + Docker `postgres:17-alpine` 양쪽에서 up→down→up 성공 |
| `pg_trgm` 한글 부분 검색 | `EXPLAIN` 에서 `Bitmap Index Scan on t_name_trgm` 확인 |
| 레거시 파서가 실제 시트를 정확히 읽음 | §3 참조 |
| 도메인 모델·마이그레이션 정합 | DB 테스트 45개 통과, `alembic check` 드리프트 없음, metadata 기준 드리프트도 없음 |
| 엑셀 한계 해결 확인 | 같은 제품에 구매처·가격·구매일이 다른 구매 건 2건 + 개별 병 3개 저장 성공 |

---

## 3. 레거시 파서 검증 결과 (Task 6)

실제 시트(`/mnt/e/alcohol.csv`, 커밋하지 않음)에 대해 opt-in 테스트 14개 전부 통과.

```
본 테이블 분리 결과
  레코드            429건
  통과한 빈 행      1개 [326]        ← 함정 1 통과
  배제한 합계행     1개 [432]        ← 함정 2 배제
  배제한 행         100개 (통계 블록 등)
집계
  구매 / 소비 / 재고   1,078 / 819 / 259병
  미개봉 / 개봉        225 / 34병
  정가 총액            42,401,108원
  실구매 총액          36,495,454원
  총 용량              704,970ml
  고유 구매처          82곳
확인이 필요한 항목
  구매처 여러 곳       28행 (구매 건 분할 후보)
  주종 사전 미등록     0종
  경고                 0건
```

모두 `docs/legacy-schema.md` §5 의 기준값과 일치한다. 추가 검증: 빈티지 분리 99행,
외부 평점 태그 RB 28 / U 19 / BA 18 / 무태그 107, 외화 15행, 총액→병당 단가 환산이 시트의
평단가 컬럼과 380건 이상 비교해 불일치 0.

### 재실행 방법

```bash
# 요약 출력 (데모)
uv run python -m sooljang.infrastructure.legacy.report /mnt/e/alcohol.csv --samples 0

# 실제 파일 대조 검증 (opt-in, 기본은 skip)
SOOLJANG_LEGACY_SHEET=/mnt/e/alcohol.csv uv run pytest -m requires_legacy_sheet

# 합성 픽스처 재생성 (실제 데이터를 커밋하지 않기 위한 대체물)
python3 scripts/generate_legacy_fixture.py
```

---

## 4. 남은 일

`docs/plan.md` §3·§4 에 Task 7~21 의 목표·산출물·테스트 요구사항·데모 기준이 모두 있다.
아래는 우선순위와 주의점만 요약한다.

### 다음 착수: Task 8 — 파생 지표 계산 계층 (`feature/derived-metrics`)

- `src/sooljang/domain/metrics.py` 를 **순수 함수**로 구현한다. SQLAlchemy·HTTP 를
  import 하지 않아야 DB 없이 단위 테스트할 수 있다
- 같은 공식을 SQL 로도 구현하고 **두 구현이 같은 결과를 내는지 검증하는 테스트**를 둔다
- 100ml당 가격은 **정가 기준**이다 (실구매 기준으로 계산하면 레거시와 168건 불일치)
- 가격이 NULL 인 구매 건(선물)은 금액 집계에서 제외하되 병수 집계에는 포함한다
- 사양: `docs/architecture.md` §3 에 수식 수준으로 있다

### 핵심 마일스톤: Task 12 (인증 + Tailscale HTTPS)

이 지점부터 폰에서 실사용이 가능해진다. Task 16(바코드)·17(OCR)·15(PWA)는 secure context 가
필요하므로 Task 12 없이는 폰에서 검증할 수 없다.

### 의존 관계 요약

```
7 도메인모델 → 8 파생지표 → 9 REST API → 10 웹 UI → 12 인증·HTTPS → 13 병·시음 → 15 PWA → 16 바코드 → 17 OCR
6 파서 ─┬→ 11 임포터 → 14 통계v1 → 18 외부소스 → 19 사이트어댑터 ─┐
8,10 ──┘                        └→ 20 통계v2 ────────────────────┴→ 21 릴리스
```

### 마지막 Task 23 에서만 하는 일

버전 태그(`v1.0.0`) 푸시. `pre-push` 훅이 태그 푸시를 차단하므로
`SOOLJANG_ALLOW_TAG_PUSH=1` 로 우회해야 한다. 그 전까지는 **절대 태그를 푸시하지 않는다.**

---

## 5. 이 환경에서 반드시 알아야 할 함정

| 함정 | 증상 | 대응 |
|---|---|---|
| **docker 그룹 미반영** | `permission denied ... /var/run/docker.sock` | 새 셸을 열거나 `sg docker -c "docker ..."` 로 감싼다 |
| **브랜치 보호 불가** | ruleset API 가 HTTP 403 `Upgrade to GitHub Pro` | 로컬 `pre-push` 훅이 대체한다. `bash scripts/install-hooks.sh` 를 잊지 말 것 |
| **테스트가 로컬 `.env` 를 읽음** | 개발자마다 테스트 결과가 다름 | 해결됨. `conftest.py` 가 `SOOLJANG_ENV_FILE=""` 로 차단한다 |
| **CI 환경 변수 접두사** | `DATABASE_URL` 은 무시된다 | 반드시 `SOOLJANG_` 접두사를 쓴다 |
| **uv 이미지에 Python 3.14 태그 없음** | `not found` 로 이미지 빌드 실패 | `python:3.14-slim` + 버전 고정 uv 설치 스크립트를 쓴다 |
| **hatchling 이 README 를 요구** | 컨테이너 빌드 중 `build_editable` 실패 | Dockerfile 이 `README.md` 를 복사해야 한다 |
| **vitest 4 의 defineConfig 출처** | `'test' does not exist in type 'UserConfigExport'` | `vitest/config` 에서 import 한다 |
| **CP949 인코딩 불가 문자** | 픽스처 생성 시 `UnicodeEncodeError` | 픽스처에 `é` 같은 문자를 쓰지 않는다 |
| **`pgserver` PyPI** | Python 3.14 휠 없음 | 쓰지 않는다. Docker 또는 micromamba 폴백 |
| **SQLAlchemy Enum 이 이름을 저장** | `status <> 'unopened'` CHECK 제약이 조용히 무력화 | `base.str_enum_column` 헬퍼를 쓴다 (값으로 저장) |
| **재귀 CTE 타입 불일치** | `recursive query ... column has type character varying(120)` | 비재귀 항의 경로 컬럼을 `text` 로 캐스팅한다 |
| **모델 import 누락** | `create_all` 이 아무 테이블도 만들지 않고 조용히 통과 | conftest·alembic env 가 `database.models` 를 import 해야 한다 |
| **마이그레이션 파일 삭제 순서** | DB 가 없는 리비전을 가리켜 `Can't locate revision` | 파일을 지우기 **전에** `alembic downgrade` 를 먼저 한다 |

---

## 6. 절대 규칙 (위반 시 사용자 요구사항 위반)

1. `main` 에 직접 푸시하지 않는다 (저장소 부트스트랩 커밋만 예외)
2. 개발 기간 중 `v*.*.*` 태그를 푸시하지 않는다 (Task 23 전용)
3. 실제 음주 기록(`alcohol.csv`·`alcohol.xlsx`), `.env`, 백업 덤프, 업로드 이미지를
   커밋하지 않는다. 테스트는 `scripts/generate_legacy_fixture.py` 가 만드는 합성 픽스처만 쓴다
4. 모든 Task PR 에 `docs/plan.md` 와 이 문서의 갱신을 포함한다
5. 커밋 메시지는 Conventional Commits 를 지킨다. 사용자가 읽는 텍스트는 한글 우선
6. Task 1개 = `feature/<slug>` 브랜치 1개 = PR 1개. 머지는 `gh pr merge --merge`
   (커밋 단위를 히스토리에 남기기 위해 squash 를 쓰지 않는다)
7. 모든 API 는 인증을 요구한다 (`/health` 예외)
8. 파생값을 DB 에 저장하지 않는다
9. 외부 데이터는 출처 URL 없이 저장하지 않는다

---

## 7. 사용자와 확인이 필요한 열린 질문

`docs/plan.md` §6 에 표로 관리한다. 필요 시점이 가까운 것부터:

| # | 질문 | 필요 시점 |
|---|---|---|
| Q4 | Tailscale 설치 여부와 tailnet 이름 (HTTPS 인증서 발급에 필요) | Task 12 |
| Q2 | 검색·LLM API 제공자와 예산 | Task 17 |
| Q3 | 초기 등록할 외부 소스 사이트 목록 | Task 18 |
| Q5 | 목표가 알림 채널 (웹 푸시 vs 다른 수단) | Task 19 |
| Q6 | 지인 공유 권한 모델 상세 | Task 20 |

Q1(데이터베이스 실행 방식)은 Task 5 에서 해결했다.

---

## 8. 사용자가 진행 중에 준 추가 요구사항

계획 확정 이후 사용자가 추가한 내용이다. 반영 상태를 함께 적는다.

| 요구사항 | 반영 상태 |
|---|---|
| 배포는 모든 작업이 끝난 뒤 1회만. 워크플로는 미리 작성 | ✅ Task 4에서 `release.yml` 작성, 미실행. `pre-push` 가 태그 차단 |
| 단일 시트에 술 테이블과 통계 테이블이 섞여 있으니 잘 구분할 것 | ✅ Task 6 파서가 함정 3종을 모두 처리. 회귀 테스트로 고정 |
| Docker 설치했으니 사용해도 됨 | ✅ 로컬 DB 기본 경로를 Docker Compose 로 전환 |
| **카테고리를 사용자가 자유롭게 추가·수정·삭제·설정. 기본값은 기존 CSV 기준** | ✅ 설계 반영 (`architecture.md` §2.3). 깊이 제한 없음, CRUD·reparent·reorder·merge·reset-seed API 정의. 코드에서 `DEFAULT_CATEGORY_PATHS`(기본 시드)로 재프레이밍. **Task 7·9 구현 시 반드시 이 설계를 따를 것** |
| 8/1 08:30 KST 까지 미완이면 인계 문서 남기고 종료 | ✅ 이 문서. 매 Task 완료 시 갱신한다 |
| **모든 작업 후 자체 통합 테스트 + 다각도 분석(사용성·UI/UX·기능) → 추가 계획 수립 → 이어서 작업** | ✅ **Task 21(자체 통합 테스트와 다각도 분석)·Task 22(개선 실행) 신설.** 릴리스는 Task 23 으로 이동. 릴리스를 분석 뒤에 두어 개선 여지를 아는 상태로 `v1.0.0` 을 내보내지 않는다. 상세는 [plan.md](plan.md) §4 Task 21·22, 백로그는 §9 |
