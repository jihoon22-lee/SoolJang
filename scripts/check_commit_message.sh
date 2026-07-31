#!/usr/bin/env bash
# Conventional Commits 형식을 검증한다. git 훅과 CI가 같은 스크립트를 공유해
# 로컬과 CI의 판정이 어긋나지 않게 한다.
#
#   scripts/check_commit_message.sh --file .git/COMMIT_EDITMSG
#   scripts/check_commit_message.sh "feat(api): 제품 목록 엔드포인트 추가"

set -euo pipefail

if [[ "${1:-}" == "--file" ]]; then
    if [[ -z "${2:-}" ]]; then
        echo "Usage: $0 --file <commit-message-file> | <commit-subject>" >&2
        exit 2
    fi
    IFS= read -r subject < "$2"
else
    subject="$*"
fi

# 머지 커밋은 GitHub 이 생성하므로 규칙 대상에서 제외한다.
if [[ "$subject" =~ ^Merge[[:space:]] ]]; then
    exit 0
fi

pattern='^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9][a-z0-9._/-]*\))?(!)?:[[:space:]][^[:space:]].*$'

if [[ ! "$subject" =~ $pattern ]]; then
    echo "Invalid commit subject: $subject" >&2
    echo "Expected Conventional Commits format: type(scope): subject" >&2
    echo "Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert" >&2
    exit 1
fi

if (( ${#subject} > 100 )); then
    echo "Commit subject must not exceed 100 characters (${#subject} given)." >&2
    exit 1
fi
