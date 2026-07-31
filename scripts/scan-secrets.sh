#!/usr/bin/env bash
# 추적 대상 파일에서 시크릿과 개인 데이터를 스캔한다.
#
# 이 프로젝트의 위험은 두 가지다.
#   1. 자격증명 유출 (API 키, 세션 시크릿, 개인키)
#   2. 개인 음주·구매 기록 유출 (민감 정보로 취급한다)
#
# 외부 스캐너에 의존하지 않고 프로젝트 고유 위험에 초점을 맞춘다. 필요하면
# 나중에 gitleaks 등으로 교체·병행할 수 있다.
#
#   bash scripts/scan-secrets.sh

set -uo pipefail

repository_root="$(git rev-parse --show-toplevel)"
cd "$repository_root" || exit 2

failures=0

report() {
    printf '  [%s] %s\n' "$1" "$2" >&2
    failures=$((failures + 1))
}

# --- 1. 커밋되면 안 되는 파일 ------------------------------------------------
forbidden_paths=(
    'alcohol.csv'
    'alcohol.xlsx'
    '.env'
    '*.pem'
    '*.p12'
    '*.pfx'
    'id_rsa'
    'id_ed25519'
    '*.dump'
    '*.sql.gz'
)
for pattern in "${forbidden_paths[@]}"; do
    while IFS= read -r path; do
        [[ -z "$path" ]] && continue
        [[ "$path" == ".env.example" ]] && continue
        report "금지된 파일" "$path"
    done < <(git ls-files -- "$pattern" ":(glob)**/$pattern" 2>/dev/null)
done

# --- 2. 시크릿 값 패턴 -------------------------------------------------------
# 검사 대상은 텍스트 소스만으로 제한한다. 문서의 예시 표기는 제외한다.
mapfile -t tracked < <(git ls-files -- \
    '*.py' '*.ts' '*.tsx' '*.js' '*.mjs' '*.json' '*.yml' '*.yaml' '*.toml' '*.sh' '*.env.example')

declare -A patterns=(
    ["OpenAI API key"]='sk-[A-Za-z0-9_-]{20,}'
    ["Anthropic API key"]='sk-ant-[A-Za-z0-9_-]{20,}'
    ["Google API key"]='AIza[A-Za-z0-9_-]{30,}'
    ["GitHub token"]='gh[pousr]_[A-Za-z0-9]{30,}'
    ["AWS access key"]='AKIA[0-9A-Z]{16}'
    ["Slack token"]='xox[baprs]-[A-Za-z0-9-]{10,}'
    ["private key block"]='-----BEGIN [A-Z ]*PRIVATE KEY-----'
    ["hardcoded password assignment"]='(password|passwd|secret|token|api_key)[[:space:]]*[:=][[:space:]]*"[^"$\{][^"]{7,}"'
)

if (( ${#tracked[@]} > 0 )); then
    for name in "${!patterns[@]}"; do
        while IFS= read -r hit; do
            [[ -z "$hit" ]] && continue
            # 테스트·예시용으로 명시된 줄은 통과시킨다.
            [[ "$hit" == *"scan-secrets-allow"* ]] && continue
            report "$name" "$hit"
        done < <(grep -nEI "${patterns[$name]}" "${tracked[@]}" 2>/dev/null)
    done
fi

# --- 3. 결과 ----------------------------------------------------------------
if (( failures > 0 )); then
    echo "시크릿 스캔 실패: ${failures}건" >&2
    exit 1
fi

echo "시크릿 스캔 통과"
