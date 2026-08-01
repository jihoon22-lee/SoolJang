# 세션 인계 문서

**다른 세션에서 이 작업을 이어받는 사람을 위한 문서다.** 이것을 먼저 읽고,
[plan.md](plan.md) §1(현재 위치)로 넘어가면 된다.

- 최종 갱신: **2026-08-01 (Task 14 PR)**
- 저장소: `https://github.com/jihoon22-lee/SoolJang` (private, 소유자 `jihoon22-lee`)
- 로컬 경로: `/mnt/e/projects/SoolJang`
- 현재 브랜치: `main` (Task 14 까지 완료)
- 버전: `0.1.0` (**태그 없음.** 릴리스는 Task 23에서 1회만)

> 이 문서보다 최신 세션의 상세 기록이 필요하면 `docs/session-handoff-*.md` (날짜 스탬프
> 파일)를 확인한다. 이 문서는 프로젝트 전체를 아우르는 상시 갱신 문서이고, 날짜 스탬프
> 파일은 특정 세션 종료 시점의 스냅샷이다.

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

## 1-1. 실제 데이터로 앱 써 보기

Task 11 로 실제 429행이 들어간다. 직접 확인하려면 이렇게 한다.

```bash
# 1) DB 기동 후 마이그레이션
sg docker -c "docker compose up -d db"        # 새 셸이면 sg 없이 docker compose
export SOOLJANG_DATABASE_URL="postgresql+psycopg://sooljang:<암호>@127.0.0.1:5432/sooljang"
uv run alembic upgrade head

# 2) API 기동 (Compose api 컨테이너가 8000 을 쓰므로 다른 포트를 쓴다)
SOOLJANG_API_PORT=8210 uv run sooljang-api

# 3) 프론트엔드 (다른 터미널)
SOOLJANG_API_URL=http://127.0.0.1:8210 npm --prefix web run dev
# → http://127.0.0.1:5173 접속, "가져오기" 화면에서 /mnt/e/alcohol.csv 업로드
#   반드시 "분석 (미리보기)" 로 먼저 확인한 뒤 "적재 실행"
```

CLI 로 요약만 보려면:

```bash
uv run python -m sooljang.infrastructure.legacy.report /mnt/e/alcohol.csv --samples 0
```

적재는 재실행해도 중복이 생기지 않는다. 실수로 두 번 눌러도 안전하다.


### 로그인이 필요해졌다 (Task 12)

이제 모든 화면이 로그인을 요구한다. 처음 켜면 계정 생성 폼이 뜬다.

```bash
# API 로 직접 확인할 때
curl -s http://127.0.0.1:8210/api/v1/auth/setup          # {"needs_setup":true}
curl -c /tmp/j -X POST http://127.0.0.1:8210/api/v1/auth/setup \
  -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"열자이상비밀번호","display_name":"나"}'
# 이후 요청은 -b /tmp/j 로 쿠키를 실어 보낸다.
# 쓰기 요청은 X-CSRF-Token 헤더가 추가로 필요하다 (응답의 csrf_token 값).
```

비밀번호를 잊었다면 DB 에서 사용자를 지우고 다시 설정한다.

```bash
docker compose exec -T db psql -U sooljang -d sooljang -c 'DELETE FROM app_user'
```

### 폰에서 접속하기

```bash
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
scripts/serve-https.sh            # 접속 주소를 알려준다
```

HTTPS 가 필요한 이유는 편의가 아니다. 카메라(Task 16·17)와 서비스 워커(Task 15)는
브라우저가 secure context 를 요구해 평문 HTTP 에서는 아예 동작하지 않는다.

### 백업

```bash
scripts/backup.sh                 # 생성 + 검증까지
scripts/backup.sh --list
scripts/backup.sh --restore <파일>  # 확인을 묻는다. 기존 데이터를 덮어쓴다
```

---

## 2. 지금까지 한 일

전체 23개 Task 중 **14개 완료**. PR 21개 머지 (#1~#21, #16~#20 은 문서 전용 — 이후 규칙
9(§6)로 금지된 관행이니 반복하지 않는다).

| Task | 상태 | PR | 핵심 산출물 |
|---|---|---|---|
| 1. 환경 부트스트랩 | ✅ | — | private repo, `.gitignore`, `README.md`, `AGENTS.md` |
| 2. 아키텍처 설계 문서 | ✅ | [#1](https://github.com/jihoon22-lee/SoolJang/pull/1) | `docs/architecture.md`, `docs/legacy-schema.md` |
| 3. 작업 계획 문서 | ✅ | [#2](https://github.com/jihoon22-lee/SoolJang/pull/2) | `docs/plan.md` |
| 4. CI/CD | ✅ | [#3](https://github.com/jihoon22-lee/SoolJang/pull/3) | 품질 게이트 9잡, 릴리스 워크플로(미실행), git 훅 |
| 5. 애플리케이션 골격 | ✅ | [#4](https://github.com/jihoon22-lee/SoolJang/pull/4) | FastAPI + React PWA + Docker Compose |
| 6. 레거시 CSV 파서 | ✅ | [#5](https://github.com/jihoon22-lee/SoolJang/pull/5) | `src/sooljang/infrastructure/legacy/` |
| 7. 도메인 모델 | ✅ | [#6](https://github.com/jihoon22-lee/SoolJang/pull/6) | 테이블 9개, 마이그레이션 `0002_domain_model`, 카테고리 계층 서비스 |
| 8. 파생 지표 | ✅ | [#7](https://github.com/jihoon22-lee/SoolJang/pull/7) | `domain/metrics.py` 순수 함수 + `metrics_sql.py` SQL 구현 + 일치 검증 |
| 9. REST API | ✅ | [#8](https://github.com/jihoon22-lee/SoolJang/pull/8) | 엔드포인트 17개, 커서 페이지네이션, Problem Details, 카테고리 관리 API |
| 10. 웹 UI | ✅ | [#9](https://github.com/jihoon22-lee/SoolJang/pull/9) | 목록(PC 테이블/모바일 카드)·필터·상세·등록 폼·카테고리 관리 트리 |
| 11. 레거시 임포터 | ✅ | [#10](https://github.com/jihoon22-lee/SoolJang/pull/10) | dry-run 미리보기 + 적재 + 멱등성. **실제 429행 적재 성공** |
| 12. 인증과 로컬 HTTPS | ✅ | [#13](https://github.com/jihoon22-lee/SoolJang/pull/13) | 세션 쿠키 인증, CSRF, 레이트 리밋, `serve-https.sh`, `backup.sh` |
| 13. 병 관리·시음 세션 | ✅ | [#14](https://github.com/jihoon22-lee/SoolJang/pull/14), [#15](https://github.com/jihoon22-lee/SoolJang/pull/15) | 상태 전이·잔량 추적·시음 기록. 엔드포인트 35개로 증가 |
| 14. 통계 대시보드 v1 | ✅ | [#21](https://github.com/jihoon22-lee/SoolJang/pull/21) | `/stats/rankings`·`/stats/by-category`·`/stats/summary`, 통계 화면. 엑셀 실측값과 대조 |

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
| 파생 지표 이중 구현 일치 | 12개 시나리오에서 순수 함수와 SQL 결과 동일. 레거시 실측 케이스(100ml당 3,197.33원 등) 재현 |
| REST API 실동작 | 실서버에서 복합 조건 조회·한글 검색·Problem Details·구매 건 분할 확인. 엔드포인트 17개 |
| 웹 UI 실동작 | Vite 프록시 경유로 제품 4건·카테고리 45개 조회 성공. 프론트엔드 테스트 131개 통과(커버리지 90.9%) |
| **실제 데이터 이관 완료** | 429행 → 제품 405종(24종 병합)·병 1,078개·구매 건 434건. 정가 ₩42,401,108·용량 704,970ml·소비 819/미개봉 225/개봉 34 모두 엑셀 합계행과 일치. 실패 0건. 재실행 시 중복 0 |

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

### 다음 착수: Task 15 — PWA와 오프라인 동기화 (`feature/pwa-sync`)

Task 12(인증·HTTPS)까지 마쳐 폰에서 실사용이 가능하다. 이제 오프라인에서도 기록할 수
있게 만든다. 사양은 `docs/architecture.md` §5.

1. Workbox 앱 셸, PWA manifest
2. Dexie 로 IndexedDB 에 로컬 미러 유지
3. outbox 직렬 큐 — 오프라인 중 생성한 기록을 순서대로 재전송
4. `GET /sync?since=<cursor>` — `(updated_at, id)` 복합 커서로 델타 풀
5. LWW(last-write-wins) 병합, soft delete 전파, idempotency 로 재전송 중복 방지
6. 동기화 상태 UI

**Tailscale 해결됨** (§7-Q4, 2026-08-01): 설치·로그인 완료. tailnet `tail30f401.ts.net`,
이 머신 호스트명 `main` → 접속 주소 `https://main.tail30f401.ts.net`. 폰에 Tailscale 앱
설치 + 같은 계정 로그인만 남았다.

**공개 전 필수**: 현재 떠 있는 Docker 컨테이너(`sooljang-api-1`·`sooljang-web-1`)는 Task 12
(인증) 이전 빌드라 `/auth/setup` 이 404 난다. `scripts/serve-https.sh` 실행 전에 반드시
재빌드한다.

```bash
docker compose up -d --build
scripts/serve-https.sh
```

Task 16(바코드)·17(OCR)이 secure context 를 요구하므로 HTTPS 공개 없이는 카메라 기능을
폰에서 확인할 수 없다.

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
| **Compose `api` 컨테이너가 8000 포트 점유** | 로컬 서버가 `Address already in use`, 또는 구버전 코드가 응답 | `docker compose stop api` 하거나 `SOOLJANG_API_PORT` 로 다른 포트를 쓴다 |
| **관계 컬렉션이 낡은 값 유지** | 품종을 교체했는데 응답에 이전 값이 남음 | 수정 후 `session.expire(obj, ["관계명"])` 로 만료시킨다 |
| **flush 직후 Decimal 정밀도** | 생성 응답은 `85000`, 재조회는 `85000.00` | 응답 전에 `session.refresh()` 로 저장된 값을 읽는다 |
| **FastAPI 파일 업로드** | `Form data requires "python-multipart"` | `python-multipart` 의존성이 필요하다 (추가됨) |
| **테스트 fetch 스텁과 FormData** | `[object FormData] is not valid JSON` | `testing.tsx` 의 `readBody` 가 FormData 를 파일 이름으로 변환한다 |
| **합성 픽스처로 못 잡는 결함** | 실제 데이터에서만 터지는 형식 변형 | 실측 파일 opt-in 테스트를 반드시 돌린다: `SOOLJANG_LEGACY_SHEET=/mnt/e/alcohol.csv uv run pytest -m requires_legacy_sheet` |

---

## 6. 절대 규칙 (위반 시 사용자 요구사항 위반)

1. `main` 에 직접 푸시하지 않는다 (저장소 부트스트랩 커밋만 예외)
2. 개발 기간 중 `v*.*.*` 태그를 푸시하지 않는다 (Task 23 전용)
3. 실제 음주 기록(`alcohol.csv`·`alcohol.xlsx`), `.env`, 백업 덤프, 업로드 이미지를
   커밋하지 않는다. 테스트는 `scripts/generate_legacy_fixture.py` 가 만드는 합성 픽스처만 쓴다
4. 모든 Task PR 에 `docs/plan.md` 와 이 문서의 갱신을 포함한다
5. 커밋 메시지는 Conventional Commits 를 지킨다. 사용자가 읽는 텍스트는 한글 우선
6. Task 1개 = `feature/<slug>` 브랜치 1개 = PR 1개. 머지는 `gh pr merge --merge`
   (커밋 단위를 히스토리에 남기기 위해 squash 를 쓰지 않는다). **PR을 계층별(백엔드/
   프론트엔드)로 쪼개거나 문서만 고치는 후속 PR을 따로 만들지 않는다** — 한 Task 의
   모든 변경(코드·테스트·문서)을 같은 PR 에 담는다(사용자 피드백, 2026-08-01. Task 13
   이 PR 7개로 쪼개졌던 것은 반례다)
7. 모든 API 는 인증을 요구한다 (`/health` 예외)
8. 파생값을 DB 에 저장하지 않는다
9. 외부 데이터는 출처 URL 없이 저장하지 않는다

---

## 7. 사용자와 확인이 필요한 열린 질문

`docs/plan.md` §6 에 표로 관리한다. 필요 시점이 가까운 것부터:

| # | 질문 | 필요 시점 |
|---|---|---|
| ~~Q4~~ | ~~Tailscale 설치 여부와 tailnet 이름~~ | **✅ 해결** — `tail30f401.ts.net`, `https://main.tail30f401.ts.net`. §4 참조 |
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
