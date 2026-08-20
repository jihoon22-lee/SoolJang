# 세션 인계 문서

**다른 세션에서 이 작업을 이어받는 사람을 위한 문서다.** 이것을 먼저 읽고,
[plan.md](plan.md) §1(현재 위치)로 넘어가면 된다.

- 최종 갱신: **2026-08-20 (Task 34 완료 — 외부 정보 조회 v2, PR1~PR7 전부 머지됨.**
  매칭 정확도(엉뚱한 술을 정답처럼 보여주던 문제)와 소스 등록 편의성을 함께 고쳤다:
  PR1 후보 노출·사용자 명시 고정([#97](https://github.com/jihoon22-lee/SoolJang/pull/97)),
  PR2 토큰 집합 기반 점수 재작성·질의 확장([#98](https://github.com/jihoon22-lee/SoolJang/pull/98)),
  PR3 표준 필드 스키마·가격 비교 표([#100](https://github.com/jihoon22-lee/SoolJang/pull/100)),
  PR4 소스 헬스 체크([#101](https://github.com/jihoon22-lee/SoolJang/pull/101)),
  PR5 소스 프리셋 카탈로그·`adapter_spec` v2 + robots.txt 다중 호스트 버그 수정
  ([#102](https://github.com/jihoon22-lee/SoolJang/pull/102)),
  PR6 애매 구간(0.5~0.85) LLM 재판정 — 기본 꺼짐, 자동 고정 없음, 3중 비용 가드
  ([#104](https://github.com/jihoon22-lee/SoolJang/pull/104)),
  PR7 제외 키워드(토큰 단위, 부분 문자열 오탐 없음)([#107](https://github.com/jihoon22-lee/SoolJang/pull/107)).
  상세 설계·결정 로그는 [plan-external-v2.md](plan-external-v2.md), `plan.md` §5 D175~D193.
  새 사이트를 실제로 붙이는 일(네이버 쇼핑 등)은 이번 범위가 아니다 — §7 향후 고려로만
  기록.
  **이 세션 중 중복 작업 정리도 했다** — 동시에 떠 있던 다른(오래된/고아) 세션이 이미
  머지된 PR 을 다시 만든 사고가 두 번 있었다(PR #97/#99, PR #103) — 전부 닫고 정리했다
  (일부 원격 브랜치는 세션 권한(403)으로 못 지워 남아 있을 수 있다, `feat/external-match-pin`·
  `feat/external-normalized-fields`).
  **이 세션은 사용자의 홈 PC가 아니라 격리된 클라우드 샌드박스다** — 아래 §5 의 "이
  개발 환경 자체가 사용자의 홈 PC다" 항목은 **이전 세션들(Task 1~33)에서만 사실이었다.**
  Task 34 를 진행한 이 세션은 `claude.ai/code` 원격 실행 환경이라 홈 PC 파일시스템·
  Docker 소켓에 직접 닿지 않는다 — 실제 재배포는 사용자가 연결해 둔 별도의 WSL/Docker
  브리지 Remote Control 세션(ici/idk/devbox, 전부 같은 물리 머신)을 통해서만 가능하다.
  다음 릴리스(`v1.6.0`)·재배포 작업은 그 경로로 진행한다.
  직전엔 Task 33 완료 — Task 32 회귀 수정. 재고 우선 정렬 순위가
  사용자 의도와 반대(미개봉 우선)로 구현돼 있던 것을 "개봉 있음 > 미개봉만 있음 >
  재고 없음"으로 뒤집었다(D174, [#95](https://github.com/jihoon22-lee/SoolJang/pull/95)). `queries.ts::stockTier()` 두 분기 순서만
  교체하고 체크박스 라벨·테스트를 맞췄다. 버전을 1.4.1 로 올려 릴리스·재배포 완료.
  그 전엔 Task 32 완료 — "내 술" 재고 표시·정렬 개선 2개 PR. ①
  재고 배지에 개봉/미개봉 내역 상시 표시(호버 아님) + 재고 우선 정렬(미개봉 있음 >
  개봉만 있음 > 재고 없음, `order` 는 각 티어 안에서만 방향 반전) + "재고 있는 술
  먼저" 토글(기본 켬, `localStorage`)([#92](https://github.com/jihoon22-lee/SoolJang/pull/92)).
  ② 필터 패널 13개 필드 순서를 사용자가 커스터마이즈 — 하나의 순서 배열에서 앞
  7개가 상시 표시, 경계 너머로 옮기면 자동으로 접힘/상시 전환. "필터 순서 편집"
  전용 모드(값 입력과 분리)([#93](https://github.com/jihoon22-lee/SoolJang/pull/93)).
  둘 다 이 목록이 서버 페이지네이션 없이 Dexie 카탈로그 전체를 프론트엔드에서
  정렬하는 구조라 서버 변경 없이 완결됐다. 버전을 1.4.0 으로 올려 릴리스·재배포
  진행 중. 직전엔 Task 31(백로그 정리 2차) 5개 PR([#86](https://github.com/jihoon22-lee/SoolJang/pull/86)~[#90](https://github.com/jihoon22-lee/SoolJang/pull/90))로 1.3.0,
  Task 30(백로그 정리)로 1.2.0 릴리스([#82](https://github.com/jihoon22-lee/SoolJang/pull/82)~[#84](https://github.com/jihoon22-lee/SoolJang/pull/84)) 완료.
  이 작업 중 `README.md`/`docs/handoff.md` §1·§1-1 의 로컬 개발 안내가 `v1.0.0` 이전
  기준으로 남아 있던 것(`docker compose up -d db` 가 지금은 운영 DB를 가리킴, `DELETE
  FROM app_user` 예시 포함)도 함께 고쳤다.
  전날엔 술 상세 저장 시 "품종·스타일" 이 증식하던 결함을 수정했다 — 원인은
  `_replace_varieties` 가 품종 연결을 매번 hard delete 뒤 새 id 로 재생성해, `deleted_at`
  기반 동기화 삭제 전파가 안 되던 것. 기존 연결 재사용(소프트 삭제·복원)으로 수정,
  [PR #76](https://github.com/jihoon22-lee/SoolJang/pull/76). 버전을 1.1.5 로 올려
  ([#77](https://github.com/jihoon22-lee/SoolJang/pull/77)) 릴리스·재배포 완료. 같은 세션에서
  저장소를 **public 전환**(사용자가 이미 완료해 둔 상태 확인)하고, `main` 브랜치를 아무도
  우회 못 하는 ruleset(PR 필수, 승인 개수 요건 없이 쓰기 권한으로 통제)으로 보호했다.
  GitHub Advanced Security 중 Secret scanning(+push protection), CodeQL default setup 도
  켰다)**
- 저장소: `https://github.com/jihoon22-lee/SoolJang` (**public**, 소유자 `jihoon22-lee`. 협업자는
  본인뿐이라 남이 `main`에 push/머지할 방법은 원래도 없었지만, 2026-08-09 부터는 ruleset 으로
  명시적으로 강제한다 — 본인도 PR 없이 직접 push 불가)
- 로컬 경로: `/mnt/e/projects/SoolJang`
- **이 개발 환경 자체가 사용자의 홈 PC다** — hostname `Main` = tailnet 노드 `main`(2026-08-03
  확인). Docker 소켓 접근은 `sg docker -c "..."` 로 가능(현재 셸 세션엔 `docker` 그룹이
  반영 안 돼 있을 뿐 시스템상 멤버는 맞다). **주의**: 이 환경에 `ast-grep` 이 `sg` 라는
  이름으로 `PATH` 앞쪽(`~/.local/bin`)에 설치돼 있어 `sg` 가 그룹 전환 대신 `ast-grep` 으로
  해석될 수 있다 — 그럴 땐 절대 경로 `/usr/bin/sg docker -c "..."` 를 쓴다(`scripts/backup.sh`
  도 한동안 이 함정에 걸려 있었다 — 2026-08-06 수정, [#59](https://github.com/jihoon22-lee/SoolJang/pull/59))
- 현재 브랜치: `main`. Task 1~17·20~28 전부 완료(Task 18 은 `adapter` 전략 + JSON 모드로
  확장, 외부 소스 7곳 중 1곳(데일리샷) 실등록).
  **`v1.0.0` 이후 Task 24(실사용 피드백 개선) 7개 PR 을 전부 머지하고([#47](https://github.com/jihoon22-lee/SoolJang/pull/47)~[#53](https://github.com/jihoon22-lee/SoolJang/pull/53)),
  데일리샷 등록 과정에서 발견한 어댑터 개선([#56](https://github.com/jihoon22-lee/SoolJang/pull/56))까지
  담아 `v1.1.0` 을 정식 릴리스했다. 이어서 Task 25(2차 UI/UX 피드백) 4개 PR([#62](https://github.com/jihoon22-lee/SoolJang/pull/62)~[#65](https://github.com/jihoon22-lee/SoolJang/pull/65))과
  NUL 바이트 수정([#66](https://github.com/jihoon22-lee/SoolJang/pull/66))까지 담아 `v1.1.1` 을 릴리스·재배포했다. Task 26
  (3차 UI/UX 피드백) [#69](https://github.com/jihoon22-lee/SoolJang/pull/69) 를 담아 `v1.1.2` 를, 그 배포 직후 발견된 회귀를
  고친 Task 27 [#71](https://github.com/jihoon22-lee/SoolJang/pull/71) 을 담아 `v1.1.3` 을, "현재 구조를 기본값으로 저장" 기능인
  Task 28 [#73](https://github.com/jihoon22-lee/SoolJang/pull/73) 을 담아 `v1.1.4` 를, 마이그레이션 수동 실행
  함정 기록([#75](https://github.com/jihoon22-lee/SoolJang/pull/75))에 이어 품종 증식 결함 수정
  [#76](https://github.com/jihoon22-lee/SoolJang/pull/76) 을 담아 `v1.1.5` 를, 프로필 표시 이름
  수정 기능과 운영 가이드 문서화([#78](https://github.com/jihoon22-lee/SoolJang/pull/78))를
  담아 `v1.1.6` 을, 접근성·릴리스 가드 보강인 Task 29
  [#80](https://github.com/jihoon22-lee/SoolJang/pull/80) 를 담아 `v1.1.7` 을, 백로그 정리인
  Task 30([#82](https://github.com/jihoon22-lee/SoolJang/pull/82)·[#83](https://github.com/jihoon22-lee/SoolJang/pull/83)·[#84](https://github.com/jihoon22-lee/SoolJang/pull/84)) 를 담아 `v1.2.0` 을, 백로그 정리 2차인
  Task 31([#86](https://github.com/jihoon22-lee/SoolJang/pull/86)~[#90](https://github.com/jihoon22-lee/SoolJang/pull/90)) 를 담아 `v1.3.0` 을, "내 술" 재고 표시·정렬
  개선인 Task 32([#92](https://github.com/jihoon22-lee/SoolJang/pull/92)·[#93](https://github.com/jihoon22-lee/SoolJang/pull/93)) 를 담아 `v1.4.0` 을, 그 회귀 수정인
  Task 33([#95](https://github.com/jihoon22-lee/SoolJang/pull/95)) 를 담아 `v1.4.1` 을 릴리스·재배포했다(2026-08-20 헬스체크로 재확인).
  이어서 Task 34(외부 정보 조회 v2, PR1~PR7, [#97](https://github.com/jihoon22-lee/SoolJang/pull/97)~[#107](https://github.com/jihoon22-lee/SoolJang/pull/107))
  전부 완료했다 — `v1.6.0` 하나로 릴리스 예정(§1 상단 참조).**
  Task 34 완료로 계획된 Task 중 새로 착수할 게 없다 — 남은 건 전부 사용자가 원하는
  시점에 결정할 선택 사항(외부 소스 나머지 6곳 실등록, Task 19 본 착수)뿐이다 — 상세는
  `plan.md` §1
- 버전: **[`1.4.1`](https://github.com/jihoon22-lee/SoolJang/releases/tag/v1.4.1)** 배포 중(2026-08-20 헬스체크로 재확인) → **`v1.6.0`**(Task 34 PR1~PR7)
  릴리스·재배포 진행 예정 — 이 문서 최상단 "최종 갱신" 참조

> 이 문서보다 최신 세션의 상세 기록이 필요하면 `docs/archive/session-handoff-*.md` (날짜 스탬프
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

# 4) 데이터베이스 — **격리된 개발용 DB를 쓴다. `docker compose up -d db` 는 절대 쓰지
#    않는다** — `v1.0.0` 부터 이 기기에 운영 배포가 상시 떠 있어서, `docker-compose.yml`
#    의 `db` 서비스는 이제 실사용자 데이터가 든 **운영 DB**다(§1-1·§5 참조).
bash scripts/dev-db.sh setup   # 최초 1회 (micromamba 로 홈 디렉토리에 PostgreSQL 17 설치)
bash scripts/dev-db.sh start   # 포트 54329, DB sooljang_dev/sooljang_test — 운영과 완전 분리
export SOOLJANG_DATABASE_URL="postgresql+psycopg://sooljang@127.0.0.1:54329/sooljang_dev"
uv run alembic upgrade head

# 5) 검증
uv run pytest                  # 612 passed, 28 skipped 가 정상 (skip 전부 opt-in 실측 테스트,
                                #   live_llm 마커 포함 — 실제 OpenAI 키가 없으면 건너뛴다)
npm --prefix web run check     # 254 passed, 커버리지 임계값(branch 80%) 통과

# 6) 이어서 작업
#    plan.md §1 의 "다음 착수 Task" 를 확인하고 해당 브랜치를 만든다
```

`.env` 가 없으면 `.env.example` 을 복사하고 `POSTGRES_PASSWORD` 를 채운다. Task 17 부터
`SOOLJANG_SECRET_KEY` 도 필수다(LLM API 키 암호화용 Fernet 마스터 키) —
`python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`
로 생성한다. 없으면 앱이 아예 기동하지 않는다(기본값 없음, 의도적).
Docker 를 쓸 수 없으면 `make db-local-setup` → `make db-local-start` 폴백을 쓴다
(micromamba 로 홈 디렉토리에 PostgreSQL 17 설치, root 불필요, 포트 54329).

---

## 1-1. 실제 데이터로 앱 써 보기

Task 11 로 실제 429행이 들어간다. 직접 확인하려면 이렇게 한다. **아래는 §1 과 같은 격리된
개발용 DB(`sooljang_dev`, 포트 54329)를 쓴다 — `v1.0.0` 부터 `docker compose` 의 `db` 는
운영 DB 라 여기서 다루지 않는다.**

```bash
# 1) DB 기동 후 마이그레이션 (없으면 먼저 `bash scripts/dev-db.sh setup`)
bash scripts/dev-db.sh start
export SOOLJANG_DATABASE_URL="postgresql+psycopg://sooljang@127.0.0.1:54329/sooljang_dev"
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

비밀번호를 잊었다면 DB 에서 사용자를 지우고 다시 설정한다 — **반드시 위 격리된 개발용
DB에만 실행한다. `docker compose exec db ...` 는 운영 DB라 실사용자 계정을 지운다.**

```bash
echo "DELETE FROM app_user;" | bash scripts/dev-db.sh psql
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

전체 23개 Task 중 **18개 완료 + Task 21·22 진행중**(Task 18 은 `adapter` 전략만 부분
완료, Task 19 는 여전히 대기). PR 43개 머지(#1~#43, #16~#20 은 문서 전용 — 이후 규칙
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
| 17. 라벨 OCR 프리필 | ✅ | [#24](https://github.com/jihoon22-lee/SoolJang/pull/24) | LLM 설정 인프라(`LlmSetting` 암호화 저장, `GET·PUT·DELETE /llm-settings`), `infrastructure/external/llm.py`(OpenAI 구조화 출력), `POST /ocr/label`, `POST /attachments`(문서-코드 갭 메우기), `LabelOcrPanel`·`SettingsPage` |
| 20. 통계 v2 (Task 18·19 를 건너뛰고 먼저 함) | ✅ | [#25](https://github.com/jihoon22-lee/SoolJang/pull/25) | `purchase_stats_rows_query`(구매 건 단위), `get_pivot`·`get_timeseries`, `SavedView`(JSONB 정의), `POST /stats/pivot`·`GET /stats/timeseries`·`GET·POST /saved-views`, `PivotExplorer.tsx`(온라인 전용), `value_for_money` 를 제품 지표에 처음 노출 |
| 21. 자체 통합 테스트(진행중) → **22. 개선 실행 Track 1~4** | 🟡 | [#26](https://github.com/jihoon22-lee/SoolJang/pull/26)~[#35](https://github.com/jihoon22-lee/SoolJang/pull/35)(10건) | 사용자가 실데이터(405종·1,078병·64곳)로 직접 써 보고 보고한 문제 + 코드 감사 결과를 실행. URL 라우팅, 목록 밀도·정렬·필터, 제품 상세 개편(수정+병+구매 관리), 병 되돌리기+성능 수정, 통계 크로스 링크, 구매처 관리+설정, 자동완성+초성검색, 비주얼 디자인 전면 개편("Cellar Dark"), 외부 소스 레지스트리(Task 18, `adapter` 전략만), 매장 모드(`#scan`, 신규 화면). **상세는 `plan.md` §1 "Task 22 실행 요약" 표** — 각 PR 링크·근거·이연한 것(`search` 전략, 시세 이력)까지 정리돼 있다 |

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
| 라벨 OCR·LLM 설정 백엔드·프론트 전체 검증 | `pytest` 592 passed, 28 skipped(opt-in `live_llm` 포함), 커버리지 90.84%. 프론트엔드 237 passed, 커버리지 89.87% stmts / 80.2% branch(임계값에 근소하게 통과). **실제 OpenAI API 로 1회 왕복 확인**(`live_llm` 마커, 사용자가 다른 프로젝트 키를 테스트용으로 제공) — 인증·요청 형식·구조화 출력 파싱이 실동작함을 확인. `docker build`(web·api) 둘 다 정상, api 이미지는 직접 실행해 `create_app()` 임포트까지 확인(§5 `httpx` 함정 재발 여부 재확인 겸함) |
| 통계 v2(피벗·시계열·저장뷰) 백엔드·프론트 전체 검증 | `pytest` 612 passed, 28 skipped, 커버리지 90.97%. 프론트엔드 254 passed, 커버리지 90.3% stmts / 80.02% branch(임계값에 근소하게 통과). "구매처별 × 주종별 평균 할인율" 데모 시나리오를 실제 API 테스트로 재현(정가 10만원·실구매 8만원 → 할인율 20% 정확히 계산됨 확인). `docker build`(web·api) 둘 다 정상 |
| Task 22 Track 1~4(10 PR) 각각 백엔드·프론트 전체 검증 + 실클릭 확인 | 매 PR 이 `npm run check`(lint+typecheck+vitest 80%+)와 필요시 `uv run pytest`/`ruff`/`ty` 를 통과한 뒤에만 머지. `pytest` 최종 650 passed. PR9(외부 소스)·PR10(매장 모드)는 Playwright 로 실제 405종 데이터 대상 실클릭까지 확인(검색 랭킹, 조회 결과, 신규 등록→즉시 요약 반영, 카메라 권한 거부 시 우아한 실패) |
| Task 21 완료(2026-08-03, `feature/self-review`) | **E2E 회귀 테스트**: 등록→검색→구매 분할→개봉→시음→통계→바코드→피벗→저장뷰→오프라인 동기화를 잇는 영구 테스트(`tests/api/test_e2e_scenario.py`) 추가. **성능 실측**: 429/1,078 규모와 10배(4,290/10,780) 규모 모두 opt-in 벤치마크(`tests/performance/test_scale_benchmarks.py`)로 실측 — 가장 느린 `POST /stats/pivot` 도 10배 규모에서 211ms. **실측 중 실제 버그 발견·수정**: 대량 임포트 직후 `ANALYZE` 미실행으로 정상 4~6ms 쿼리가 25~30초로 느려지는 문제(`legacy_import.py::apply_plan`). **장애 주입**: 외부 소스 타임아웃·셀렉터 파손·robots.txt 차단(PR9 테스트 8종), 동기화 충돌(LWW·재전송·head-of-line, 기존 `test_sync.py`), LLM 네트워크 타임아웃(`test_llm.py`), **처리되지 않은 예외(DB 연결 끊김 포함) → Problem Details 미변환 결함을 발견해 즉시 수정**(`api/errors.py` 에 `Exception` 캐치올 핸들러 추가 + `logger.exception` 으로 서버 로그에 원인 기록, `test_error_handling.py` 로 검증). **데이터 무결성**: `sooljang`(실데이터 406제품·1,079병) `pg_dump` → 새 DB `pg_restore` → 통계 재계산(summary·rankings·category rollup) 결과가 백업 전과 **바이트 단위로 동일**함을 확인, 임시 DB 는 정리함. 산출물은 [`docs/archive/review-2026-08-03.md`](archive/review-2026-08-03.md) |
| Task 23 릴리스 파이프라인 사전 점검(2026-08-03, [PR #38](https://github.com/jihoon22-lee/SoolJang/pull/38)) | 태그 없이 `release.yml` 을 `workflow_dispatch` dry-run 으로 미리 돌려 보다가 실제 결함을 발견했다 — "Run full test suite" 단계에 PostgreSQL 서비스가 없어 전부 `connection refused` 로 실패했다(만들어진 이후 한 번도 실제 테스트 경로로 검증된 적이 없었다). `quality.yml` 과 같은 `services.postgres` 를 추가해 수정하고, 다시 dry-run 을 돌려 테스트~이미지 빌드(web·api 둘 다)까지 전부 통과함을 확인했다(run [30784846639](https://github.com/jihoon22-lee/SoolJang/actions/runs/30784846639)). **릴리스 파이프라인 자체는 이제 준비됐다** — 남은 건 실제 `v1.0.0` 태그 푸시뿐이고, 이건 사용자의 명시적 승인 없이는 하지 않는다 |
| PR9/10 사후 코드 리뷰 하드닝(2026-08-03, [PR #41](https://github.com/jihoon22-lee/SoolJang/pull/41)) | `code-reviewer` 서브에이전트로 외부 소스 레지스트리(PR9)·매장 모드(PR10)를 적대적으로 재검토해 6개 결함을 실행 검증(`httpx.MockTransport` 프로브, 최소 FastAPI 앱으로 CORS 헤더 유무 직접 확인)까지 마친 뒤 전부 수정했다: (1) `adapter_spec` 모양이 조금만 틀려도(오타 난 transform, 문법 오류 CSS 셀렉터 등) 크래시하던 것 → `fetch_snapshot` 을 예외를 삼키는 래퍼로 감싸고 필드 단위로 방어, (2) 검색 결과 링크를 호스트 검증 없이 그대로 조회해 SSRF 가능(+ 리다이렉트 미지원) → `_same_host()` 이중 확인 + `follow_redirects`, (3) 상세 페이지 조회 실패가 `source_url` 만 보고 캐시돼 TTL 동안 실패가 성공처럼 굳음 → `AdapterResult.ok` 필드로 분리, (4) 500 캐치올 핸들러가 `CORSMiddleware` 바깥이라 개발 환경에서 CORS 오류로 가려짐 → `cors_origins` 허용 시 직접 헤더 추가, (5) `useCreateProduct` 온라인 분기에서 구매·첨부 실패 시 로컬 미러링이 실행 안 돼 서버측 고아 제품 발생 → 미러링을 제품 생성 직후로 이동, (6) 외부 소스 CRUD 가 카테고리 소유권을 검증하지 않음 → `ensure_category_exists` 재사용. 신규 테스트 20여 개 추가, 기존 테스트 전부(백엔드 672 passed, 프론트 385 passed) 회귀 없음. 근거는 `plan.md` D99~D104 |
| 오프라인 동기화·재고 정합성 하드닝(2026-08-03, [PR #42](https://github.com/jihoon22-lee/SoolJang/pull/42)) | `v1.0.0` 실사용·모바일 배포를 사용자가 승인한 직후, 나머지 Task 22 배치(PR1~8)의 병 상태 전이·동기화 델타 적용 코드는 Task 21 의 UX 차원 리뷰만 받았을 뿐 데이터 정합성 관점 적대적 리뷰는 없었다는 공백을 발견해 별도로 재검토했다. 실제 사용 시나리오(모바일·오프라인)에서 실제로 데이터가 틀리거나 잃어버릴 수 있는 5개 결함을 배포 전에 고쳤다: (1) **치명적** — 오프라인 병 전이(개봉·소진·증여·판매) 가 outbox `fields:{}` 를 보내 서버가 재접속 날짜로 덮어쓰던 것 → `transitionOutboxFields()` 로 실제 날짜 전달, (2) **치명적** — 실패한 동기화 작업에 receipt 가 없어 재전송마다 검증을 다시 돌려 큐 전체가 영구 정지되고, `IntegrityError` 는 아예 배치 전체를 롤백시키며 배지가 "최신 상태"라고 오표시하던 것 → 실패도 receipt 로 멱등화 + `IntegrityError` 캐치 + 배지가 `pendingCount>0` 도 반영, (3) `hand_over_bottle` 에 날짜 역전 가드가 없어 2번의 배치 롤백을 유발할 수 있던 것 → `finish_bottle` 과 같은 가드 추가, (4) `pullDeltas` 의 pending 조회가 pull 네트워크 왕복 전이라 그 사이 낙관적 쓰기가 스테일한 서버 값에 덮이던 TOCTOU + 시음 기록이 건드리는 병이 애초에 보호 대상이 아니던 것 → pending 조회를 pull 이후·같은 트랜잭션으로, `touched_ids` 로 부작용 엔티티 보호, (5) 동기화 중 트리거가 오면 조용히 버려져 최대 1분(백그라운드 탭이면 무기한) 지연되던 것 → `dirty` 플래그로 종료 후 재실행. 신규 테스트 다수 추가, 기존 테스트 전부(백엔드 675 passed, 프론트 393 passed) 회귀 없음. 근거는 `plan.md` D105~D109 |
| **`v1.0.0` 정식 릴리스·배포(2026-08-03, [PR #43](https://github.com/jihoon22-lee/SoolJang/pull/43) + 실제 태그 푸시)** | 버전 범프(PR #43) 후 `SOOLJANG_DOCKER_SG=1 bash scripts/backup.sh` 로 백업(176KB, 테이블 21개 검증)을 먼저 뜨고, `SOOLJANG_ALLOW_TAG_PUSH=1 git push origin v1.0.0` 으로 태그를 푸시했다. 릴리스 워크플로가 실제로(dry-run 아님) 돌아 GHCR 이미지 게시 + [GitHub 릴리스](https://github.com/jihoon22-lee/SoolJang/releases/tag/v1.0.0) 생성까지 6분 33초에 끝났다. 이 세션 자체가 사용자의 홈 PC(hostname `Main` = tailnet 노드 `main`)라는 걸 확인하고 실제 재배포까지 진행했다 — 단 `gh` CLI 토큰에 `read:packages` 스코프가 없어 GHCR pull 은 `denied`(스코프 추가는 브라우저 기기 인증이 필요해 사용자 상호작용 없이 완료 불가, 진행 안 함), 대신 같은 소스로 **로컬 재빌드**(`docker compose build && up -d`, `SOOLJANG_VERSION=1.0.0`)해 동등한 이미지를 배포했다. `db` 서비스는 이미지가 안 바뀌어 재시작되지 않았고(데이터 위험 없음), 배포 후 `GET /health` 로 `version:"1.0.0"`·`database_connected:true`·컨테이너 둘 다 `healthy` 확인. **모바일 접속(`tailscale serve --bg --https=443 http://127.0.0.1:8080`)은 "Serve is not enabled on your tailnet" 로 거부됐다** — 관리자 콘솔(`https://login.tailscale.com/f/serve?node=n8eiMiT7ky11CNTRL`)에서 사용자가 한 번 활성화해야 하는 계정 단위 설정이라 API/CLI 로 우회 불가. 사용자가 활성화하면 위 명령을 다시 실행해 마무리한다 |
| Task 24 PR1 — 동기화 큐 영구 정지 + 데이터 무결성(2026-08-04, [#47](https://github.com/jihoon22-lee/SoolJang/pull/47) `fix/sync-queue-recovery`, 머지됨) | 실사용 중 발견된 B6(병수 `2.5` 입력 → 오프라인 큐 영구 정지)를 포함해 B4·B5·B7·B1·B2·B12 총 7개 결함을 수정했다. `pytest` 686 passed(29 skipped, 전부 opt-in), 커버리지 91.50%. `npm run check` 403 passed, 커버리지 91.36% stmts / 83.2% branch, `vite build` 정상. `alembic check` 클린. 시크릿 스캔 통과. **전체 `pytest` 를 처음 돌릴 때 §5 표에 이미 기록된 `SOOLJANG_DATABASE_URL` 함정이 그대로 재발**(새 셸이라 export 가 안 돼 있어 `tests/infrastructure/database/*`·`tests/performance/*` 전체가 `password authentication failed`)해, 이 문서의 기존 기록이 정확함을 재확인했다. CI 의 `pip-audit` 단계가 `pypi.org` 타임아웃으로 1회 실패했으나 이 PR 변경과 무관한 일시적 네트워크 문제로 판단해 재실행으로 통과시켰다. 근거는 `plan.md` Task 24 PR1 절, D110~D118 |
| Task 24 PR2 — 프론트 안정성(2026-08-04, [#48](https://github.com/jihoon22-lee/SoolJang/pull/48) `fix/frontend-resilience`, 머지됨) | 화면이 죽거나 실패가 조용히 사라지는 4개 결함(B10 루트 에러 바운더리 부재, B8 충돌 확인 실패 시 무반응, B9 바코드/라벨 인식 응답 지연 중 닫은 다이얼로그 재등장, B11 업로드 크기 검사가 전체 읽기 뒤에 있고 매직 바이트 확인 없음)을 수정했다. `pytest` 689 passed(29 skipped), `npm run check` 408 passed, `vite build` 정상. B9 는 수정 전 코드로 되돌려 다이얼로그가 실제로 재등장함을 먼저 확인한 뒤 고쳤다. 근거는 `plan.md` Task 24 PR2 절, D119~D122 |
| Task 24 PR3 — 디자인 시스템(2026-08-05, [#49](https://github.com/jihoon22-lee/SoolJang/pull/49) `refactor/design-system`, 머지됨) | `styles.css` 한 파일만 바꾸는 순수 CSS 리팩터(백엔드·JSX 변경 없음). 타입 스케일 6단계·컨트롤 높이 3단계(`--control-h-md` 는 rem 이 아니라 44px 로 고정)·`--font-weight-*`·`--font-mono` 토큰을 도입해 흩어진 폰트 크기 12종·터치 타깃 표기 2종을 통일했다. `.category-bar-row` 그리드 고정폭→`minmax(0,6em)`, `.sort-button` 의 `inline-flex` 가 무효화하던 말줄임(`.category-bar-label`/`.ranking-name`)을 `display:block` 으로 복구, `overflow-wrap:anywhere` 신규 도입(표 셀·카드 제목), `40rem` 미문서화 브레이크포인트 제거(600px 로 흡수), `.sort-button:focus-visible` 아웃라인 복구, `.link-like` 터치 타깃 44px 확보, 죽은 CSS(`--space-xl` 포함) 삭제. `npm run check` 408 passed(회귀 0), `vite build` 정상. **Playwright 로 360/768/1280px 세 폭에서 내 술 목록·통계·주종 관리 화면을 실제로 렌더링해 확인**했다 — 표 안 긴 이름 줄바꿈, 모바일 카드 제품명 링크의 넓어진 터치 영역, 세 폭 모두 고른 내비게이션/버튼 높이를 눈으로 검증. 근거는 `plan.md` Task 24 PR3 절, D123~D129 |
| Task 24 PR4 — 탭 정리+구매처 드릴다운+매장모드 모바일 전용(2026-08-05, [#50](https://github.com/jihoon22-lee/SoolJang/pull/50) `feat/navigation-restructure`, 머지됨) | 백엔드 변경 없음. 헤더에 "설정" 팝오버 메뉴 신설(가져오기·외부 소스·설정·서비스 상태·로그아웃을 접음, 바깥 클릭·Esc 로 닫힘), 주 nav 는 `내 술`/`주종 관리`/`구매처`/`통계` 4개로 축소. 매장 모드는 nav 에서 빼고 `ProductsPage` 상단 모바일 전용(900px 미만) 진입 버튼으로 이동(`#scan` 라우트는 그대로 유지). 구매처 → 그 구매처에서 산 술 드릴다운을 `router.ts`(`vendorId`)·`ProductsPage`(`initialVendorId`)·`VendorsPage`(이름 클릭)로 연결(카테고리 드릴다운과 같은 아키텍처 재사용), `getVendors()` 에 `total_spend` 추가(실구매가 우선·정가 보충·둘 다 없으면 제외). `npm run check` 413 passed(회귀 0), `vite build` 정상, 시크릿 스캔 통과. **Playwright 로 실데이터(406종·구매처 64곳) 대상 "CU어플" 클릭 → "내 술 (2)" 정확히 필터링됨을 확인**, 설정 메뉴 열기/바깥 클릭 닫기, 1280px 숨김·360px 노출되는 매장 모드 버튼도 눈으로 검증. 근거는 `plan.md` Task 24 PR4 절, D130~D133 |
| Task 24 PR5 — 통계 화면 차트 개편(2026-08-05, [#51](https://github.com/jihoon22-lee/SoolJang/pull/51) `feat/stats-charts`, 머지됨) | 순수 프론트엔드(백엔드 변경 없음). `components/charts/` 에 사내 SVG 프리미티브(`BarChart`/`DonutChart`/`LineChart`, 외부 라이브러리 미도입) 신설 — 라벨은 SVG `<text>` 대신 HTML 로 렌더링, 모두 `role="img"`+표 대체 텍스트. 범주형 팔레트(`--chart-1`~`6`) 추가. "주종별 집계" 는 측정값 셀렉트(병수·총액·평균 도수·평균 평점·평균 100ml가·할인율)로 즉시 다시 그려지는 `BarChart` 로, 병 상태 분포는 `DonutChart` 로, 월별 시계열(`PivotExplorer`, 온라인 전용)의 CSS 막대 흉내는 `LineChart` 로 교체. `getStatsSummary()`/`getStatsRankings()`(오프라인 계산)에 `gifted_count`/`sold_count`/`avg_days_to_finish`/`avg_value_for_money`/`by_value_for_money` 추가 — `averageDaysToFinish()` 를 `domain/metrics.ts` 공개 함수로 뽑아 컬렉션 전체도 병 단위로 직접 평균한다(제품별 평균의 평균이 아니다). `StatsSummary`/`Rankings` 의 새 필드는 대응하는 REST 엔드포인트가 죽은 코드라 백엔드 스키마는 안 건드림. `npm run check` 431 passed(회귀 0), `vite build` 정상, 시크릿 스캔 통과. **Playwright 로 실데이터(406종·1,079병) 대상 확인** — 도넛이 실제 병 상태 비율을 보여주고, 측정값을 "평균 도수" 로 바꾸면 차트가 즉시 다시 그려지며, 가성비 랭킹 1위가 실제로 저가 막걸리로 나옴을 확인. 근거는 `plan.md` Task 24 PR5 절, D134~D137 |
| Task 24 PR6 — 주종 관리 UX 개편(2026-08-05, [#52](https://github.com/jihoon22-lee/SoolJang/pull/52) `feat/category-manager-ux`, 머지됨) | 순수 프론트엔드(백엔드 변경 없음). `CategoryManager.tsx` 의 이동·병합 `<select onChange={...}>`(즉시 실행) 를 `이동`/`병합` 버튼 + 대상 선택 확인 패널로 교체(기존 `DeleteControl` 의 2단계 확인 패턴 재사용) — 병합은 대상을 고르면 "{이름}(제품 N종)을 {대상} 로 합치고 삭제합니다. 되돌릴 수 없습니다." 를 먼저 보여준다. `CategoryBranch` 에 접기/펼치기(기본 펼침, 하위 있는 행만 토글 노출)와 이동 성공 후 2초 하이라이트를 추가. `CategoryManagerProps` 의 블랭킷 `busy`/`error` 를 `renameStatus`/`reparentStatus`/`mergeStatus`/`removeStatus`(각 `{isPending, isSuccess, variables, error}`) 로 바꿔 `mutation.variables?.id === node.id` 로 행 단위 busy·오류를 판별 — `CategoriesPage` 는 `useMutation` 결과를 그대로 넘긴다(구조적 타이핑, 글루 코드 없음). `categoriesApi.reorder` 는 노출하지 않기로 결정하고 `queries.ts` 주석으로 문서화. `npm run check` 438 passed(회귀 0), `vite build` 정상, 시크릿 스캔 통과. **Playwright 로 실데이터(주종 44개) 대상 확인** — 브랜디·와인·위스키 접기/펼치기, "메즈칼"→"럼" 이동 후 하이라이트, 병합 대상 선택 시 영향(제품 1종) 문구, 취소 동작을 실클릭으로 확인(이동은 되돌려 원상 복구). 근거는 `plan.md` Task 24 PR6 절, D138~D141 |
| Task 24 PR7 — 오프라인 조회 성능 개선(2026-08-05, [#53](https://github.com/jihoon22-lee/SoolJang/pull/53) `perf/offline-queries`, 머지됨, Task 24 마지막 PR) | 순수 프론트엔드(백엔드 변경 없음). B13 을 구현하기 전 "`deleted_at` 인덱스를 실제로 쓴다" 는 원 가설을 `fake-indexeddb` 로 직접 검증했다 — `.where("deleted_at").equals(null)` 은 `Invalid key provided` 로 실패한다(IndexedDB 스펙에서 `null` 은 유효한 키가 아니다). 대신 소유 관계(FK) 로 범위를 좁히는 쪽으로 방향을 바꿨다: `getProduct`/`getPurchasesForProduct`/`getBottlesForProduct` 를 `loadProductScope()` 하나로 묶어 `sku.product_id`→`purchase.sku_id`→`bottle.purchase_id` 인덱스만 읽게 했다(전체 목록 경로와 조립 로직 `assembleOneProduct` 공유). `ProductsPage` 는 `getProductCatalog()`+`filterAndSortProducts()` 로 나눠 필터 있는/없는 두 뷰를 한 번의 조립에서 파생시키고, `StatsPage` 는 `getStatsDashboard()` 로 랭킹·주종별 집계·전체 합계·트리를 한 쿼리로 묶었다(기존 `getStatsRankings`/`getCategoryRollup`/`getStatsSummary` 공개 시그니처는 그대로 유지). `StoreModePage` 의 `rankByQuery` 를 `useMemo` 로 감쌌고, `pullDeltas` 는 여러 페이지의 네트워크 응답을 다 모은 뒤 DB 반영을 트랜잭션 하나로 끝내게 바꿨다(`flushOutbox` 와 같은 이유 — 페이지마다 커밋하면 `useLiveQuery` 구독자가 그만큼 다시 계산된다). `npm run check` 438 passed(회귀 0), `vite build` 정상, 시크릿 스캔 통과. **측정은 코드 근거(호출 지점 추적으로 확인한 읽기 횟수 감소) + Playwright 실데이터(406종·1,079병) 클릭 검증(내 술 목록·제품 상세·통계·매장 모드 검색, 회귀 0건)으로 했다** — 별도 브라우저 프로필의 DevTools 트레이스 전후 비교는 로그인 준비가 이번 세션에서 여의치 않아 다음 세션 과제로 남겼다. 근거는 `plan.md` Task 24 PR7 절, D142~D146 |
| 데일리샷 실등록 + adapter JSON 모드(2026-08-05, [#56](https://github.com/jihoon22-lee/SoolJang/pull/56) `feat/adapter-json-mode`, 머지됨) | 사용자 요청으로 외부 소스 데일리샷을 실제로 등록하려다 두 가지 실측 결함을 발견해 고쳤다. (1) 데일리샷은 Next.js SPA 라 검색 결과 페이지 원본 HTML 에 상품 정보가 없다 — 브라우저가 호출하는 공개 JSON API(`api.dailyshot.co/items/search/`, robots.txt 허용 확인)를 찾아 `adapter_spec` 에 `format: json` 모드를 새로 추가했다(`path` 기반 필드 추출, `result_fields` 로 상세 재조회 생략, `url_template` 으로 아이템 필드에서 링크 조립). (2) 실제 조회로 검증하다 이름 유사도 매칭이 "글렌고인"을 "글렌리벳"으로, "글렌알라키"를 "글렌그란트"로 잘못 매칭하는 걸 발견했다 — 둘 다 "글렌…" 접두사만 같은 다른 증류소인데 전체 문자열 유사도(0.53/0.44)가 기존 임계값(0.4)을 넘었다. 접두사 4글자 유사도 게이트(`_plausible_candidate`)를 추가해 고쳤다 — **임계값을 올리는 단순한 수정으로는 못 고친다**는 것도 실측으로 확인했다(오탐 "우드포드 리저브"→"우드포드 리저브 라이"의 유사도 0.875 가 정탐 "부나하벤 12y"→"부나하벤 12년"의 0.857 보다 더 높다). `pytest` 696 passed(회귀 0), `npm run check` 통과. **Playwright 로 `#sources` 실등록 + 실제 제품("글렌알라키 10y 캐스크 스트렝스 #5")으로 조회까지 성공 확인**(가격 98,900원·평점 4.9·리뷰 738개, 출처 링크도 실제로 검증). 근거는 `plan.md` §5 D147~D148 |
| **`v1.1.0` 정식 릴리스·배포(2026-08-06, [#58](https://github.com/jihoon22-lee/SoolJang/pull/58) 버전 범프 + 실제 태그 푸시)** | `v1.0.0` 이후 Task 24 7개 PR(#47~#53)과 어댑터 개선(#56)을 담아 MINOR 버전을 올렸다. `uv version 1.1.0`/`npm version 1.1.0 --no-git-tag-version`/`src/sooljang/__init__.py::__version__` 를 맞추고(PR #58), `SOOLJANG_DOCKER_SG=1 bash scripts/backup.sh` 로 백업(178KB, 테이블 21개 검증)을 먼저 떴다 — 이 과정에서 `backup.sh` 가 `ast-grep` 에 가려진 `sg` 를 잘못 호출해 백업이 실패하던 버그를 발견해 함께 고쳤다(§5 표 참조, PR #59). `SOOLJANG_ALLOW_TAG_PUSH=1 git push origin v1.1.0` 으로 태그를 푸시하니 릴리스 워크플로가 실제로 돌아 GHCR 게시 + [GitHub 릴리스](https://github.com/jihoon22-lee/SoolJang/releases/tag/v1.1.0) 생성까지 끝났다. **이번엔 진짜로 GHCR 에서 `docker pull` 했다**(Q8 에서 확인한 `read:packages` 스코프 덕분) — 단 `docker pull` 자체는 `denied` 로 한 번 실패했는데, `gh` CLI 토큰 스코프와 **Docker 데몬의 `ghcr.io` 로그인은 별개라 `gh auth refresh` 만으로는 Docker 쪽이 갱신되지 않는다**는 걸 실측으로 알았다 — `gh auth token | docker login ghcr.io -u <user> --password-stdin` 로 재인증한 뒤 정상 pull 됐다(§5 새 함정 참조). `docker compose pull && docker compose up -d`(`.env` 의 `SOOLJANG_VERSION=1.1.0`)로 재배포, `db` 는 재시작 없이 유지(데이터 무손상), `GET /api/v1/health` 로 `version:"1.1.0"`·`database_connected:true`·컨테이너 3개 모두 `healthy` 확인 |
| Task 25 PR1 — 내 술 레이아웃·필터(2026-08-07, [#62](https://github.com/jihoon22-lee/SoolJang/pull/62) `fix/products-layout-filters`, 머지됨) | 순수 프론트엔드(백엔드 변경 없음). 사용자가 v1.1.0 사용 중 스크린샷과 함께 보고한 5가지 문제 중 항목 1·2 를 실측으로 진단·수정했다: `.product-table th` 선택자가 `thead` 로 스코프되지 않아 tbody 행 헤더(제품명)에도 걸려 이름 열이 줄바꿈을 거부하고 나머지 열이 글자 단위로 쪼개지던 버그(`thead th`/`tbody th` 로 분리해 수정), `LabelOcrPanel` 트리거가 `.field` 마진 때문에 flex 줄 높이를 늘려 형제 버튼들이 함께 커지던 버그, `.app-main`/사이드바 폭 조정(1600→1760px, 280→260px), 구매일 필터(`purchased_on_min/max`)와 누락된 정렬 옵션 4종 추가, 모바일 기본 접힘 필터 패널. **`<details>` 로 "모바일 접힘 + 데스크톱 강제 펼침" 을 구현하려다 실브라우저에서 실패하는 걸 발견**했다(§5 새 함정 참조 — 닫힌 `<details>` 자식은 `content-visibility:hidden` 이라 `display` 오버라이드로 못 되돌린다) — `useState`+버튼 조합으로 다시 구현했다. `npm --prefix web run check` 440 passed(회귀 0), `vite build` 정상. **로그인된 실브라우저(Chrome DevTools MCP, 실데이터 406종)로 390/768/1280/1908px 전후 스크린샷 비교, 구매일 필터(406→1건으로 좁혀짐), "/" 단축키가 접힌 패널을 펼치는지까지 직접 확인**. 근거는 `plan.md` Task 25 PR1 절, D149~D151 |
| `PivotExplorer.tsx` 리터럴 NUL 바이트 제거(2026-08-06, `fix/pivot-explorer-nul-bytes`) | Task 25 v1.1.0 2차 피드백 PR들을 독립 코드 리뷰하다가 발견 — `cellByKey` 조합 키를 만드는 템플릿 리터럴 3곳(148·294·305행)이 구분자로 **진짜 NUL 바이트**(`\x00`)를 쓰고 있어(이스케이프 `\x00` 이 아니다) git 이 파일 전체를 바이너리로 인식했다. 그 결과 `git diff`·`git grep`·평범한 `grep` 이 이 파일 내용을 전혀 보여주지 못했다(`file` 명령으로 "data" 확인) — Task 24 PR5(통계 차트 개편)부터 이미 있던 결함이라 Task 25 자체와는 무관하지만, 방금 진행한 리뷰 자체를 가로막고 있어 바로 고쳤다. `\x00` 이스케이프로 바꾸면 런타임 동작은 완전히 같다(같은 NUL 문자가 생성됨) — `npm run check` 438 passed(회귀 0)로 확인. 이 파일을 다시 열 일이 있으면 `git diff`/`grep` 이 이제 정상 작동한다 |
| Task 25 PR2 — 주종 관리 개편(2026-08-06, [#63](https://github.com/jihoon22-lee/SoolJang/pull/63) `feat/category-manager-polish`, 머지됨) | 순수 프론트엔드(백엔드 변경 없음). PR1 이 GitHub Actions 장애로 머지 대기 중인 동안 `main` 기준 별도 브랜치에서 먼저 진행했다. "주종 추가" 폼을 `addOpen` 조건부 렌더링 토글로 바꾸고(CSS 은닉이 아니라 언마운트 — `ProductsPage` "새 술 등록"과 같은 패턴), 행 액션 버튼(이름변경·이동·병합·삭제)을 `.category-row-actions` 로 묶어 900px 이상에서만 `--control-h-sm` 로 축소하고(모바일 44px 터치 타깃은 유지), 트리 표시를 `descendant_product_count` 내림차순(동률은 이름순, 모든 계층 레벨에 재귀 적용)으로 정렬했다 — `getCategoryTree()` 자체의 전역 이름순 정렬(다른 화면 `<select>` 드롭다운이 공유)은 그대로 뒀다. `npm --prefix web run check` 441 passed, `vite build` 정상. **실브라우저(실데이터 406종·주종 44개)로 확인** — 맥주(114)·와인(110)·위스키(75) 등 모든 계층에서 내림차순 정렬이 정확함을 접근성 스냅샷으로 확인, "+ 주종 추가" 토글, 버튼 크기 축소를 스크린샷으로 확인. 근거는 `plan.md` Task 25 PR2 절, D152~D154 |
| Task 25 PR3 — 구매처 검색+자동완성(2026-08-06, [#64](https://github.com/jihoon22-lee/SoolJang/pull/64) `feat/vendor-search`, 머지됨) | 순수 프론트엔드(백엔드 변경 없음). `VendorsPage` 에 기존 `AutocompleteInput`+`search.ts::rankByQuery`/`matchesQuery` 재사용(`ProductDetail.tsx` 의 구매처 이름 자동완성과 같은 조합)으로 검색창을 추가했다 — 하나의 `vendorQuery` state로 자동완성 드롭다운과 목록 실시간 필터링을 동시에 한다. `npm --prefix web run check` 441 passed(신규 3건), `vite build` 정상. **실브라우저(실데이터 64곳)로 확인** — "코스트코" 입력 시 목록이 4개로 정확히 좁혀지고 자동완성 드롭다운도 같은 4개를 보여줌을 스크린샷으로 확인. 독립 코드 리뷰에서 `vendorNames` 를 `useMemo` 로 한 번 더 감싸 실제로 메모이제이션되게 고쳤다. 근거는 `plan.md` §5 Task 25 PR3 결정, D155 |
| Task 25 PR4 — 통계 커스텀 피벗 버튼 높이(2026-08-06, [#65](https://github.com/jihoon22-lee/SoolJang/pull/65) `fix/stats-pivot-buttons`, 머지됨, Task 25 마지막 PR) | 순수 프론트엔드(백엔드 변경 없음). `PivotExplorer.tsx` 의 `<form className="field-row">` 가 필드 5개(홀수) + `<div className="button-row">`(실행/CSV 내보내기)를 2열 grid 에 담아, 기본 `align-items:stretch` 때문에 마지막 필드("주종 필터")와 같은 행을 나눠 쓰는 button-row 가 그 필드의 라벨+select 높이까지 늘어나 "실행"/"CSV 내보내기" 버튼이 세로로 길게 늘어났다. `.field-row > .button-row { grid-column: 1 / -1; }` 한 줄로 고쳤다 — 버튼 줄이 항상 전체 폭 단독 행을 차지해 다른 `.field-row` 사용처(필드 쌍만 감싸는 곳들)는 영향받지 않는다(grep 확인). `npm --prefix web run check` 438 passed, `vite build` 정상. **실브라우저(로그인 세션, 실데이터)로 커스텀 피벗 "실행" 클릭 → "실행"/"CSV 내보내기" 버튼 모두 정상 높이로 렌더링됨을 스크린샷으로 확인**. 이로써 Task 25(v1.1.0 실사용 2차 피드백) 5개 항목이 전부 반영됐다. 근거는 `plan.md` §5 Task 25 PR4 결정, D156 |
| **`v1.1.1` 정식 릴리스·배포(2026-08-07, [#67](https://github.com/jihoon22-lee/SoolJang/pull/67) 버전 범프 + 실제 태그 푸시)** | Task 25 4개 PR(#62~#65)과 `PivotExplorer.tsx` NUL 바이트 수정(#66)을 담아 PATCH 버전을 올렸다(Task 24→v1.1.0 의 MINOR 승격 전례와 달리, 이번 5항목은 버그 수정·UX 폴리시라 PATCH 로 판단). `uv version 1.1.1`/`npm version 1.1.1 --no-git-tag-version`/`src/sooljang/__init__.py::__version__` 를 맞추고 PR #67 로 머지, `SOOLJANG_DOCKER_SG=1 bash scripts/backup.sh` 로 백업(179KB, 테이블 21개 검증) 후 `SOOLJANG_ALLOW_TAG_PUSH=1 git push origin v1.1.1` 로 태그 푸시 → 릴리스 워크플로가 돌아 GHCR 게시 + [GitHub 릴리스](https://github.com/jihoon22-lee/SoolJang/releases/tag/v1.1.1) 생성까지 끝났다. `docker compose pull && docker compose up -d`(`.env` 의 `SOOLJANG_VERSION=1.1.1`)로 재배포, `db` 는 재시작 없이 유지(데이터 무손상), `GET /api/v1/health` 로 `version:"1.1.1"`·`database_connected:true`·컨테이너 3개 모두 `healthy` 확인. 배포 전에 SoolJang 과 무관한 tailscale 서빙(PointBook `:8002`, opencode `:8443`)은 그대로 두고, 4일 넘게 떠 있던 도커화 이전의 낡은 `sooljang-api` 프로세스(포트 8001)만 종료했다 |
| 전체 코드베이스 점검(2026-08-07, v1.1.1 배포 직후) | 백엔드/프론트엔드/인프라·문서 3갈래로 독립 서브에이전트를 병렬로 돌려 전수 점검했다. **크리티컬·보안 이슈 없음** — SQL 인젝션·시크릿 처리·인증·SSRF·파일 업로드 경로 전부 안전하게 구현돼 있음을 재확인했다. 실제로 고칠 만한 건 두 가지였다: (1) `ProductsPage.tsx`/`StoreModePage.tsx` 의 `vendorNames` 가 `useMemo` 없이 매 렌더마다 새 배열을 만들어 자식 컴포넌트의 `useMemo` 를 무력화하고 있었다(`VendorsPage.tsx` 는 Task 25 PR3 리뷰 때 이미 고쳐져 있었는데 같은 패턴이 두 곳 더 남아 있었다) — 즉시 수정. (2) `plan.md`/`handoff.md` 가 `v1.1.1` 머지 완료 상태를 반영하지 못하고 "PR4 머지 진행 중"·`v1.1.0` 최신 버전으로 멈춰 있었다 — 이 문서와 `plan.md` 를 전부 최신화하고, 병합 과정에서 데이터 없이 비어 있던 D155 결정 로그 행도 채웠다. 그 밖의 경미한 발견(접근성 포커스 관리, 온라인/오프라인 타입 정합성, 테스트 커버리지 갭 등)은 `plan.md` §9 릴리스 후 백로그에 기록만 하고 코드는 건드리지 않았다 — 판단이 더 필요하거나 사용자 확인이 먼저 필요한 항목들이다 |
| Task 26 — 내 술 레이아웃 재조정 + 주종 관리 액션 정리(2026-08-07, [#69](https://github.com/jihoon22-lee/SoolJang/pull/69)) | 순수 프론트엔드(백엔드 변경 없음). 사용자가 v1.1.1 스크린샷과 함께 두 가지를 재지적했다. (1) 내 술 표: `.product-table td.numeric` 에 제품명 열을 위한 `overflow-wrap:anywhere` 가 그대로 걸려 있어 도수·재고·평단가·100ml당·내 평점이 "14.5"/"%" 처럼 글자 단위로 쪼개졌다 — `white-space:nowrap` 으로 고쳤다. `.app-main` max-width 를 고정 1760px→`min(2200px,96vw)`, 사이드바 260→240px, `.table-scroll` 높이 상한 65vh/720px→78vh/900px, 버튼 줄과 표 사이 `margin-top` 추가(전에는 0이라 붙어 보였다). (2) 주종 관리: 이름변경/이동/병합/삭제 4개 버튼이 44개 행 전부에 항상 나열되던 걸, 전역 `activeId` 하나로 바꿔 이름을 눌러야 그 행 하나만 펼쳐지게 했다(조건부 렌더링이라 `ReparentControl`/`MergeControl`/`DeleteControl`/이름 편집의 내부 상태도 행이 접힐 때 자동 초기화된다). `npm --prefix web run check` 446 passed(회귀 0), `vite build` 정상. **실브라우저(Chrome DevTools MCP, 로그인 세션, 실데이터 406종·주종 44개)로 1280px·2611px(≈1920px 논리 해상도)·390px(모바일) 전후 스크린샷 비교, 이름 클릭으로 액션 펼침/다른 행 선택 시 자동 접힘/취소 시 데이터 불변을 직접 클릭해 확인**. 근거는 `plan.md` §5 Task 26 결정, D157~D159 |
| Task 27 — 주종 관리: 이름 클릭 시 술 목록 이동 복원(2026-08-08, [#71](https://github.com/jihoon22-lee/SoolJang/pull/71)) | 순수 프론트엔드(백엔드 변경 없음). v1.1.2 배포 직후 사용자가 회귀를 지적했다 — "기존에는 주종을 누르면 해당 주종의 술 목록이 보이도록 이동했었는데, 이제 그게 안 되네." 확인해 보니 `CategoryManager` 자체엔 이 드릴다운이 원래 없었다 — "이름 클릭 → 술 목록 이동"은 통계 탭(`onSelectCategory`)·구매처 탭(`onSelectVendor`)에만 있던, 앱 전체의 확립된 관례였는데 Task 26 에서 이름 자체를 관리 토글로 바꾸며 깨진 것이다. 이름(`.link-like`, 신규 `onSelectCategory` prop → `App.tsx` 에서 `navigate({view:"products",categoryId})`)과 관리 패널 토글(새 "관리" 버튼, `.category-manage-toggle` — Task 26 의 `.category-name-button` 을 이름만 바꾸고 이름보다 낮은 톤으로)을 분리해 `VendorsPage` 와 같은 패턴으로 되돌렸다. `npm --prefix web run check` 447 passed(신규 1건, 회귀 0), `vite build` 정상. **실브라우저(Chrome DevTools MCP, 로그인 세션, 실데이터)로 확인** — "위스키" 이름 클릭 → `#products?category=<id>` 로 이동하고 목록이 위스키(75종)로 정확히 필터링됨을, "관리" 버튼은 여전히 액션 패널을 펼치고 접는지 확인. 근거는 `plan.md` §5 Task 27 결정, D160 |
| Task 28 — 주종 관리: 현재 구조를 기본값으로 저장(2026-08-08, [#73](https://github.com/jihoon22-lee/SoolJang/pull/73)) | Task 27 작업 중 사용자가 새로 요청("현재 주종 구조를 기본 구조로 저장하는 것도 있으면 좋겠어"). 지금까지 "기본 주종 복원"은 하드코딩된 전역 기본값(`infrastructure/legacy/categories.py::DEFAULT_CATEGORY_PATHS`)으로만 되돌렸다. **새 백엔드 테이블**(`CategorySeed`, `LlmSetting`/`SavedView` 와 같은 "사용자당 활성 행 최대 1개" JSON 저장 패턴, 마이그레이션 `757982c7b323`)을 추가해 사용자가 저장해 둔 구조가 있으면 그걸 우선하도록 `seed_default_categories` 를 수정했다(`_resolve_seed_paths`). 빈 트리를 저장한 경우도 정직하게 존중해 앱 기본값으로 몰래 폴백하지 않는다(D161). 새 엔드포인트 `POST /categories:save-as-default` 는 `:reset-seed` 와 같은 `CategoryTreeOut` 응답을 재사용한다. 프론트엔드는 `categoriesApi.saveAsDefault()` + `CategoryManager` 의 "기본 주종 복원" 옆에 "현재 구조를 기본으로 저장" 버튼과 성공 안내(`<output>`)를 추가했다. `npm --prefix web run check` 451 passed(신규 4건), `make test`(pytest 699 passed(신규 3건)+29 skipped), `make migration-check`(up→down→up 왕복) 전부 통과. **API 레벨로 전체 사이클을 직접 확인** — 격리된 로컬 개발 DB(`sooljang_dev`, 프로덕션과 무관)로 `uv run sooljang-api` 를 띄우고 curl 로 커스텀 주종 생성→저장→삭제→복원까지 실행해, 저장해 둔 구조가 정확히 되살아나고 앱 기본값은 안 섞여 들어옴을 확인했다. **실브라우저(Chrome DevTools MCP)로도 버튼 클릭 → 안내 문구 노출을 확인**. 근거는 `plan.md` §5 Task 28 결정, D161 |

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

### 다음 착수: Task 23 태그·배포 진행 중 — 그 외엔 사용자가 미루기로 한 항목뿐

**(이 절 전체는 2026-08-02 시점 기록이다 — Task 21·22 는 이제 완료됐다. 아래는 옛 기록으로
남겨 두되, 최신 상태는 위 "지금까지 한 일" 표의 Task 21/22/하드닝 행과 `plan.md` §1 "현재
위치"를 본다. 요약(2026-08-03 갱신): 사용자가 `v1.0.0` 태그 푸시·배포·모바일 접속을
승인해 진행 중이다. 7개 판매처 사이트 `adapter_spec` 등록·Task 19/PR11 은 여전히 안 했지만,
이건 사용자가 **직접 미루기로 결정**한 것이다(Q3/Q5 참조) — 이 개발 환경(WSL2, `curl`/
`tailscale` 등 원시 셸 도구는 실제 외부 인터넷에 닿는다) 자체의 접속 제약 때문이 아니다.
`WebFetch`/Playwright 도구가 별도 네트워크 경로를 타 DNS 조회가 막히는 것과는 별개다.)**

Task 22 Track 1~4(10 PR, #26~#35)를 실행하며 Task 21 항목 상당수를 이미 채웠다. 남은 것:
- `docs/review-<날짜>.md` 작성(아직 없음)
- 모바일 실기기 검증(이 샌드박스엔 실기기가 없어 여전히 불가능 — 배포 후 수동 확인)
- Task 21 완료 표시(§3 체크리스트)와 이 문서·`plan.md` 최종 정리

그 다음은 **PR11(시세 이력·알림, Task 19)** 인데 Q5(웹 푸시 채널)가 미해결이고 "PR9·10 이
실제로 쓸 만한지 확인한 뒤" 라는 조건도 아직 충족되지 않았다 — 바로 착수하지 않는다.
검색 API 제공자(Q2 후반, `search` 전략)도 여전히 미해결이다.

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

**Task 17 에서 남긴 것**:
- `POST /attachments` 를 새로 만들었다(architecture.md 가 Task 10 산출물로 문서화했지만
  실제로는 없었던 엔드포인트, Task 16 의 `PATCH /skus/{id}` 와 같은 종류의 갭). 지금은
  이미지만 받는다 — 다른 파일 형식(PDF 등)은 필요해지면 그때 확장한다
- 라벨 OCR 이 뽑는 생산자·숙성연수는 `ProductForm` 에 대응하는 입력칸이 없어(기존
  공백, Task 17 이 새로 만들지 않았다) 메모 필드로 우회했다. 제품 생성 API 에
  `producer_id` 프리필 경로(생산자 이름 → id 자동 매칭, `resolveVendorId` 와 같은 패턴)를
  붙이는 게 다음 개선 후보다
- 라벨 OCR·설정 화면 모두 온라인 전용이다(outbox 를 거치지 않는다) — Task 15/16 과 같은
  판단 기준(카메라·LLM 호출 자체가 온라인을 전제한다)
- LLM 실사용 예산 상한은 여전히 미정이다. Task 18(외부 소스 요약)처럼 LLM 을 상시
  호출하는 기능을 붙이기 전에는 사용자에게 다시 확인해야 한다

**Task 20 에서 남긴 것** (원 사양 중 이번에 이연한 것, `plan.md` D88 참조):
- 엑셀 내보내기 대신 CSV 만 — 새 무거운 의존성(`openpyxl` 류)을 들이지 않았다
- 읽기 전용 공유 링크는 이연 — 보안에 민감한 설계(토큰 발급·만료·폐기)라 별도 검토가
  필요하고, Q6(지인 공유 권한 모델)이 아직 미해결인 것과도 맞물려 있다
- 개인 vs 외부 평점 상관은 이연 — Task 18 이 아직 외부 평점 데이터를 수집하지 않아
  비교할 대상이 없다
- 시계열은 월별 지출·구매 병수 2종만. "누적 자산"·"개봉 후 소진 기간"(제품 단위로는
  `domain/metrics.ts::computeProductMetrics` 의 `averageDaysToFinish` 로 이미 존재)을
  시계열로 다시 뽑는 건 범위를 넓히는 별도 작업이다
- 분포 히스토그램은 이연 — 피벗·시계열만으로 데모 시나리오를 완결할 수 있었다
- 통계 v2 전체가 온라인 전용이다(D87) — Task 16·17 과 같은 판단 기준

### 의존 관계 요약

```
7 도메인모델 → 8 파생지표 → 9 REST API → 10 웹 UI → 12 인증·HTTPS → 13 병·시음 → 15 PWA → 16 바코드 → 17 OCR
6 파서 ─┬→ 11 임포터 → 14 통계v1 → 18 외부소스 → 19 사이트어댑터 ─┐
8,10 ──┘                        └→ 20 통계v2(완료) ─────────────┴→ 21 릴리스
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
| **`EntityMixin.user_id` 는 이미 `index=True` 다** | 새 모델에 `Index("ix_<table>_user_id", "user_id")` 를 직접 추가하면 `alembic revision --autogenerate` 가 같은 이름의 인덱스를 두 번 만들려다 `DuplicateTable` 로 실패 | 단일 컬럼 `user_id` 인덱스는 mixin 이 이미 만든다. 새로 추가할 건 `(user_id, 다른컬럼)` 같은 **복합** 인덱스뿐이다. `llm_setting` 모델 작성 중 실제로 겪음(Task 17) |
| **`httpx` 가 dev 그룹에만 있었다** | 로컬·CI 는 항상 dev 의존성이 함께 설치돼 안 터지지만, `docker build --no-dev` 운영 이미지엔 아예 설치되지 않는다 — 해당 코드가 실행되는 순간에만 `ModuleNotFoundError` | 프로덕션 코드(`api/routes/*.py`, `infrastructure/**`)가 직접 import 하는 패키지는 반드시 `[project.dependencies]`(main)에 둔다. dev 그룹은 테스트·린트 도구 전용이다. Task 16 부터 잠재했던 버그를 Task 17 에서 발견·수정(D83) |
| **CI `migration-check` 잡이 `alembic` 을 pytest 밖에서 직접 돌린다** | `Settings` 에 필수 필드(`secret_key` 등)를 새로 추가하면 그 잡만 `ValidationError` 로 실패 — `python-quality` 잡은 `conftest.py` 의 autouse fixture 가 채워 줘서 통과한다 | 새 필수 설정을 추가할 때 `.github/workflows/quality.yml` 의 `migration-check` 잡 `env:` 에도 테스트용 값을 추가해야 한다. Task 17 에서 `SOOLJANG_SECRET_KEY` 를 추가하며 실제로 겪음 — PR 을 올리고 나서야 CI 에서 발견했다(로컬은 `.env` 가 있어 안 터진다) |
| **의존성 상한을 너무 느슨하게 잡으면 CI `pip-audit` 이 나중에 실패한다** | `cryptography>=46,<47` 로 고정했는데 46.x 에 이미 알려진 취약점(GHSA)이 있어 `pip-audit --strict` 가 실패 | 새 의존성을 추가할 때 `pip-audit` 를 로컬에서도 한 번 돌려 본다: `uv export --frozen --no-dev --no-emit-project --format requirements.txt -o /tmp/req.txt && uv run --with pip-audit pip-audit --strict -r /tmp/req.txt`. Task 17 에서 발견 |
| **`vi.stubGlobal("URL", {...URL, 메서드})` 로 전체 URL 을 바꿔치기하면 생성자가 사라진다** | `URL.createObjectURL` 을 목킹하려다 `{...URL}` 스프레드로 교체하면, `URL` 이 더 이상 `new URL(...)` 로 생성자 호출이 안 되는 평범한 객체가 된다 — 다른 코드가 조용히 깨진다 | 전체를 바꿔치기하지 않는다. `URL.createObjectURL = vi.fn()` 처럼 필요한 정적 메서드만 직접 얹고, 테스트 끝에 `undefined` 로 되돌린다. `PivotExplorer.test.tsx`(Task 20) CSV 내보내기 테스트에서 실제로 겪음 — 실패 증상이 "표가 안 뜬다"로 나타나 원인 파악에 시간이 걸렸다 |
| **이 개발 환경 자체가 사용자의 홈 PC(WSL2)다 — "샌드박스라 인터넷이 안 된다"는 도구별 얘기지 이 기기 얘기가 아니다** | `WebFetch`/Playwright 브라우저는 임의 외부 도메인 DNS 조회가 막히지만, `curl`/`ping`/`tailscale` 같은 원시 셸 명령은 실제로 외부 인터넷·tailnet(`main.tail30f401.ts.net`, 이 기기 자신)에 닿는다. `docker ps` 도 `permission denied` 지만 `sg docker -c "..."` 로 우회 가능(§5 위 행 참조) — 실제로 `docker compose` 스택(web/api/db)이 이미 떠 있었다(단, 이전 빌드라 최신 코드가 아닐 수 있다) | 배포·외부 사이트 조사처럼 "이 샌드박스는 못 한다"고 넘겨짚기 전에, Bash 로 직접 `curl`/`tailscale status`/`sg docker -c "docker ps"` 를 먼저 확인한다. `tailscale serve status` 로 현재 폰에 실제로 뭐가 노출돼 있는지도 확인할 것 — 2026-08-03 시점엔 "No serve config"였다(아무것도 안 뜬 상태) |
| **이 개발 환경에 로컬 Postgres 인스턴스가 두 개 떠 있다** | `#scan`(매장 모드) 실클릭 검증 중 `/external-lookup` 이 500 을 반환. 원인은 코드가 아니라 프론트 dev 서버(5173)가 프록시하는 API(포트 8000/8001, `postgresql://…@127.0.0.1:5432/sooljang`, 실데이터 406종)가 `alembic upgrade`(포트 54329, `sooljang_dev`/`sooljang_test`, `scripts/dev-db.sh` 관리)와 **다른 DB** 라 새 마이그레이션(`0008_external_sources`)이 안 들어가 있었다 | `SOOLJANG_DATABASE_URL` 을 바꿔 가며 작업했다면, 실클릭 검증 전에 **실제로 요청이 가는 서버가 어느 DB 를 보는지**(`ps`/`/proc/<pid>/environ` 로 확인) 를 먼저 맞춘다. 두 DB 모두에 `alembic upgrade head` 를 돌려야 할 수 있다. Task 22 PR9/10 세션에서 실제로 겪음 |
| **Dexie 로 `deleted_at IS NULL` 을 인덱스 range query 로 못 한다** | `db.table(t).where("deleted_at").equals(null)` 이 `Invalid key provided` 로 즉시 실패한다 | IndexedDB 스펙에서 `null` 은 유효한 키 타입이 아니다(숫자·문자열·Date·ArrayBuffer·Array 만 가능) — 값이 `null` 인 레코드는 그 인덱스에 아예 없는 취급을 받는다. "살아있는 행" 을 빠르게 거르고 싶으면 **소유 관계(FK) 로 범위를 좁히는 쪽**(`sku.product_id`, `purchase.sku_id` 처럼 항상 값이 있는 필드)을 인덱스로 쓰고, `deleted_at` 필터는 그 좁혀진 소수의 결과에만 JS 로 적용한다. `fake-indexeddb` 로 30초면 재현 확인 가능(`web/src/sync/queries.ts::loadProductScope` 가 이 패턴의 실제 예). Task 24 PR7 에서 실제로 겪음 |
| **`gh auth refresh -s <스코프>` 로 GitHub CLI 토큰 스코프를 늘려도 `docker login ghcr.io` 는 자동 갱신되지 않는다** | `read:packages` 스코프를 추가한 뒤에도 `docker pull ghcr.io/...` 가 `denied` 로 계속 실패 | `gh` CLI 의 OAuth 토큰과 Docker 데몬이 `~/.docker/config.json` 에 저장해 둔 `ghcr.io` 자격 증명은 별개다 — `gh` 쪽 스코프가 늘어도 Docker 는 예전에 로그인해 둔(또는 스코프가 부족했던) 토큰을 계속 쓴다. `gh auth token | docker login ghcr.io -u <사용자명> --password-stdin` 으로 다시 로그인해야 새 스코프가 반영된다. `v1.1.0` 배포 때 실제로 겪음(2026-08-06) |
| **`scripts/backup.sh` 도 `sg` shadowing 함정에 걸려 있었다** | `SOOLJANG_DOCKER_SG=1 bash scripts/backup.sh` 가 `db` 컨테이너가 실제로 떠 있는데도 "db 컨테이너가 실행 중이 아닙니다" 로 실패 | 위 "docker 그룹 미반영" 함정과 같은 원인 — 스크립트 내부의 `compose()` 헬퍼가 절대 경로 없이 `sg docker -c ...` 를 호출해 `ast-grep` 이 대신 실행됐다. `/usr/bin/sg` 로 고정해 수정([PR #59](https://github.com/jihoon22-lee/SoolJang/pull/59), 2026-08-06). 이 저장소에서 `SOOLJANG_DOCKER_SG=1` 을 쓰는 스크립트를 새로 만들거나 고칠 때는 항상 절대 경로를 쓴다 |
| **닫힌 `<details>` 의 내용은 `display` 를 덮어써도 강제로 보이게 할 수 없다(최신 Chrome)** | `.filter-panel:not([open]) > *:not(summary) { display: block }` 로 900px 이상에서 항상 펼쳐 보이게 하려 했는데, `getComputedStyle` 은 `display:block` 을 정상 보고하면서도 실제로는 그려지지 않았다(`getBoundingClientRect` 는 실제 크기를 보고하는데 화면엔 작은 빈 상자만 보임) | 최신 Chrome 은 닫힌 `<details>` 의 비-summary 자식에 `content-visibility:hidden` 을 적용한다(단순 `display:none` 규칙이 아니다) — `display` 오버라이드만으로는 이 은닉을 되돌릴 수 없다. "모바일 접힘 + 데스크톱 항상 펼침"처럼 열림 상태를 뷰포트별로 강제해야 하면 네이티브 `<details>` 대신 일반 `useState` + 버튼(`aria-expanded`) 조합으로 구현하고, CSS 는 그 상태 클래스만 토글한다(`ProductFilterPanel.tsx`, Task 25 PR1 에서 실제로 겪음, 2026-08-07) |
| **`docker compose up -d` 로 재배포해도 프로덕션 DB 마이그레이션은 자동으로 안 된다** | `docker/api.Dockerfile` 의 `CMD` 가 `uvicorn` 만 바로 실행한다 — `alembic upgrade` 를 호출하는 시작 스크립트가 없다. 새 마이그레이션이 포함된 버전을 배포한 뒤 `GET /api/v1/health` 를 찍어 보면 `migration_revision` 이 새 리비전이 아니라 여전히 이전 값으로 남아 있다(스키마가 없는데도 앱 자체는 500 없이 잘 뜬다 — 새 테이블/컬럼을 실제로 쓰는 요청이 오기 전까지는 증상이 안 보인다) | 스키마 변경이 포함된 릴리스를 배포할 때는 `docker compose pull && up -d` 뒤에 **반드시** `docker compose exec api alembic upgrade head` 를 따로 실행하고, 헬스체크의 `migration_revision` 이 방금 만든 리비전 id 와 일치하는지 확인한다. `v1.1.4`(Task 28, `category_seed` 테이블 추가) 배포에서 실제로 겪음 — 컨테이너는 healthy 로 떴지만 `:save-as-default`/`:reset-seed` 호출 시에만 터졌을 뻔했다 |

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
| Q2 | 검색·LLM API 제공자와 예산 | **LLM 쪽 부분 해결(Task 17)** — OpenAI, 테스트용 키만. **`adapter` 전략은 LLM 없이 PR9 에서 구현 완료.** `search` 전략(검색 API)·상시 LLM 예산은 여전히 미해결 |
| Q3 | 초기 등록할 외부 소스 사이트 목록 | **답 받음(2026-08-03)** — 데일리샷·이마트·트레이더스·코스트코·CU·GS25·emart24. 레지스트리 UI(`#sources`)는 준비됐지만 실제 `adapter_spec` 등록은 아직 안 함 — Task 19/PR11 전 남은 작업 |
| Q5 | 목표가 알림 채널 (웹 푸시 vs 다른 수단) | Task 19 |
| Q6 | 지인 공유 권한 모델 상세 | **미해결 — Task 20 이 "읽기 전용 공유 링크"를 이 질문 때문에 이연했다(D88)**. Task 20 후속 |

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
| **LLM API 설정 등은 `.env` 대신 애플리케이션 내에서 관리** (Task 17 착수 시점, 2026-08-02) | ✅ 설정 화면(`SettingsPage.tsx`) + `GET·PUT·DELETE /llm-settings` 신설. DB 에 Fernet 암호화해 저장(D82). 예외는 암호화 마스터 키(`SOOLJANG_SECRET_KEY`) 하나 — 배포 시 1회만 환경 변수로 설정 |
