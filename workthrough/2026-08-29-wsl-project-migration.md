# Workthrough: WSL-native project migration

**Date:** 2026-08-29

## Summary

SoolJang을 `origin/main`에서 `/home/jihoon/projects/SoolJang`으로 새로 clone하고, Git이
관리하지 않는 환경 파일과 local stash를 보존했다. 운영 PostgreSQL과 upload는 repository
directory가 아니라 기존 Docker named volume을 계속 사용한다.

## Changes

### 1. Source and local Git state

- source와 target initial HEAD는 `a629132f350c14d92d1f7bebf6596d399b70f47c`으로 일치한다.
- `.env`는 값을 출력하지 않고 byte-for-byte 복사했으며 target mode는 `0600`이다.
- 기존 stash 1개(`e880a30215d3984ab01c91adca99b07e84ccac39`)와 reflog entry를 target에 복원했다.
- `.githooks`를 계속 쓰도록 local `core.hooksPath`와 `core.autocrlf=false`를 보존했다.
- `.venv`, root/Web `node_modules`와 검사 cache는 target lockfile에서 재생성한다.

### 2. Runtime and documentation

- Compose project name `sooljang`이 같으므로 `pgdata`와 `uploads` named volume identity는
  유지된다. 새 source path에서 `docker compose up -d`가 기존 container를 재생성한다.
- `docs/handoff.md`와 이 plan의 현재 재개 경로를 WSL-native target으로 갱신했다.
- `docs/archive/`의 과거 실행 경로는 historical evidence이므로 소급 수정하지 않았다.

## Testing

- source/target HEAD, `.env`, stash object와 Git config 비교: PASS
- source와 target worktree clean: PASS
- target filesystem 확인: ext4
- `uv sync --frozen`, `npm ci --prefix web`: PASS
- `uv run ruff check .`, `uv run ruff format --check .`, `uv run ty check`: PASS
- Web check/test/coverage/build: PASS(41 files, 514 tests)
- secret scan: PASS
- Python DB integration suite는 PostgreSQL을 유지보수 목적으로 정지한 상태에서 연결 거부가
  확인되어 중단했다. 기존 named volume을 새 source path에서 복구한 뒤 전체 suite를 재실행한다.

## Files Modified

- `docs/handoff.md` — 현재 local repository와 재개 경로
- `docs/plan.md` — 현재 위치·재개 명령·D194 이관 결정
- `workthrough/2026-08-29-wsl-project-migration.md` — 이관 경계와 검증 기록

## Notes

- `.env`와 stash는 commit하지 않는다. stash는 apply하지 않아 worktree를 clean하게 유지한다.
- 원본 프로젝트, Docker volume과 WSL VHD backup은 target runtime 검증 및 사용자 승인 전까지
  삭제하지 않는다.
