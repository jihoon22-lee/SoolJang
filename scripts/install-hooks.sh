#!/usr/bin/env bash
# 저장소에 커밋된 git 훅을 활성화한다. 클론 직후 한 번 실행한다.
#
#   bash scripts/install-hooks.sh

set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
cd "$repository_root"

chmod +x .githooks/* scripts/*.sh
git config core.hooksPath .githooks

echo "git 훅을 활성화했습니다 (core.hooksPath=.githooks)"
echo "  commit-msg : Conventional Commits 형식 검증"
echo "  pre-push   : main 직접 푸시와 버전 태그 푸시 차단"
