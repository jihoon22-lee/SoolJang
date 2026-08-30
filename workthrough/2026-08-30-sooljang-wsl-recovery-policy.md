# SoolJang WSL 자동 복구를 no-recreate로 전환

## Overview

Windows 로그온 뒤 실행되는 WSL recovery에서 SoolJang을 FamilyCard와 같은 안전 정책으로
통일했다. 자동 복구는 기존 컨테이너를 시작하고 health만 기다리며, Compose·image·`.env`
변경 반영은 SoolJang의 정식 배포 절차에만 맡긴다.

실제 실행 로직은 로컬 Git 저장소 `/mnt/e/recovery`에 있고, 이 저장소에는 운영 계약과
결정 근거를 기록했다.

## Context

- 기존 SoolJang 단계는 `docker compose up -d --wait`로 설정 차이가 있으면 부팅 중
  컨테이너를 교체할 수 있었다.
- SoolJang의 새 image 배포는 필요 시 Alembic migration을 별도로 수행해야 한다.
- 따라서 자동 부팅에서 일어난 컨테이너 교체는 migration 없는 암묵적 배포가 될 수 있다.
- FamilyCard 자동 복구를 구현하며 plain `compose up`의 재생성 가능성을 실제로 확인했고,
  그 프로젝트에는 이미 `--no-recreate` 정책을 적용했다.

## Changes Made

### Recovery source

- `/mnt/e/recovery/wsl-service-recovery.sh`
  - SoolJang과 FamilyCard가 공통 `start_compose_project()` helper를 사용한다.
  - 프로젝트 디렉터리와 `.env`를 먼저 확인한다.
  - 두 프로젝트 모두 `docker compose up -d --no-recreate --wait --wait-timeout 120`을 쓴다.
- `/mnt/e/recovery/tests/verify.sh`
  - 공통 helper와 두 프로젝트 wrapper·run step을 정적 검증한다.
- `/mnt/e/recovery/README.md`
  - 자동 복구와 배포의 경계를 두 프로젝트에 동일하게 설명한다.

### SoolJang documentation

- `docs/operations.md`
  - Windows 로그온→WSL→systemd recovery 경로와 상태 확인 명령을 추가했다.
- `docs/plan.md`
  - 현재 위치와 잔여 cold-start 확인을 갱신했다.
  - no-recreate 결정을 D195로 기록했다.

## Code Example

```bash
docker compose up -d --no-recreate --wait --wait-timeout 120
```

`--no-recreate`는 기존 컨테이너를 설정 차이만으로 교체하지 않는다. 새 release 적용은
`docs/operations.md` §4.3~4.6의 backup, pull, migration, health verification을 따른다.

## Verification Results

### Recovery source

```text
bash tests/verify.sh: PASS
shellcheck install-wsl-service-recovery.sh wsl-service-recovery.sh tests/verify.sh: PASS
git diff --check: PASS
```

기능 브랜치 `fix/sooljang-no-recreate`를 로컬 `main`에 merge commit으로 합치고 로컬 bare
`origin`에 push했다. 설치본 `/usr/local/sbin/devbox-wsl-service-recovery`도 병합본과
byte-identical하게 반영했으며, recovery unit과 WSL은 재시작하지 않았다.

### Live runtime

```text
SoolJang containers preserved: yes
SoolJang mounts preserved: yes
db/api/web: running, healthy
GET /api/v1/health: status=ok, database_connected=true
GET /: 200
```

DB·API·web container ID와 시작 시각, `sooljang_pgdata`와 upload volume mount가 명령 전후
같았다. 실제 음주 기록·계정·업로드 내용은 조회하지 않았다.

FamilyCard도 같은 명령으로 다시 확인해 DB·web container identity와 원문 행 수 2→2,
두 health를 모두 보존했다. 실제 알림 원문은 조회하지 않았다.

## Next Step

다음 자연스러운 Windows 로그온/WSL cold start에서 recovery log의 SoolJang 성공 행과
세 컨테이너 health를 한 번 확인한다. 이 검증만을 위해 실행 중인 WSL을 강제로 종료하지
않는다.
