# 운영 가이드

**이 저장소를 실제로 운영하는 사람(계정 소유자)을 위한 참고 문서다.** `docs/handoff.md`
는 "다음 작업 세션이 이어받기 위한" 메모(진행 상황, 최근 결정, 함정)라 이 문서와 성격이
다르다 — 환경 변수 의미, 로컬 개발 띄우는 법, 운영 재배포 절차처럼 **세션이 바뀌어도 안
바뀌는 절차**는 여기 둔다.

## 1. `.env` 변수 레퍼런스

`.env` 는 커밋되지 않는다(`.gitignore`). 처음 설정할 땐 `.env.example` 을 복사해서 채운다.

값을 두 종류로 나눠서 본다 — **부팅에 필요한 값**(앱/DB가 뜨기 전에 이미 정해져 있어야
하는 것)은 여기 둘 수밖에 없고, **사용자가 바꾸는 값**은 가능하면 로그인 후 "설정"
화면에서 관리한다(§1.1).

| 변수 | 의미 | 예시 | 필수 |
|---|---|---|---|
| `SOOLJANG_ENVIRONMENT` | `local`\|`test`\|`production`. **Docker Compose로 띄우는 `api` 컨테이너는 이 값을 안 읽는다** — `docker-compose.yml` 이 `production` 을 하드코딩한다. 이 값은 `uv run sooljang-api` 로 직접 실행할 때만 적용된다 | `local` | 아니오 (기본 `local`) |
| `SOOLJANG_DEBUG` | 디버그 로그 활성화 | `false` | 아니오 |
| `SOOLJANG_DATABASE_URL` | `uv run sooljang-api`/`alembic`/`pytest` 를 **직접(도커 밖에서)** 실행할 때 쓰는 DB 접속 문자열. Docker Compose 로 띄운 `api` 컨테이너는 이 값도 안 읽는다 — `docker-compose.yml` 이 `POSTGRES_*` 값으로 직접 조립한다 | `postgresql+psycopg://sooljang@127.0.0.1:54329/sooljang_dev` (로컬 개발용 격리 DB, §2 참조) | 도커 밖에서 실행할 때만 |
| `SOOLJANG_DATABASE_POOL_SIZE` | DB 커넥션 풀 크기 | `5` | 아니오 |
| `SOOLJANG_DATABASE_ECHO` | SQL 쿼리 로깅 | `false` | 아니오 |
| `SOOLJANG_API_HOST` / `SOOLJANG_API_PORT` | `uv run sooljang-api` 로 직접 띄울 때 바인딩 주소. Docker Compose 는 항상 `8000` 고정(`docker-compose.yml`) | `127.0.0.1` / `8000` | 아니오 |
| `SOOLJANG_CORS_ORIGINS` | Vite 개발 서버(`npm run dev`, 기본 `:5173`)가 API 를 호출할 때만 필요. 운영은 `web` 컨테이너가 같은 오리진으로 프록시하므로 비워 둔다 | `http://localhost:5173` | 로컬 개발 시에만 |
| `SOOLJANG_SECRET_KEY` | LLM API 키 등 **DB 에 저장되는 비밀값을 암호화하는 Fernet 마스터 키**. 이 값 자체를 잃어버리면 이미 저장된 비밀값을 전부 다시 입력해야 한다 | `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` 로 생성 | **필수** — 없으면 앱이 기동을 거부한다 |
| `POSTGRES_USER` / `POSTGRES_DB` | Docker Compose `db` 서비스 초기화 값(운영 DB) | `sooljang` | 아니오 (기본값 있음) |
| `POSTGRES_PASSWORD` | 운영 DB 비밀번호 | — | **필수** — 비우면 `docker compose up` 이 기동을 거부한다 |
| `SOOLJANG_VERSION` | `docker compose pull`/`up` 이 받아올 GHCR 이미지 태그. 릴리스마다 갱신한다(§4) | `1.1.7` | 아니오 (기본 `local`, 로컬 빌드 이미지를 쓴다는 뜻) |
| `SOOLJANG_SEARCH_API_KEY` | Task 18 원 사양의 "검색 API로 아무 주종이나 조회" 기능용. **이 기능 자체가 현재 범위 밖**(`adapter` 방식으로 대체됨, `docs/plan.md` 참조)이라 지금은 안 쓰인다 | — | 아니오 (미사용) |

**로그인 후 "설정" 화면에서 관리하는 값**(`.env` 에 넣지 않는다):
- LLM API 키(라벨 OCR용) — Task 17. 저장 즉시 `SOOLJANG_SECRET_KEY` 로 암호화돼 DB에
  저장되고, 화면에는 마스킹된 값만 다시 보인다(원문은 절대 재노출 안 됨 — write-only).
- 표시 이름·비밀번호 — 계정 정보.

## 2. 로컬 개발 환경 띄우기

**`v1.0.0` 부터 이 기기에 운영 배포가 상시 떠 있다.** `docker-compose.yml` 의 `db`
서비스는 이제 **실사용자 데이터가 든 운영 DB** 다 — `docker compose up -d db` 로 로컬
개발용 DB를 얻을 수 있다는 옛 가정은 더 이상 맞지 않는다. 반드시 운영과 분리된 DB를
쓴다.

```bash
# 1) 격리된 개발용 Postgres (최초 1회만 setup)
bash scripts/dev-db.sh setup   # micromamba 로 홈 디렉토리에 PostgreSQL 17 설치, root 불필요
bash scripts/dev-db.sh start   # 포트 54329, DB 이름 sooljang_dev/sooljang_test

# 2) 마이그레이션
SOOLJANG_DATABASE_URL=postgresql+psycopg://sooljang@127.0.0.1:54329/sooljang_dev \
  uv run alembic upgrade head

# 3) API (운영 컨테이너가 8000 을 쓰고 있으니 다른 포트로)
SOOLJANG_DATABASE_URL=postgresql+psycopg://sooljang@127.0.0.1:54329/sooljang_dev \
SOOLJANG_API_PORT=8210 \
  uv run sooljang-api

# 4) 프론트엔드 (다른 터미널)
cd web && SOOLJANG_API_URL=http://127.0.0.1:8210 npm run dev
# → http://localhost:5173
```

이 DB는 비어 있다. `POST /api/v1/auth/setup` 으로 첫 계정을 만들어야 로그인할 수 있다
(운영 계정과 완전히 별개).

```bash
curl -s http://127.0.0.1:8210/api/v1/auth/setup   # {"needs_setup":true} 면 정상
curl -c /tmp/j -X POST http://127.0.0.1:8210/api/v1/auth/setup \
  -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"열자이상비밀번호","display_name":"나"}'
```

**Docker 그룹이 이 셸에 반영 안 됐다면**(`permission denied ... docker.sock`) 새 셸을
열거나 `/usr/bin/sg docker -c "docker ..."` 로 감싼다 — 반드시 절대 경로로. 이 기기엔
`ast-grep` 이 `sg` 라는 이름으로 `PATH` 앞쪽(`~/.local/bin`)에 설치돼 있어, 절대 경로 없이
`sg` 만 쓰면 그룹 전환 대신 `ast-grep` 이 대신 실행된다.

## 3. 백업

배포 전에는 항상 먼저 백업한다.

```bash
SOOLJANG_DOCKER_SG=1 bash scripts/backup.sh          # 생성 + 검증까지
SOOLJANG_DOCKER_SG=1 bash scripts/backup.sh --list
SOOLJANG_DOCKER_SG=1 bash scripts/backup.sh --restore <파일>   # 확인을 묻는다. 기존 데이터를 덮어쓴다
```

## 4. 프로덕션에 새 버전 배포하기

### 4.1 코드 반영

`main` 브랜치는 GitHub ruleset 으로 보호돼 있다 — **본인 포함 아무도 직접 push 할 수
없다.** 항상 브랜치 → PR → CI 통과 → 머지를 거친다.

```bash
git checkout -b fix/뭔가-고친-것
# 수정, 커밋
git push -u origin fix/뭔가-고친-것
gh pr create --base main ...
gh pr checks <번호>          # 전부 green 인지 확인
gh pr merge <번호> --merge --delete-branch
```

### 4.2 버전 올리기

아래 5개 파일의 버전 문자열을 맞춘다(PATCH: 버그 수정/UX 폴리시, MINOR: 새 기능):

- `pyproject.toml` (`version = "..."`)
- `src/sooljang/__init__.py` (`__version__ = "..."`)
- `web/package.json` (`"version": "..."`)
- `web/package-lock.json` — **루트 패키지 항목 2곳만**(3번째 줄, 9번째 줄). 의존성
  패키지 중에도 우연히 같은 버전 문자열(예: `1.1.4`)을 가진 게 있을 수 있어, 전체
  치환이 아니라 정확히 그 두 줄만 바꾼다
- `uv.lock` — 직접 손대지 말고 `uv lock` 을 실행해 재생성한다(체크섬이 맞아야 한다)

다 맞췄으면 로컬에서 `bash scripts/check_version_consistency.sh` 로 세 파일이 서로
일치하는지 확인한다 — `release.yml` 이 태그와의 일치를, `quality.yml` 의
`version-consistency` 잡이 PR 단위 드리프트를 각각 검증한다(스크립트는 `pyproject.toml`·
`__init__.py`·`package.json` 만 보며, lockfile 은 `uv sync --frozen`/`npm ci` 가 강제한다).

이것도 브랜치 → PR → CI → 머지.

### 4.3 백업 → 태그 push

```bash
SOOLJANG_DOCKER_SG=1 bash scripts/backup.sh

SOOLJANG_ALLOW_TAG_PUSH=1 git tag v1.x.x
SOOLJANG_ALLOW_TAG_PUSH=1 git push origin v1.x.x
```

태그를 push 하면 `.github/workflows/release.yml` 이 자동으로 돈다: 전체 테스트 →
컨테이너 이미지 빌드 → GHCR 게시 → GitHub 릴리스 생성. 몇 분 걸린다.

```bash
gh run list --repo jihoon22-lee/SoolJang --workflow=release.yml --limit 1
gh run watch <run id> --repo jihoon22-lee/SoolJang --exit-status
```

### 4.4 재배포

```bash
# GHCR 인증이 만료됐으면(오래간만에 배포할 때 자주 그렇다) 다시 로그인
gh auth token | docker login ghcr.io -u jihoon22-lee --password-stdin

# .env 의 SOOLJANG_VERSION 을 새 버전으로 수정한 뒤
/usr/bin/sg docker -c "docker compose pull"
/usr/bin/sg docker -c "docker compose up -d"
```

`gh auth refresh` 로 `gh` CLI 토큰 스코프를 늘려도 Docker 데몬의 `ghcr.io` 로그인은
자동으로 안 바뀐다 — 별개의 자격 증명이다. 매번 `docker login` 이 필요한 건 아니고,
`denied` 로 pull 이 실패할 때만 다시 하면 된다.

`db` 서비스는 이미지가 안 바뀌므로 재시작되지 않는다(데이터 위험 없음) — `api`/`web`
만 새 이미지로 교체된다.

### 4.5 스키마 변경(새 Alembic 마이그레이션)이 있었다면 — 절대 빼먹으면 안 되는 단계

```bash
/usr/bin/sg docker -c "docker compose exec api alembic upgrade head"
```

`docker compose up -d` 만으로는 마이그레이션이 자동 적용되지 **않는다** —
`docker/api.Dockerfile` 의 시작 명령이 `uvicorn` 만 바로 실행하고 `alembic upgrade` 를
부르는 단계가 없다. 새 테이블/컬럼이 없어도 컨테이너 자체는 healthy 로 뜨기 때문에,
그 스키마를 실제로 쓰는 요청이 오기 전까지 증상이 안 보인다 — 반드시 헬스체크의
`migration_revision` 이 방금 만든 리비전 id 와 일치하는지 확인한다(아래 4.6).

새 마이그레이션이 없는 릴리스(버그 수정만 있는 경우 등)면 이 단계는 생략한다.

### 4.6 검증

```bash
curl http://127.0.0.1:8000/api/v1/health
# {"status":"ok","version":"1.x.x","database_connected":true,"migration_revision":"..."}

/usr/bin/sg docker -c "docker compose ps"   # 3개 컨테이너 다 healthy 인지
```

## 5. 자주 겪는 문제

| 증상 | 원인/대응 |
|---|---|
| `permission denied ... docker.sock` | 이 셸에 `docker` 그룹이 반영 안 됨 — 새 셸을 열거나 `/usr/bin/sg docker -c "..."` 로 감싼다(절대 경로 필수, §2 참조) |
| `docker pull ghcr.io/...` 가 `denied` | `gh auth refresh` 로 스코프를 늘려도 Docker 쪽엔 자동 반영 안 됨 — `gh auth token \| docker login ghcr.io -u <계정> --password-stdin` 으로 재로그인 |
| 배포 후 특정 기능만 500 에러 | 새 마이그레이션이 자동 적용 안 됐을 가능성 — §4.5·4.6 확인 |
| 로컬에서 `make api`/`make web` 실행이 이상함 | `.env` 의 `SOOLJANG_DATABASE_URL`/`SOOLJANG_API_PORT` 가 운영 값(도커 `db`/`8000`)을 가리키고 있지 않은지 확인 — §2 의 격리된 값으로 덮어써서 실행한다 |
| 헤더의 계정 이름이 이상하게 보임 | 버그 아님 — 그 자리는 환경 표시가 아니라 **현재 로그인된 계정의 표시 이름**이다(`app.tsx`). "설정 → 프로필"에서 바꾼다 |

## 6. GitHub 저장소 설정

- 저장소는 **public** 이다(2026-08-09 전환 확인). 협업자는 소유자 계정 하나뿐이라 남이
  `main`에 push/머지할 방법이 원래도 없었지만, `main-protection` ruleset 으로 명시적으로
  강제한다 — PR 필수, 승인 개수 요건은 없음(솔로 메인테이너는 자기 PR을 스스로 승인할 수
  없어서), 대신 쓰기 권한(=소유자만) 으로 실질 통제한다. 본인도 예외 없이 우회 불가.
- Secret scanning + push protection, CodeQL(Default setup) 활성화됨.
- 변경하려면 `https://github.com/jihoon22-lee/SoolJang/settings` → `Rules`/`Code security`.
