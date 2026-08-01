# 세션 인계 문서

**다른 세션에서 이 작업을 이어받는 사람을 위한 문서다.** 이것을 먼저 읽고,
[plan.md](plan.md) §1(현재 위치)로 넘어가면 된다.

- 최종 갱신: **2026-08-02 (Task 16 PR)**
- 저장소: `https://github.com/jihoon22-lee/SoolJang` (private, 소유자 `jihoon22-lee`)
- 로컬 경로: `/mnt/e/projects/SoolJang`
- 현재 브랜치: `main` (Task 16 까지 완료)
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
uv run pytest                  # 557 passed, 27 skipped 가 정상 (skip 전부 opt-in 실측 테스트)
npm --prefix web run check     # 223 passed, 커버리지 임계값(branch 80%) 통과

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

전체 23개 Task 중 **16개 완료**. PR 23개 머지 (#1~#23, #16~#20 은 문서 전용 — 이후 규칙
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
| 15. PWA와 오프라인 동기화 | ✅ | [#22](https://github.com/jihoon22-lee/SoolJang/pull/22) | `application/sync.py`(pull·apply_batch·LWW·충돌 로그), Dexie 로컬 미러, outbox, 4개 화면 오프라인 조회, `SyncStatusBadge` |
| 16. 바코드 스캔과 제품 매칭 | ✅ | [#23](https://github.com/jihoon22-lee/SoolJang/pull/23) | `application/barcodes.py`(정규화·RCN 판별), Open Food Facts 조회, `GET /barcodes/{code}`·`PATCH /skus/{id}`, `BarcodeScanPanel`(네이티브 BarcodeDetector + ZXing 폴백) |

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
| 오프라인 동기화 백엔드·프론트 전체 검증 | `pytest` 521 passed, 27 skipped(전부 opt-in 실측 테스트), 커버리지 90.10%. 프론트엔드 207 passed, 커버리지 89.0% stmts / 80.2% branch. `vite build` 로 PWA manifest·`sw.js`·아이콘 정상 생성 확인 |
| 바코드 스캔 백엔드·프론트 전체 검증 | `pytest` 557 passed, 27 skipped, 커버리지 90.43%. 프론트엔드 223 passed, 커버리지 89.4% stmts / 80.17% branch. 카메라·`BarcodeDetector`·`@zxing/browser` 를 전부 가짜로 주입해 하드웨어 없이 스캐너 로직까지 검증. `docker build`(web·api) 둘 다 정상 |

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

### 다음 착수: Task 17 — 라벨 OCR 프리필, 단 **사용자 확인 필요**

Task 16(바코드 스캔)까지 마쳐 카메라로 기존 제품을 빠르게 매칭할 수 있다. 다음은 라벨
사진을 Vision LLM 으로 구조화 추출하는 단계인데, **Q2(검색·LLM API 제공자와 예산)가
아직 미해결**이라(`docs/plan.md` §6) 착수할 수 없다. 기존 프로젝트에 `anthropic`·
`google-genai`·`openai` 의존성이 있어 키를 보유하고 있을 가능성이 높지만, 어떤
제공자·모델·예산 상한을 쓸지는 사용자가 정해야 한다.

**Q2 가 풀리기 전까지 막히지 않는 대안**: Task 20(통계 v2 — 커스텀 피벗과 취향 분석)
은 외부 API 없이 Task 14 데이터만으로 진행할 수 있고, 의존 관계상 Task 17·18·19 를
거치지 않아도 된다(아래 다이어그램 참조).

**HTTPS 공개는 여전히 미완이다**: Tailscale 설치·로그인은 Task 14 세션에서 끝났지만
(tailnet `tail30f401.ts.net`), 이 브라우저 자동화가 동작하지 않는 샌드박스라 아직
실기기 수동 검증은 하지 못했다 — API·Dexie·바코드 스캔 로직은 전부 자동화 테스트(카메라는
가짜 주입)로만 검증했다. 실기기로 카메라·오프라인 동기화를 확인하려면 그 전에 한 번은
사람이 직접 다음을 해야 한다.

```bash
docker compose up -d --build   # 현재 컨테이너가 최신 코드인지 다시 확인
scripts/serve-https.sh
```

**Task 15 에서 남긴 것**: 오프라인 쓰기는 `category`·`product`·`sku`·`vendor`·`purchase`·
`bottle`·`tasting_session` 7개 엔티티로 제한했다(D72). `producer`·`variety` 는 풀(읽기)
대상일 뿐 오프라인에서 새로 만들 수 없다.

**Task 16 에서 남긴 것**: `PATCH /skus/{id}` 를 새로 만들었다(architecture.md 가 Task 9
산출물로 문서화했지만 실제로는 없었던 엔드포인트, D79). 바코드 스캔으로 만드는 새
제품·바코드 학습은 온라인 전용이다(outbox 를 거치지 않는다, D81) — 오프라인이면 "바코드로
스캔" 버튼 자체가 보이지 않는다.

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
| **새 셸에서 `pytest` 가 전부 `password authentication failed`** | `conftest.py` 의 `TEST_DATABASE_URL` 하드코딩 기본값 비밀번호(`sooljang`)가 `.env`/컨테이너의 실제 비밀번호(`localdevonly`)와 다르다 | `export SOOLJANG_DATABASE_URL=postgresql+psycopg://sooljang:<`.env`의 POSTGRES_PASSWORD`>@127.0.0.1:5432/sooljang_test` 를 먼저 설정한다 |
| **`useLiveQuery` 컴포넌트를 마운트 직후 동기 `getByText` 로 단언** | 플레이키 실패(첫 계산은 비동기라 로딩 중 빈 상태를 잡을 수 있다) | `findByText`/`findByRole` 로 기다린다. `SyncStatusBadge` 충돌 패널에서 실제로 겪음(Task 15) |
| **`web.Dockerfile` 은 `web/` 디렉터리만 이미지에 복사한다** | 저장소 루트의 다른 디렉터리(`tests/fixtures/` 등)를 상대 경로로 참조하는 프론트엔드 파일이 있으면 `Container build` 잡에서만 `tsc` 가 모듈을 못 찾는다(로컬 `npm run check` 는 통과) | 그 경로도 `COPY <경로>/ <컨테이너 내 같은 상대 위치>/` 로 명시적으로 추가한다. Task 15 의 `metrics.test.ts`(공유 골든값 픽스처) 에서 실제로 터졌다 |
| **버튼이 `disabled` 면 그 안의 유효성 검사 분기는 테스트로 못 만난다** | `userEvent.click(disabled 버튼)` 은 조용히 아무 일도 안 한다 — 콘솔 경고도 없다 | disabled 조건과 함수 내부 가드가 같은 값을 검사한다면 함수 내부 가드는 죽은 코드다. 지우거나(권장), 정말 다른 경로로 호출될 수 있다면 그 경로로 테스트한다. `BarcodeScanPanel` 에서 실제로 발견(Task 16) |

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
