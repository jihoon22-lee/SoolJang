#!/usr/bin/env bash
# 배포 버전을 세 곳(pyproject.toml · src/sooljang/__init__.py · web/package.json)에서
# 일관되게 관리하는지 검증한다.
#
#   bash scripts/check_version_consistency.sh          # 세 파일 상호 일치 확인 (PR 마다)
#   bash scripts/check_version_consistency.sh 1.1.7    # 태그 버전과 일치하는지 확인 (릴리스)
#
# lockfile(uv.lock · web/package-lock.json)은 여기서 검증하지 않는다 — `uv sync --frozen`
# 과 `npm ci` 가 pyproject.toml·package.json 과의 불일치를 이미 거부하기 때문이다.
#
# Python 3.11+ 표준 라이브러리(tomllib·json)만 쓴다. CI 러너와 로컬 어디서든 추가
# 의존성 없이 동일하게 동작해야 한다.

set -uo pipefail

repository_root="$(git rev-parse --show-toplevel)"
cd "$repository_root" || exit 2

expected="${1:-}"

py_version="$(python3 -c 'import tomllib; print(tomllib.load(open("pyproject.toml", "rb"))["project"]["version"])')"
init_version="$(sed -n 's/^__version__ = "\(.*\)"$/\1/p' src/sooljang/__init__.py)"
pkg_version="$(python3 -c 'import json; print(json.load(open("web/package.json"))["version"])')"

failures=0

check() {
    local name="$1" value="$2"
    if [[ "$value" != "$py_version" ]]; then
        echo "  [$name] $value != pyproject.toml 의 $py_version" >&2
        failures=$((failures + 1))
    fi
}

if [[ -z "$init_version" ]]; then
    echo "  [src/sooljang/__init__.py] __version__ 를 찾을 수 없습니다" >&2
    failures=$((failures + 1))
else
    check "src/sooljang/__init__.py" "$init_version"
fi

check "web/package.json" "$pkg_version"

if [[ -n "$expected" ]]; then
    if [[ "$py_version" != "$expected" ]]; then
        echo "  [pyproject.toml] $py_version != 태그 $expected" >&2
        failures=$((failures + 1))
    fi
fi

if (( failures > 0 )); then
    echo "버전 불일치: ${failures}건" >&2
    exit 1
fi

echo "버전 일치: $py_version"
