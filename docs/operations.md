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
| `SOOLJANG_VERSION` | `docker compose pull`/`up` 이 받아올 GHCR 이미지 태그. 릴리스마다 갱신한다(§4) | `1.6.0` | 아니오 (기본 `local`, 로컬 빌드 이미지를 쓴다는 뜻) |
| `SOOLJANG_SEARCH_API_KEY` | Task 18 원 사양의 "검색 API로 아무 주종이나 조회" 기능용. **이 기능 자체가 현재 범위 밖**(`adapter` 방식으로 대체됨, `docs/plan.md` 참조)이라 지금은 안 쓰인다 | — | 아니오 (미사용) |

**로그인 후 "설정" 화면에서 관리하는 값**(`.env` 에 넣지 않는다):
- LLM API 키(라벨 OCR용) — Task 17. 저장 즉시 `SOOLJANG_SECRET_KEY` 로 암호화돼 DB에
  저장되고, 화면에는 마스킹된 값만 다시 보인다(원문은 절대 재노출 안 됨 — write-only).
- 네이버 API HUB/기존 Developers, Brave, Exa 검색 키 — 통합 연결 화면. 등록·인증 확인·사용 활성화는 별도이며 키가 없어도 다른 선택한 연결의 탐색은 계속된다. Exa는 일반 fast 검색과 제한된 text만 사용하며 생성형 요약·highlights를 요청하지 않는다.
- 기존 외부 소스와 OCR/선택형 AI 설정은 이전 연결 ID 및 암호문을 보존한다. 빈 인증 입력은 유지, 명시적인 삭제만 자격증명을 제거한다. 새 탐색은 기존 AI 매칭 보조를 호출하지 않는다.
- 관심 저장은 구매·재고 합계를 늘리지 않는다. 검색 응답/원문은 장기 보관하지 않으며 가격 관측은 소스의 `price_history_allowed`가 켜진 경우만 저장한다. 자료 취득·표시·보관 조건을 확인한 뒤 설정한다.
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

## 3. 백업과 격리 복구

`scripts/backup.sh`는 `scripts/recovery.py`의 진입점이다. 새 백업은 DB 덤프와 uploads를
같은 디렉터리에 묶는다. **모든 쓰기를 중지한 뒤** 실행한다. 앱 정지 외에도 CLI·일괄 작업·
외부 DB 세션을 중지해야 한다. Compose 모드는 실행 중인 `api` 및 해당 DB의 다른 client
세션을 발견하면 거절한다. `--writes-stopped`는 다른 쓰기 경로도 중지했다는 운영자의 확인이다.
DB의 MVCC snapshot과 파일 복사는 별도이므로 한 OS 트랜잭션처럼 보장하지 않는다.

```bash
# 명시적인 배포/백업 창에서만 실행한다. 중지 전 health의 실제 앱 버전을 기록한다.
curl --fail http://127.0.0.1:8000/api/v1/health
# DB 컨테이너는 계속 실행한다.
/usr/bin/sg docker -c "docker compose stop api"
# uv가 .env를 읽어 자식 프로세스의 환경으로만 전달한다. source .env 또는 키 출력 금지.
SOOLJANG_DOCKER_SG=1 uv run --env-file .env bash scripts/backup.sh \
  --writes-stopped --app-version <실제_배포_버전>
SOOLJANG_DOCKER_SG=1 bash scripts/backup.sh --list
SOOLJANG_DOCKER_SG=1 uv run --env-file .env bash scripts/backup.sh --verify <백업_디렉터리>
```

백업만 수행한 경우에는 검증 후 `docker compose start api`로 기존 API 컨테이너를 재개하고
health를 확인한다. 스크립트는 서비스를 자동 시작하지 않는다.

백업은 기본 `$HOME/sooljang-backups`에 `.partial-*`로 생성하고 검증 후
`sooljang-<UTC 시각>-<식별자>`로 게시한다. 완료 디렉터리는 다음을 포함한다.

- `database.dump`: PostgreSQL custom dump.
- `uploads/`: 첨부파일 원본. symlink/특수파일은 거절한다.
- `manifest.json`: 형식·앱·스키마 버전, 원본 DB 이름, 획득 시작/완료 시각, 쓰기 중지 경계,
  테이블 행 수·첨부 참조, 파일 크기/SHA-256, DB 디스크 크기 및 암호화된 키 확인 문장.
  `app_version`은 운영자가 중지 전 확인한 배포 버전이며 `backup_tool_version`과 구분한다.
- `COMPLETE`: manifest SHA-256. **목차/체크섬 통과는 실제 복원 성공이 아니다.**

디렉터리 권한은 0700, 파일은 0600이다. 기본 보존 개수는 14이며
`SOOLJANG_BACKUP_KEEP` 또는 `--keep`로 1 이상을 지정한다. 검증된 완료 묶음만 개수에
포함하고 이전 `.dump`, 다른 이름, symlink, 손상·부분 묶음은 자동 삭제하지 않는다.
동시 백업은 파일 잠금으로 거절한다. 중단되면 성공 메시지를 출력하지 않으며 SIGKILL/전원
중단으로 남은 `.partial-*`는 완료 백업이 아니다. 자동 정리 대신 내용을 확인한 뒤 처리한다.
생성과 복원은 작업 공간의 여유 용량을, 복원은 DB 파일시스템의 용량도 사전 확인한다.
소스 크기 기반 추정과 여유분은 디스크 고갈을 완전히 예측하지 않으므로 실제 쓰기 오류 역시
비정상 종료하며, `pg_restore`는 `--exit-on-error --single-transaction`으로 실패 시 롤백한다.

### 3.1 키의 별도 복구 경로

`SOOLJANG_SECRET_KEY`는 일반 백업·export·manifest에 평문으로 넣지 않는다. 운영자는 기존
마스터 키를 접근이 제한된 암호화 비밀 보관소/암호화 복구 매체에 **별도로** 보관하고 복구
환경에만 주입한다. 이 스크립트는 키를 발급·변경하거나 비밀 보관소로 전송하지 않는다.
새 키로 대체하면 기존 DB 암호문을 복호화할 수 없다. 키가 없거나 다르면 작업을 중단하고,
복구 키 확인/사용자 재연결이 필요한 상태로 남긴다. 기존 암호문과 설정을 지우지 않는다.
복구 전 확인 문장과 복구 후 DB의 `*ciphertext` bytea 필드를 실제 복호화해 일치를 확인한다.
별도 비밀 보관소의 복구 가능성은 운영자가 확인해야 하며 백업 파일 존재만으로 충족되지 않는다.

### 3.2 빈 격리 대상에 실제 복원

활성 DB에 `--clean`으로 덮어쓰는 복원은 지원하지 않는다. 운영자가 **별도 빈 DB**를 준비하고
원본과 다른 DB 이름, 존재하지 않는 새 uploads 경로를 지정한다. 파일은 임시 위치에서
검증한 뒤 게시한다. DB와 파일 전환은 서로 다른 작업이다. DB 복원이 끝난 뒤 파일 게시나
대조가 실패할 수 있으며 그때도 성공으로 표시하지 않는다. 해당 격리 대상은 사용하지 않고
실패 원인을 확인한 뒤 새 빈 대상에 재시도한다. 운영 데이터/볼륨/컨테이너를 자동 전환하지 않는다.

```bash
# PGHOST/PGPORT/PGUSER/PGPASSFILE 및 SOOLJANG_SECRET_KEY는 격리 환경에만 주입한다.
# pg_dump/pg_restore/psql은 PATH 또는 SOOLJANG_PG_BIN에서 찾는다.
bash scripts/backup.sh --local --restore <백업_디렉터리> \
  --target-db <새_격리_DB> --uploads <존재하지_않는_새_경로>
```

`--local`은 DB 서버의 `data_directory`를 이 호스트에서 검사할 수 있는 로컬 PostgreSQL용이다.
원격 DB를 가리켜 파일시스템 확인이 불가능하면 복원을 중단한다. Compose 모드는 DB 컨테이너
안에서 디스크 공간을 확인한다.

복원 뒤 manifest의 전체 행 수·스키마·첨부 참조·파일 내용과 암호문 복호화를 대조한다.
FK 설치/검증도 `pg_restore` 트랜잭션에 포함된다. 그 다음 **격리 API**를 복원 DB와 uploads에
연결하고 로그인·제품/구매/병/시음 합계·대표 첨부 열람을 검증한 후 전환 여부를 결정한다.
신규 사용자 데이터가 생긴 뒤 이전 백업으로 돌아가면 그 이후 변경이 사라진다. 최신 데이터
백업 및 데이터 병합/이전 계획 없이 구 스키마로 downgrade하거나 이전 이미지로 되돌리지 않는다.

개발용 opt-in 실제 복구 검증은 `tests/scripts/test_recovery_live.py`다. 환경 변수
`SOOLJANG_RUN_RECOVERY_TESTS`, `SOOLJANG_RECOVERY_TEST_SOURCE`, `PGHOST`, `PGPORT`, `PGUSER`,
`SOOLJANG_PG_BIN`을 명시한다. source 이름은 `_recovery_test`로 끝나야 하며 source 스키마를
초기화하고 별도 `<source>_restored` DB를 생성·제거한다. 운영 DB나 공유 테스트 DB에 연결하지 않는다.
테스트는 합성 제품·구매·병·시음·PNG·암호화 설정을 생성하고 실제 dump/restore, 손상 데이터
복원 실패/트랜잭션 롤백, 복원 후 인증된 앱 조회·합계·파일 바이트를 확인한다.
Windows cold start와 운영 백업/이미지 전환은 이 격리 테스트에 포함되지 않는다.

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
# §3의 쓰기 중지·전체 백업과 격리 복구 결과를 확인한 뒤 태그를 게시한다.

SOOLJANG_ALLOW_TAG_PUSH=1 git tag v1.x.x
SOOLJANG_ALLOW_TAG_PUSH=1 git push origin v1.x.x
```

태그를 push 하면 `.github/workflows/release.yml` 이 자동으로 돈다: 전체 테스트 →
컨테이너 이미지 빌드 → GHCR 게시 → GitHub 릴리스 생성. 몇 분 걸린다.

```bash
gh run list --repo jihoon22-lee/SoolJang --workflow=release.yml --limit 1
gh run watch <run id> --repo jihoon22-lee/SoolJang --exit-status
```

### 4.4 이미지 준비와 쓰기 중지

릴리스 CI와 마일스톤 수용이 끝난 정확한 버전 태그/이미지 digest를 사용한다. 현재 컨테이너
ID·이미지 digest·앱/스키마 버전을 비밀 없이 기록하고 이전 이미지는 유지한다. `.env`의
`SOOLJANG_VERSION`을 목표 버전으로 맞춘 뒤 **api/web만** pull한다. 이 단계는 실행 중인
컨테이너나 DB를 바꾸지 않는다. GHCR 인증 실패일 때만 Docker 자격증명을 갱신한다.

```bash
# GHCR 인증이 실제 실패했을 때만 실행한다.
gh auth token | docker login ghcr.io -u jihoon22-lee --password-stdin
/usr/bin/sg docker -c "docker compose pull api web"
```

그 다음 §3에 따라 모든 쓰기를 중지하고 현재 DB+uploads를 백업한다. 복구 키·완료 묶음·
격리 복구 가능성을 확인할 수 없으면 migration과 이미지 전환을 진행하지 않는다.
배포 창이 길면 태그 게시 전 백업에만 의존하지 않고 실제 전환 직전 새 백업을 만든다.

### 4.5 migration → 서비스 전환

```bash
# 새 이미지의 migration만 일회성 실행. 기존 API는 정지 상태이며 DB는 교체하지 않는다.
/usr/bin/sg docker -c "docker compose run --rm --no-deps api alembic upgrade head"
# migration이 성공한 경우에만 새 API를 시작하고 readiness를 기다린다.
/usr/bin/sg docker -c "docker compose up -d --no-deps --wait --wait-timeout 120 api"
/usr/bin/sg docker -c "docker compose up -d --no-deps web"
```

`uvicorn` 시작은 migration을 자동 수행하지 않는다. migration 실패 시 다음 명령으로
넘어가지 않는다. PostgreSQL 트랜잭션 밖에서 실행되는 변경이 있으면 해당 migration의
별도 복구 절차가 필요하다. 이전 앱은 **그 앱에 포함된 schema head와 DB가 정확히 같은
경우에만** 재개한다. 현재는 구·미래·복수 불일치 리비전의 호환성을 가정하지 않는다.
새 데이터가 생기기 전 검증 실패도 DB+uploads를 격리 복원해 확인한 뒤 명시적으로 전환한다.
`docker compose down -v`, 운영 DB 테스트 초기화, 자동 downgrade는 복구 절차가 아니다.

### 4.6 생존·준비 상태와 실제 기능 검증

```bash
curl --fail http://127.0.0.1:8000/api/v1/health/live
curl --fail http://127.0.0.1:8000/api/v1/health/ready
/usr/bin/sg docker -c "docker compose ps"
```

`/health/live`는 DB에 접근하지 않고 프로세스 생존만 보고한다. `/health/ready`와 기존
`/health`는 DB 연결 및 **실제 전체 Alembic revision == 설치된 패키지의 head**일 때만
200/`schema_ready=true`를 반환한다. version 테이블 누락·구/미래 리비전·실패한 migration은
503이며 데이터나 키를 초기화하지 않는다. Docker의 기존 `/health` 검사도 이 계약을 따른다.

응답의 앱 버전·supported/actual revision을 목표 릴리스와 대조한다. 이어 실제 로그인,
제품·구매·병·시음 조회와 합계, 첨부·외부 설정 상태, 웹 입력/동기화의 담당 WP 시나리오를
검증한 후 쓰기를 재개한다. health 200만으로 마일스톤 수용·배포 완료를 선언하지 않는다.
관측한 SHA·이미지·스키마·기능 결과와 미실행 항목을 해당 workthrough에 기록한다.

### 4.7 Windows 로그온 뒤 WSL 자동 복구

이 홈 PC의 자동 복구 원본은 `E:\recovery`(`/mnt/e/recovery`)에 있고, Windows 작업
스케줄러가 로그온 시 WSL을 시작한 뒤 systemd recovery unit을 실행한다. SoolJang 단계는
다음 명령으로 기존 컨테이너를 시작하고 health만 기다린다.

```bash
docker compose up -d --no-recreate --wait --wait-timeout 120
```

이 경로는 **배포가 아니다**. `--no-recreate` 때문에 Compose·image·`.env`가 달라져도
기존 컨테이너를 자동으로 교체하지 않는다. 누락된 컨테이너 생성과 중지된 컨테이너 시작은
가능하지만, 새 릴리스 반영은 반드시 §4.3~4.6의 백업·pull·migration·검증 절차로 한다.

복구 상태는 다음처럼 확인한다.

```bash
systemctl status devbox-wsl-service-recovery.service
tail -40 /var/log/devbox-wsl-service-recovery.log
docker compose ps
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

## 6. 개발 감시와 운영 복구 검증 범위

WSL ext4 저장소에서는 기본 파일 감시를 쓴다. Windows 마운트에서 이벤트 누락이 실제로
확인됐을 때만 `SOOLJANG_WATCH_POLLING=1 npm --prefix web run dev`로 해당 프로세스의 polling을 선택한다. 저장소 전체에 polling을 강제하지 않는다.
기존 Vite/Vitest 워커·Docker init 설정은 유지하고 중복 worker 확장을 하지 않는다.
WSL 자동 복구는 §4.7의 `--no-recreate`·health 대기이며 이미지 pull·migration을 넣지 않는다.
이 명령 구성 검토와 Windows 로그온/cold start 실기 확인은 별도 증거다. 실기 확인을 하지
않았으면 미실행으로 남기며 운영 컨테이너 ID·volume 보존까지 확인한 뒤 완료 처리한다.


## 7. v1.7.0 운영 확인 (2026-09-07)

API/web1.7.0·schema0018·release SHA `f1c5bbc`를 대조하고 백업/실복원과 HTTPS 앱을
확인했다. [실행 기록](../workthrough/2026-09-07-v170-release.md)을 따른다. 실제 환경 파일은
Windows 계정별 DPAPI로 별도 암호화해 `E:\SoolJangPrivateRecovery`에 보관하고 복호화 대조를
확인했다. 파일 ACL은 해당 사용자와 SYSTEM이며 일반 DB 백업에 평문 비밀을 포함하지 않는다.
복호화에는 해당 Windows 계정의 DPAPI 프로필이 필요하다. Windows 사용자 프로필까지 잃은
경우의 복구를 보장하는 별도 암호화 매체는 아니므로 기존 계정 복구 수단을 함께 보존한다.

Exa는 앱에서 암호화 등록·검증·사용 상태를 확인했다. 초기 한도는 분6회·UTC 하루20회이며
설정에서 사용자가 조정할 수 있다. 기존 OCR와 사용자 설정은 유지했다. 실제 국내 가격 출처
확대는 #142, 실제 기기 푸시 수용은 #143의 승인 후속이며 자동 활성화하지 않는다.

## 8. v1.7.1 가격·빈티지 패치

v1.7.1은 구매 가격 공란을 0원으로 해석하고 등록 빈티지·관측 근거를 보존한다.
DB schema는0018을 유지하며 기존 구매/병/키/설정의 원본을 일괄 수정하지 않는다.
백업과 기존1.7.0 이미지를 유지하고 API/web만1.7.1로 전환한다. 직전 백업·격리 복원,
이미지 version/revision과 readiness, 인증 조회·HTTPS 화면을 대조한다.

기존 NULL 구매가도 제품/통계/오프라인 화면에서 0원으로 계산한다. 가격 공란을
데이터 품질의 미상 가격이나 수정 대상으로 집계하지 않는다. 별도로 등록한 빈티지를
상품명의 연도보다 우선하며, 새 외부 관측에는 상세 빈티지·도수·숙성·생산자 근거를 보존한다.
이미 저장되지 않았던 외부 관측의 상세 필드를 임의로 만들어 채우지는 않는다.

[변경·검증 기록](../workthrough/2026-09-07-v171-price-vintage.md) ·
[실제 배포 결과](https://github.com/jihoon22-lee/SoolJang/releases/tag/v1.7.1).
동일 PR에서 준비한 코드·문서 이후의 배포 실행 증거는 해당 릴리스 노트에 기록한다.
