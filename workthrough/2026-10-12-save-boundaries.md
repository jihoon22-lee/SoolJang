# 저장 완료 경계 결함 수정 실행 기록

## 범위와 기준

- 사용자 승인: 두 결함 수정·회귀·lint/type/build·실브라우저·커밋·push·draft PR·독립 코드/보안 리뷰·ready·병합.
- 기준 `fbbfd579` (main, PR #171 이후), 브랜치 `feature/save-boundaries`.
- 요구사항 Q02/Q06, QS03/QS05/QS13/QS17/QS18/QS19. 원 리뷰는 docs/plan.md §2에 연결.
- Main PC Ubuntu WSL의 독립 worktree `/home/jihoon/projects/SoolJang-save-boundaries`에서 실행.
- 운영 설치·실제 기록·Chrome 사용자 프로필·다른 AgentBrowser 작업 폴더를 변경하지 않음.
- 패키지 1.10.1/schema0021 유지. 새 버전·태그·릴리스·배포는 미실행.

## 재현과 변경

1. BottlePanel은 성공한 초안을 삭제한 직후 draft setter로 빈 폼 전체를 다시 저장했다.
   이때 제출한 과거 날짜가 남았다. 새 테스트에서 기대 2026-10-12, 실제 2026-10-10으로 실패했다.
   성공 후에는 초안을 저장하지 않는 상태 setter로 오늘 날짜의 빈 폼을 만든다.
   제출 기록의 원래 날짜, 장소·동석자 재사용, 작성 중/실패 초안의 날짜를 보존한다.
   다음 날 remount에서 localStorage 복원을 거쳐 오늘 날짜를 쓰는 것도 검증한다.
2. DiscoveryPanel은 응답 revision만 바꾸고 이전 prop의 reference_urls를 재사용했다.
   지연/실패 refetch 테스트 둘에서 두 번째 요청이 `[A,C]`로 B를 잃는 실패를 확인했다.
   마지막 성공 응답 전체를 편집 기준으로 보관하고, 그 목록·source_matches·revision으로 다음 요청을 구성한다.
   다른 작성자의 revision으로 자동 재기반하지 않아 동시 변경은 서버 충돌로 보호한다.

기존 형식의 초안은 사용자 입력과 자동 생성 빈 폼을 확실히 구분할 수 없어 임의로 폐기하지 않는다.
수정 이후 성공한 제출부터 새 기본값을 초안으로 재생성하지 않는다.

## 실행 검증

- 시음 수정 전: BottlePanel 53개 중 신규 1개 실패, 52개 통과.
- 수정 후: BottlePanel 53 + drafts 6 = 59개 통과. 기존 지연 성공/새 초안 보호 포함.
- 관심 수정 전: 12개 중 지연/실패 refetch 2개 실패. 수정 후 12개 통과.
- `uv run --frozen ruff check .`, `ruff format --check .` (334파일), `ty check`: 통과.
- `bash scripts/check_version_consistency.sh`: 1.10.1 일치. `bash scripts/scan-secrets.sh`: 통과.
- 전체 웹 회귀 `npm --prefix web run test:coverage`: 100파일/1,283개 통과, branch83.01% (기준80%).
- 최초 web check는 작성 중 테스트 fixture 타입 오류로 중단했고 수정 후 typecheck가 통과했다.
  브라우저 임시 harness의 lint 오류는 앱 코드와 구분하며 보조 파일 정리 후 재검사한다.
- 독립 코드/보안 리뷰: 현재 diff의 저장 snapshot·초안 세대·계정 경계·저장 중 편집 잠금 검토에서 차단 지적 없음.
- 최종 lint/build·브라우저·원격 CI: 아래에 최종 결과를 기록한다.

## 검증 한계

회귀 테스트는 jsdom·합성 데이터이며 운영 사용자의 실제 피해 조사가 아니다.
로컬 Python 전체 DB 테스트는 백엔드 동작 변경이 없어 재실행하지 않았다.
원격 CI의 DB/빌드 검사는 별도 실행 근거로 구분한다.
물리 모바일·운영 쓰기·새 SW 릴리스/배포는 이번 범위에서 실행하지 않았다.
