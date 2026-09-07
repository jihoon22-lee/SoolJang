#!/usr/bin/env bash
# DB+uploads 복구 묶음. 모든 쓰기 중지 후 --writes-stopped를 지정한다.
# --verify는 무결성 검사, --restore는 명시한 빈 격리 DB와 새 uploads 경로에만 복원한다.
# 일반 백업에는 .env 또는 평문 마스터 키를 넣지 않는다. docs/operations.md §3 참조.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec uv run --frozen --project "${script_dir}/.." python "${script_dir}/recovery.py" "$@"
