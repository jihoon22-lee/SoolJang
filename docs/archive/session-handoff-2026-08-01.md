# 세션 인계 — 2026-08-01 09:00 KST

이 문서는 **이 세션이 끝나는 시점의 정확한 상태**와 **다음 세션이 무엇부터 해야 하는지**를
담는다. 프로젝트 전체 맥락은 [handoff.md](../handoff.md), 계획은 [plan.md](../plan.md),
설계는 [architecture.md](../architecture.md) 에 있다.

> **날짜 스탬프 아카이브 문서다** — 2026-08-01 세션 종료 시점의 스냅샷이며, 지금은
> 최신이 아니다. 항상 최신인 정보는 [handoff.md](../handoff.md)·[plan.md](../plan.md) 를 본다.

---

## 1. 30초 요약

- **완료**: Task 1~13 전부 (백엔드 + 프론트엔드)
- **머지된 PR**: 19개 (#1~#19). 전부 CI 9개 잡 통과 후 머지. **열린 PR 0개**
  - #16~#19 는 이 인계 문서 자체를 다듬은 문서 전용 PR 이다
- **태그 0건 / 릴리스 0건** (Task 23 전용, 훅이 차단)
- **다음 할 일**: **Task 14 통계 대시보드 v1** (엑셀 통계 재현). 브랜치 `feature/stats-v1`
- 앱은 이제 **로그인을 요구한다**. 처음 켜면 계정 생성 폼이 뜬다

```bash
cd /mnt/e/projects/SoolJang
git switch main && git pull --ff-only
```

---

## 2. 지금 당장 해야 할 일 (순서대로)

### 2-1. Task 14 — 통계 대시보드 v1 (엑셀 통계 재현)

계획서 `plan.md` §4 Task 14 에 사양이 있다. 브랜치는 `feature/stats-v1`.

만들 것:

- 랭킹 4종: 병당 가격, 총 구매액, 100ml당 가격, 개인 평점
- 주종별 집계: 병수·총액·평균 도수·평균 평점·평균 100ml가·할인율
- 전체 합계, 주종 분포 차트

**반드시 지켜야 할 것:**

| 규칙 | 이유 |
|---|---|
| 100ml당 가격은 **정가 기준** | 실구매 기준으로 계산하면 168건이 엑셀과 어긋난다 (`legacy-schema.md` §4.2) |
| 평단가 분모 = **가격 있는 구매 건의 병수** | 선물 병수를 넣으면 평단가가 낮아진다 |
| 할인율은 **정가·실구매가 모두 있는** 건만 | 한쪽만 있으면 할인율을 알 수 없다 |
| 금액 없음은 **0 이 아니라 null** | 0원과 "모른다"는 다르다 |
| 파생값 **DB 저장 금지** | 매번 계산한다 |
| 공식은 `domain/metrics.py` 와 `metrics_sql.py` **양쪽 수정** | `test_metrics_parity.py` 가 일치를 보장한다 |

**대조 기준값** (`legacy-schema.md` §5, 실측 확인됨):

```
병 1,078 / 소비 819 / 재고 259 / 미개봉 225 / 개봉 34
총 용량 704,970ml
정가 42,401,108원 / 실구매 36,495,454원
구매처 82곳 / 주종 롤업 최상위 5개
평균 39,333 / 33,855 / 6,015원, 평점 평균 3.4
```

실제 시트로 검증하는 방법:

```bash
SOOLJANG_LEGACY_SHEET=/mnt/e/alcohol.csv uv run pytest -m requires_legacy_sheet
```


**재사용할 기존 코드** (새로 만들지 말 것):

| 파일 | 쓸 것 |
|---|---|
| `domain/metrics.py` | `compute_price_metrics`, `tally_bottles`, `quantize_money`, `quantize_ratio`, `PurchaseLot`, `BottleRecord` |
| `infrastructure/database/metrics_sql.py` | `product_metrics_query(user_id)`, `product_price_metrics_query`, `product_bottle_tally_query` |
| `application/tastings.py` | `summarize_tastings` (평점 평균·추이) |
| `application/categories.py` | 재귀 CTE 로 하위 주종 포함 집계 |

랭킹은 `product_metrics_query` 에 `ORDER BY` 와 `LIMIT` 을 붙이면 대부분 나온다. 주종별
집계는 그 쿼리를 `category_id` 로 그룹화한 뒤 재귀 CTE 로 상위 주종에 롤업한다.

**동점 처리**: 같은 값이면 `id` 로 순서를 고정한다. 그러지 않으면 새로고침마다 순서가 바뀐다.

**성능**: 제품 405건 규모라 인덱스 추가 없이 충분하다. 측정해 보고 느리면 그때 본다.

### 2-2. 그 다음

Task 15(PWA) → 16(바코드) → 17(OCR) → 18(외부소스) → 19(사이트어댑터) → 20(통계v2) →
**21(자체 통합테스트·다각도 분석)** → **22(개선 실행, 21↔22 반복)** →
23(첫 릴리스, 유일한 태그 푸시)

## 3. 이번 세션에 한 일

### Task 12 — 인증과 로컬 HTTPS (PR #13, 머지 완료)

| 항목 | 구현 |
|---|---|
| 테이블 | `app_user`, `app_session` (`0003_auth`) |
| 비밀번호 | Argon2id, 최소 10자. 파라미터 상승 시 로그인 때 조용히 재해시 |
| 세션 토큰 | 32바이트 무작위. DB 에는 **SHA-256 해시만** |
| 세션 수명 | 30일. `revoked_at` 으로 즉시 무효화 |
| 쿠키 | `sooljang_session`(httpOnly), `sooljang_csrf`(JS 읽기 가능) |
| CSRF | double-submit. 쓰기 메서드만. 상수 시간 비교 |
| 레이트 리밋 | 계정·IP 각각 5분 8회. 인메모리 |
| 엔드포인트 | `/auth/setup`(GET·POST), `/auth/login`, `/auth/logout`, `/auth/me`, `/auth/password` |
| 프론트엔드 | 로그인 화면, 인증 게이트, 401 중앙 처리, CSRF 헤더 자동 첨부 |
| 운영 | `scripts/serve-https.sh`, `scripts/backup.sh` |

### Task 13 — 병 상태 전이와 시음 (PR #14·#15 머지 완료)

| 항목 | 구현 |
|---|---|
| 테이블 | `tasting_session`, `attachment` (`0004_tasting`) |
| 상태 전이 | `:open` `:finish` `:gift` `:sell` `:reopen` |
| 시음 | 기록·타임라인·요약(평점 추이) |
| 엔드포인트 | 12개 추가 → 총 **35개** |
| 프론트엔드 | `BottlesPage`(필터 5종), `BottlePanel`(상태 전이·요약·타임라인), `TastingForm` |

---

## 4. 검증 증거 (이 세션에서 실제로 측정한 값)

```
Python          482 passed, 24 skipped, 커버리지 94.86%   (기준 85%)
프론트엔드       164 passed, 커버리지 87.69% stmts          (기준 80%)
ruff / format / ty                                        All checks passed
Biome / tsc / vite build                                  통과 (CSS gzip 2.12kB, JS gzip 85.11kB)
마이그레이션     up→down→up 왕복 성공, alembic check 드리프트 없음
shellcheck      serve-https.sh, backup.sh 통과
시크릿 스캔      통과
PR #13 CI       9개 잡 전부 pass (run 30671465017)
PR #14 CI       9개 잡 전부 pass (run 30672352311)
PR #15 CI       9개 잡 전부 pass (run 30672843124)
PR #16~#19 CI   각 9개 잡 전부 pass (문서 전용)
```

### 인증 실서버 확인 (포트 8230)

```
1. 인증 없이 GET /products        → 401 "로그인이 필요합니다"
2. GET /auth/setup               → {"needs_setup":true}
3. POST /auth/setup              → 201, 권한 owner, 만료 2026-08-30
4. 세션 쿠키                      → httpOnly 있음
5. 인증 후 GET /products         → 200
6. CSRF 없이 POST /categories    → 403
7. CSRF 붙여 POST /categories    → 201
8. 로그아웃 204 → 재접근          → 401
9. GET /health (인증 없이)        → 200
```

### 시음 실서버 확인 (포트 8240, 라가불린 16년 700ml)

```
1. 개봉              → open / 2026-03-01 / 700ml
2. 시음 40ml 4.0점    → 향 "피트, 요오드"
3. 시음 60ml 5.0점    → 동석 "친구"
4. 잔량              → 700 - 40 - 60 = 600ml
5. 평점 추이          → 2회 / 평균 4.50 / 첫 4.0 → 최근 5.0 (변화 +1.0)
6. 9999ml 요청        → 409 "잔량이 부족합니다. 남은 양 600ml"
```

### 백업 실제 검증

생성 34K → `pg_restore --list` 로 테이블 12개 확인 → 카테고리 46개 삭제 → 복원 → 46개 복구,
사용자 1명 유지. 확인 문자열이 틀리면 취소되는 것도 확인.

---

## 5. 이번 세션에 새로 발견한 함정

| 함정 | 대응 |
|---|---|
| **FastAPI 최신 버전은 `app.routes` 에 `_IncludedRouter` 지연 객체를 둔다** | 라우트 확인은 `app.routes` 순회가 아니라 `app.openapi()['paths']` 로 해야 한다. 순회하면 "라우터가 등록되지 않았다"고 오판한다 |
| `EmailStr` 이 `email-validator` 를 요구 | `pyproject.toml` 에 추가. 버전은 `>=2.3` (2.4 는 아직 없다) |
| `.test` TLD 는 email-validator 가 거부 | 테스트 이메일은 `example.com` 을 쓴다 |
| **HTTP 헤더는 ASCII 만 허용** | 테스트에서 헤더 값에 한글을 넣으면 `UnicodeEncodeError`. `wrong-token` 같은 ASCII 를 쓴다 |
| 시크릿 스캐너는 **추적 중인 파일만** 본다 | 커밋 전에 실행하면 새 파일을 못 본다. 커밋 후 다시 돌려야 CI 와 결과가 같다 |
| `sg docker -c "..."` 에 인자를 이어 붙이면 공백이 깨진다 | `printf %q` 로 각 인자를 이스케이프. `--format '{{.Service}} {{.State}}'` 가 두 개로 쪼개졌다 |
| ty 는 속성에 대입한 뒤 타입을 좁히지 않는다 | 지역 변수로 받아 비교한 뒤 대입한다 |
| `Query(default=...)` 는 ruff B008 위반 | 이 저장소 규약은 `Annotated[T, Query(...)] = default` |
| 로그인 후 `invalidateQueries` 가 `/auth/me` 를 재조회 | 테스트 스텁 배열을 그 자리에서 바꿔 200 으로 전환시켜야 실제와 같아진다 |
| `Product.normalized_name` 은 NOT NULL | 테스트 픽스처에서 반드시 채운다 |
| `POST /products` 는 `skus`(리스트)를 받고, 구매는 **별도 엔드포인트** | `POST /purchases` 로 따로 만든다 |
| **필터 버튼과 상태 전이 버튼이 같은 이름**("개봉"·"소진") | 테스트에서 `within(fieldset)` 으로 범위를 좁힌다. 좁히지 않으면 필터 버튼을 잡아 잘못된 실패가 난다 |
| 잔량 `null` 을 0ml 로 표시하면 오해를 준다 | `formatRemaining` 한 곳에서 "미개봉 (전량)" 으로 처리. 금액의 `formatMoney` 와 같은 원칙 |

기존 함정은 [handoff.md](../handoff.md) §5 에 있다. 특히 이 두 개는 계속 유효하다.

- `docker` 명령은 이 셸에서 `sg docker -c "..."` 로 감싼다
- Compose `api` 컨테이너가 8000 을 점유하므로 로컬 서버는 `SOOLJANG_API_PORT` 로 다른 포트

---

## 6. 알려진 미완·부채

| 항목 | 상태 | 비고 |
|---|---|---|
| **첨부 업로드 엔드포인트** | 미구현 | `attachment` 테이블과 모델만 있다. `POST /attachments`, 파일 저장 경로, 이미지 검증(MIME·크기·EXIF 제거), 정적 서빙이 필요 |
| **Tailscale 실제 접속 미확인** | 환경 제약 | 이 환경에 tailscale 이 설치되지 않았다. 스크립트는 shellcheck 통과. 사용자가 `tailscale up` 후 `scripts/serve-https.sh` 실행 |
| 감사 로그 | 미구현 | `architecture.md` §6 에 "인증·권한 변경, 임포트, 삭제는 감사 로그에 남긴다"고 적었으나 아직 없다 |
| 레이트 리밋이 인메모리 | 의도된 선택 | 여러 워커로 늘리면 공유 저장소 필요 |
| 실구매 총액 1원 차 | 수용됨 | 총액÷병수 반올림 잔여. 허용범위 20원으로 테스트 고정 |
| 구매처 24행 수동 분할 대상 | 미처리 | 병수 힌트 합이 맞지 않아 자동 분할 불가. Task 13 화면에서 수동 분할 UI 를 고려 |

---

## 7. 절대 규칙 (변함없음)

1. `main` 직접 푸시 금지 (부트스트랩 커밋만 예외). `pre-push` 훅이 막는다
2. **개발 중 `v*.*.*` 태그 금지.** Task 23 전용. 우회는 `SOOLJANG_ALLOW_TAG_PUSH=1`
3. 실제 음주 기록·`.env`·백업 덤프(`*.dump`)·업로드 이미지 커밋 금지
4. 매 Task PR 에 `plan.md` + `handoff.md` 갱신 포함
5. 모든 API 는 인증 요구 (`/health` 예외). 라우터 단위로 걸어 기본이 인증이 되게 한다
6. 파생값 DB 저장 금지 (매번 계산)
7. 외부 데이터는 출처 URL 없이 저장 금지
8. Task 1개 = `feature/*` 브랜치 1개 = PR 1개. Conventional Commits
9. **테스트에서 인증을 우회하지 말 것.** 우회하면 인증이 깨져도 초록색이다
10. `Enum` 컬럼은 반드시 `base.str_enum_column` 헬퍼를 쓴다 (값 저장 보장)

---

## 8. 재개 명령 모음

```bash
cd /mnt/e/projects/SoolJang
export SOOLJANG_DATABASE_URL="postgresql+psycopg://sooljang:localdevonly@127.0.0.1:5432/sooljang_test"

# DB
sg docker -c "docker compose up -d db"
uv run alembic upgrade head

# 검증
uv run ruff check . && uv run ruff format --check . && uv run ty check
uv run pytest                     # 482 passed 기대
npm --prefix web run check         # 145 passed 기대
bash scripts/scan-secrets.sh

# 실서버 (Compose api 가 8000 을 쓰므로 다른 포트)
SOOLJANG_API_PORT=8210 uv run sooljang-api
SOOLJANG_API_URL=http://127.0.0.1:8210 npm --prefix web run dev

# 실제 데이터 (429행)
SOOLJANG_LEGACY_SHEET=/mnt/e/alcohol.csv uv run pytest -m requires_legacy_sheet

# 백업
scripts/backup.sh
```

로그인 계정을 잊었다면:

```bash
sg docker -c "docker compose exec -T db psql -U sooljang -d sooljang -c 'DELETE FROM app_user'"
# 이후 앱을 열면 다시 계정 생성 폼이 뜬다
```

---

## 9. 열린 질문

| # | 질문 | 필요 시점 |
|---|---|---|
| Q4 | Tailscale 설치·tailnet 이름 (스크립트는 준비됨) | Task 15 이전 |
| Q2 | 검색·LLM API 제공자와 예산 | Task 17 |
| Q3 | 초기 외부 소스 사이트 목록 | Task 18 |
| Q5 | 목표가 알림 채널 | Task 19 |
| Q6 | 지인 공유 권한 모델 (`role` 은 이미 있음) | Task 20 |

---

## 10. 세션 종료 시점 상태 (2026-08-01 08:54 KST 확인)

이 값들은 종료 직전에 실제로 측정했다. 다음 세션은 이 기준선에서 시작한다.

```
git log -1              153283a Merge pull request #19
머지된 PR               19개 / 열린 PR 0개
태그                    0건 / 릴리스 0건
작업 트리                변경 0개 (깨끗함)
ruff / format / ty      All checks passed
시크릿 스캔              통과
Python                  482 passed, 24 skipped, 커버리지 94.86%
프론트엔드               164 passed, 커버리지 87.69%
엔드포인트               35개
문서 상대 링크           깨진 것 0건
```

### 정리한 것

- 데모용 임시 DB `sooljang_demo`, `sooljang_demo2` 삭제
- 데모용 API 서버(포트 8230·8240) 종료
- `/tmp` 임시 파일 삭제

### 유지한 것

- Docker Compose 스택 (`db`·`api`·`web` 모두 running). 다음 세션이 바로 쓸 수 있다
- 개발 DB `sooljang`, 테스트 DB `sooljang_test`

### 마지막으로 확인한 것

인계 문서에 적은 **모든 명령을 실제로 실행해 동작을 확인했다.** `npm --prefix web run check`
가 존재하는지(`lint`·`typecheck`·`test:coverage`·`build`·`check` 5개 전부 있음), 백업
스크립트가 실제로 40K 덤프를 만들고 테이블 14개를 검증하는지까지 봤다. 문서에 적힌 명령이
동작하지 않으면 인계가 실패하기 때문이다.
