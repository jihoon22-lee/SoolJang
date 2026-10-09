# 개발·검증 절차

공통 지침은 [AGENTS.md](../AGENTS.md), 현재 작업은 [plan.md](plan.md) §1, 운영 절차는
[operations.md](operations.md)를 따른다. 이 문서는 로컬 환경 준비, 검증 선택, 개발 중 알아 둘
함정을 다룬다.

## 1. 격리 개발 환경

**이 기기의 `docker-compose.yml`은 실사용자 데이터가 든 운영 스택이다.** 개발에는 운영과
분리된 사용자 영역 PostgreSQL 17(포트 54329)을 쓴다. `make db-up`/`make db-down`,
`docker compose up/down`, `docker compose exec db ...`는 개발 준비에 쓰지 않는다.

```bash
cd /home/jihoon/projects/SoolJang
git status -sb && git log --oneline -5 && gh pr list --state open
bash scripts/install-hooks.sh      # 클론 직후 1회(commit-msg·pre-push 훅)
uv sync --frozen                   # 의존성이 바뀌었을 때만
npm ci --prefix web
make db-local-setup                # 최초 1회: micromamba로 PostgreSQL 17 설치
make db-local-start                # 이후 재개: 127.0.0.1:54329, sooljang_dev / sooljang_test
```

`Makefile`의 DB URL은 환경·명령줄로 덮어쓸 수 있다. 실행 전에 대상 host·port·DB 이름이 격리
환경인지 확인하되 자격증명 전체를 출력하지 않는다. **루트 `.env`의 `SOOLJANG_DATABASE_URL`이
운영 DB(`127.0.0.1:5432`)를 가리키는지 먼저 확인한다** — Compose `api` 컨테이너는 이 값을 읽지
않으므로(직접 조립) 개발용으로 `…@127.0.0.1:54329/sooljang_dev`를 두는 편이 안전하다. 기존
`.env`를 예시 파일로 덮어쓰지 않는다.

### 앱 실행

운영 API(8000)·웹(8080)과 겹치지 않는 포트를 쓴다.

```bash
export SOOLJANG_DATABASE_URL=postgresql+psycopg://sooljang@127.0.0.1:54329/sooljang_dev
uv run alembic upgrade head                     # 격리 개발 DB인지 확인한 뒤
SOOLJANG_API_PORT=8210 uv run sooljang-api      # 다른 터미널에서 웹:
SOOLJANG_API_URL=http://127.0.0.1:8210 npm --prefix web run dev   # → http://localhost:5173
```

`.env`가 없으면 `.env.example`을 복사해 채운다. `SOOLJANG_SECRET_KEY`(Fernet 마스터 키)는
필수다(`python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`).
빈 DB에서는 첫 화면이 계정 만들기 폼이다. API로 만들 때는
`POST /api/v1/auth/setup {"email","password","display_name"}`를 쓴다(사용자가 없을 때만 허용).

합성 데이터로 써 볼 때는 `tests/infrastructure/legacy/testdata/sample_sheet.csv`를 "가져오기"
화면이나 `POST /api/v1/imports/legacy:commit`으로 넣는다. 실제 기록 파일은 opt-in 검증에만
쓰고 저장소·로그에 남기지 않는다. 개발 DB 계정을 지울 때도 `bash scripts/dev-db.sh psql`
(격리 DB)만 쓴다.

카메라(바코드·라벨·병 QR)와 서비스 워커는 secure context가 필요하다. 폰 실기 확인은 운영과
같은 Tailscale HTTPS 주소(`https://main.tail30f401.ts.net:8080`, [operations.md](operations.md) §5)나
별도 HTTPS 프록시로 한다. `scripts/serve-https.sh --start`는 443 포트를 관리하므로 공유 호스트에서
`tailscale serve status`를 확인하기 전에 실행하지 않는다.

## 2. 검사 선택

| 단계/변경 | 실행할 검증 |
|---|---|
| 구현 중 | 관찰 가능한 동작을 확인하는 관련 테스트부터 실행 |
| 모든 변경 제출 전 | `uv run --frozen ruff check .`, `uv run --frozen ruff format --check .`, `uv run --frozen ty check`, `npm --prefix web run check`, `bash scripts/scan-secrets.sh` |
| 백엔드 동작 변경 | 격리 테스트 URL을 지정한 전체 `uv run --frozen pytest` (branch 포함 85% 유지) |
| 웹 동작 변경 | 웹 check의 Vitest coverage(80%)·build + 해당 실브라우저 시나리오 |
| 스키마/모델 변경 | 폐기 가능한 DB에서 `make migration-check`, 이어서 같은 DB URL로 `uv run --frozen alembic check`; 이전 데이터·중단/재실행·복구 검증 |
| 외부 소스 변경 | mock/contract fixture + 승인 범위 안의 opt-in 실연결; 문서 확인·키 저장·실제 추출을 구분 |
| 문서/지침 변경 | 변경 링크·명령·현재 계획과의 정합성, 스킬 frontmatter와 호출 범위; 문구를 복제하는 코드 테스트는 추가하지 않음 |

직접 Python 테스트를 실행할 때는 운영 환경을 물려받지 않도록 명시한다.

```bash
SOOLJANG_ENV_FILE='' SOOLJANG_ENVIRONMENT=test \
SOOLJANG_DATABASE_URL=postgresql+psycopg://sooljang@127.0.0.1:54329/sooljang_test \
uv run --frozen pytest
```

독립 Alembic 명령은 pytest fixture가 비밀 설정을 채워주지 않는다. 폐기 가능한 테스트 DB를
확인한 뒤 아래처럼 `.env` 로딩을 끄고 일회성 테스트 마스터 키를 메모리에서 생성한다.
운영 암호문 복호화/복원에 사용하는 키가 아니다.

```bash
uv run --frozen python - <<'PY'
import os
import subprocess

from cryptography.fernet import Fernet

test_db_url = "postgresql+psycopg://sooljang@127.0.0.1:54329/sooljang_test"
test_env = dict(os.environ, SOOLJANG_ENV_FILE="", SOOLJANG_ENVIRONMENT="test",
                SOOLJANG_DATABASE_URL=test_db_url,
                SOOLJANG_SECRET_KEY=Fernet.generate_key().decode())
subprocess.run(["make", "migration-check", f"TEST_DB_URL={test_db_url}"],
               env=test_env, check=True)
subprocess.run(["uv", "run", "--frozen", "alembic", "check"], env=test_env, check=True)
PY
```

`make test`는 Python 테스트와 웹 coverage를 실행한다. `make check`는 lint·typecheck·
test·secret scan만 실행하며 웹 build, migration 왕복/드리프트, 버전 일치, workflow lint,
의존성 감사, 컨테이너 빌드 등 전체 CI를 대신하지 않는다. `make migration-check`도 왕복만
실행하므로 모델 드리프트는 별도 `alembic check`가 필요하다. 현재 required gate는
[quality.yml](../.github/workflows/quality.yml)을 기준으로 유지한다.

## 3. 증거와 완료

동일 코드·환경·입력의 성공 검증을 이유 없이 반복하지 않는다. 실패 원인이나 미해결 우려가
있으면 해당 검증을 확대한다. 단위 테스트 통과와 실사용 수용을 구분하고 해당 WP의
브라우저·복구·성능 검증을 최종 통합 WP로 미루지 않는다.

PR 묶음당 `workthrough/YYYY-MM-DD-scope.md` 하나에 실제 변경·검증·미실행과 제한을 적는다.
`R/S → WP → PR → source SHA → fixture/schema·환경·run → 결과`를 연결하고 계획 문서에는
요약/링크를 남긴다. mock 통과·DB skip·기존 성공 로그를 새 환경의 실검증으로 보고하지 않는다.
형식/링크 검사와 실제 스킬 호출 결과도 구분한다.

실사용 흐름 수용은 `docs/plan.md`의 usage/S01~S20과 G01~G09 정답을 사용한다.
제품·규격·구매는 빈 합성 계정에서 UI로 생성하고, API GET/IndexedDB 읽기로 대상 ID와 실제
상태를 확인한다. 서비스워커 제어 후 offline reload, 서버 commit 후 응답 유실, 별도 로그인
context의 동시 수정과 계정 전환을 구분한다. 외부 가격·카메라 경계 mock은 실제 소스·기기
검증이 아니다. 운영 내역·백업·업로드·자격증명은 검증 fixture나 저장소에 포함하지 않는다.

## 4. 알아 둘 함정

| 함정 | 증상 | 대응 |
|---|---|---|
| `docker` 그룹 미반영 | `permission denied … docker.sock` | 새 셸을 열거나 **절대 경로** `/usr/bin/sg docker -c "…"`. 이 기기의 `sg`는 ast-grep으로 가려져 있다 |
| 테스트·스크립트가 운영 DB에 붙음 | 운영 스키마가 지워질 수 있음 | 테스트 기본 URL은 54329다. `SOOLJANG_DATABASE_URL`을 명시하고 `SOOLJANG_ENV_FILE=''`로 `.env`를 막는다 |
| 마이그레이션 왕복을 pytest DB에서 실행 | `DuplicateTable: … already exists` | pytest가 `create_all`로 만든 DB다. 빈 전용 DB(예: `sooljang_migrate`)에서 `make migration-check`를 돌린다 |
| CI 환경 변수 접두사 | `DATABASE_URL`이 무시됨 | 앱 설정은 `SOOLJANG_` 접두사만 읽는다. 새 필수 설정은 `quality.yml`의 migration 잡 `env:`에도 넣는다 |
| SQLAlchemy Enum이 이름을 저장 | `status <> 'unopened'` CHECK가 무력화 | `base.str_enum_column`으로 값을 저장한다 |
| 재귀 CTE 타입 불일치 | `recursive query … character varying(120)` | 비재귀 항의 경로 컬럼을 `text`로 캐스팅한다 |
| 새 모델 등록 누락 | `create_all`·autogenerate가 테이블을 빠뜨림 | `infrastructure/database/models/__init__.py`에 import·`__all__` 등록 |
| `user_id` 단일 인덱스 중복 | autogenerate가 같은 인덱스를 두 번 만듦 | `EntityMixin.user_id`는 이미 `index=True`다. 복합 인덱스만 추가한다 |
| flush 직후 Decimal 정밀도 | 생성 응답 `85000`, 재조회 `85000.00` | 응답 전에 `session.refresh()` |
| 관계 컬렉션이 낡은 값 유지 | 교체한 품종이 응답에 남음 | 수정 후 `session.expire(obj, ["관계명"])` |
| 운영 이미지에 없는 의존성 | 실행 시에만 `ModuleNotFoundError` | 프로덕션 코드가 import하는 패키지는 `[project.dependencies]`에 둔다 |
| 느슨한 의존성 상한 | CI `pip-audit`/`npm audit` 실패 | 새 의존성을 넣으면 로컬에서 감사를 돌린다(§2) |
| Dexie에서 `deleted_at` null 조회 | `Invalid key provided` | IndexedDB 키로 `null`을 못 쓴다. FK 인덱스로 좁힌 뒤 JS에서 거른다 |
| `useLiveQuery` 직후 동기 단언 | 플레이키 테스트 | `findBy*`로 기다린다 |
| 닫힌 `<details>`의 내용 강제 표시 | Chrome이 `content-visibility`로 숨김 | 뷰포트별 강제 펼침은 `useState`+버튼으로 구현한다 |
| `web.Dockerfile`은 `web/`만 복사 | 컨테이너 빌드에서만 import 실패 | 저장소 루트 fixture를 참조하면 Dockerfile에 `COPY`를 추가한다 |
| `vi.stubGlobal("URL", {...URL})` | `new URL()` 생성자가 사라짐 | 정적 메서드만 `vi.spyOn`한다 |
| 전역 `db`를 바꾸는 테스트 | 같은 파일의 뒤 테스트가 다른 저장소를 봄 | `activateDatabase`가 필요한 테스트는 파일을 나눈다(`vendorPrefill.test.tsx`) |
| 시간대 | 한국 00~09시 기록이 전날로 저장 | 웹은 `todayLocal()`, 서버는 `clock.local_today()`를 쓴다(`toISOString()`·`date.today()` 금지) |

## 5. 에이전트 지침의 근거

2026-09-07 OpenAI 공식 문서를 확인해 적용했다.

- [Astra prompting](https://developers.openai.com/api/docs/guides/latest-model): 충돌하는 지침을
  줄이고 승인된 범위의 후속 작업·검증 정도·위임 조건을 명확히 한다.
- [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md): 공통/영역별 지침을
  분리한다. 실행 위치에 따른 발견 범위를 고려해 루트에서 하위 파일 확인을 안내한다.
- [Skills](https://learn.chatgpt.com/docs/build-skills): `.agents/skills/`에 작고 명확한 스킬을
  관리하고 필요할 때 본문을 읽는다. 플러그인 캐시의 직접 수정으로 프로젝트 규칙을 배포하지 않는다.
- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents): 독립적인 읽기 중심
  작업부터 위임하고 동시 수정·토큰 비용을 고려한다.
- [Models](https://learn.chatgpt.com/docs/models), [Config](https://learn.chatgpt.com/docs/config-file/config-basic):
  모델/추론은 실행 설정에서 관리한다. 현재 사용자 선택과 수동 컨텍스트/압축 한계는 유지한다.

효과는 실제 B01 작업에서 불필요한 질문, 중복 검증, 잘못된 명령, 수용 기준 누락이
줄었는지 관찰한다. 형식 검사만으로 속도·품질 개선을 측정했다고 선언하지 않는다.
