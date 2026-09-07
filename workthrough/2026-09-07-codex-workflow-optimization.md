# v1.7.0 착수 전 Codex 지침·스킬 정비

- 기준: main `5589ae475748944cee80e1a2b3e9e5fcb6a94b74`, 2026-09-07.
- 브랜치: `feature/codex-workflow-optimization`.
- 관련: [#117](https://github.com/jihoon22-lee/SoolJang/issues/117),
  [#118](https://github.com/jihoon22-lee/SoolJang/issues/118) R24,
  [WP01 #119](https://github.com/jihoon22-lee/SoolJang/issues/119)의 지침 정합성 항목.
- 사용자가 기능 착수 전 별도 준비 적용을 요청했다. WP01/B01 전체 수용과 구분한다.

## 문제와 변경

기존 지침의 Task=PR 1:1·0.x/최초 릴리스·환경변수 전용 비밀 규칙과 오래된 재개 안내가
이미 출시된 앱 및 v1.7.0 계획과 충돌했다. 공통 AGENTS, 백엔드/웹 AGENTS, 작업 착수·
검증·외부 소스 스킬 3개로 역할을 나누고 현재 마일스톤과 필요한 자료만 읽도록 연결했다.

`docs/plan.md`는 현재 위치·결정·Task/WP 연결을, `docs/roadmap/v1.7.0.md`는 GitHub
계획의 진입점을 제공한다. 기존 Task 이력은 보존했다. 상세 검증 명령은
`docs/development.md`로 모으고 README·handoff·PR 템플릿을 맞췄다. 중복 절대 규칙은
AGENTS를 참조하도록 바꾸고 운영 중지·운영 비밀번호 재사용·양쪽 DB migration 안내를 정정했다.

`make install`은 `uv sync --frozen`으로 lockfile을 보존한다. 그 외 Make 변경은 도움말과
주석이며 `make check`/migration 왕복의 실제 범위와 Compose의 운영 영향을 명시했다.
앱 코드·스키마·CI gate·버전·운영 자격증명과 개인 Codex 설정은 변경하지 않았다.
사용자 컨텍스트 윈도우/자동 압축 한계는 기존 값이 유지됨을 값 두 항목만 읽어 확인했다.

## 실제 검증

환경: WSL 로컬 작업 트리, 기존 uv/npm lockfile. 아래 로컬 결과는 기준 SHA 위의 이 PR
미커밋 변경에서 얻었다. 앱/패키지 입력은 기준 SHA와 동일하고 새 CI 결과는 PR checks에서 확인한다.

| 검사 | 결과 |
|---|---|
| `uv run --frozen ruff check .` / `ruff format --check .` | 통과, Python 190파일 포맷 일치 |
| `uv run --frozen ty check` | 통과 |
| `npm --prefix web run check` | lint·typecheck·Vitest 41파일/514테스트·build 통과, branch 82.70% |
| 공식 `skill-creator/scripts/quick_validate.py` × 3 | 세 스킬 모두 통과 |
| `uv sync --frozen`, `make -n install`, `make help` | 성공, lockfile 유지와 안내 확인 |
| 독립 Alembic 문서 예시 | Python 문법 검사만 수행, DB 명령은 미실행 |
| 독립 읽기 전용 검토 | 호출/비호출 범위·운영 경계·링크 검토 후 지적 반영 |
| 변경 Markdown 로컬 링크 / `git diff --cached --check` | 68개 링크 누락 0, 공백 오류 없음 |
| `bash scripts/scan-secrets.sh` / `check_version_consistency.sh` | 통과, 패키지 버전 `1.6.1` 유지 |

웹 build의 기존 500 kB 초과 chunk 경고는 남아 있다. 문서·지침 변경이라 새 코드 행위
테스트는 추가하지 않았다. 로컬 개발 DB가 정지 상태임을 확인했고 이 작업을 위해 기동하지
않았다. 전체 pytest·migration·실연결·실브라우저·운영 복구/배포는 로컬에서 미실행이다.
필수 CI와 커버리지 기준은 그대로 유지한다.

## 후속 확인

실제 스킬 자동 선택률이나 시간/토큰 개선은 측정하지 않았다. B01에서 질문 반복·검증 중복·
명령 오선택·수용 누락을 관찰해 필요한 부분만 조정한다. 소스 조사·평가셋·최소 계약·외부 요청
보안 구현은 다음 B01 작업이며, 이번 PR에서 #117/#118/#119 또는 마일스톤을 닫지 않는다.
