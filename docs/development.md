# 개발·검증 절차

공통 지침은 [AGENTS.md](../AGENTS.md), 현재 작업은 [plan.md](plan.md) §1,
운영 절차는 [operations.md](operations.md)를 따른다. 이 문서는 로컬 명령의 범위를 설명한다.

## 격리 환경

이 기기의 `docker-compose.yml`은 운영 스택이다. 개발에는 `make db-local-setup`(최초 1회),
`make db-local-start`를 사용한다. 기본 개발 DB는 `127.0.0.1:54329/sooljang_dev`, 테스트 DB는
`127.0.0.1:54329/sooljang_test`다. `make db-up/db-down`은 Compose를 조작하는 기존 명령이며
개발 준비에 사용하지 않는다. 운영 복원·재배포는 이 절차에 포함하지 않는다.

`Makefile`의 URL은 환경/명령줄로 덮어쓸 수 있다. 실행 전에 대상 host·port·DB 이름이
격리 환경인지 확인하되 자격증명 전체를 출력하지 않는다. pytest fixture는 스키마를
drop/create하고 migration 왕복은 `downgrade base`를 실행하므로 운영 DB에서 실행하지 않는다.
같은 테스트 DB에 대한 pytest·migration 검증은 순차 실행한다.

의존성 변경이 없으면 `uv sync --frozen`, `npm ci --prefix web`로 lockfile을 재사용한다.
환경이 준비돼 있으면 매번 재설치하지 않는다. 기존 `.env`를 예시 파일로 덮어쓰지 않는다.
로컬 앱 실행의 비밀·포트 설정은 [handoff.md](handoff.md) §1을 참조한다.

## 검사 선택

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

## 증거와 완료

동일 코드·환경·입력의 성공 검증을 이유 없이 반복하지 않는다. 실패 원인이나 미해결 우려가
있으면 해당 검증을 확대한다. 단위 테스트 통과와 실사용 수용을 구분하고 해당 WP의
브라우저·복구·성능 검증을 최종 통합 WP로 미루지 않는다.

PR 묶음당 `workthrough/YYYY-MM-DD-scope.md` 하나에 실제 변경·검증·미실행과 제한을 적는다.
`R/S → WP → PR → source SHA → fixture/schema·환경·run → 결과`를 연결하고 계획 문서에는
요약/링크를 남긴다. mock 통과·DB skip·기존 성공 로그를 새 환경의 실검증으로 보고하지 않는다.
형식/링크 검사와 실제 스킬 호출 결과도 구분한다.

## Codex 지침의 근거와 관리

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
