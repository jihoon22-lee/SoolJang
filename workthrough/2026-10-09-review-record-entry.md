# 실사용 리뷰 PR 2 — 구매·시음 입력

- 기준: PR 1 `cedbf9d`, `feature/review-record-entry`, F4~F7.
- 수량 변경은 구매 행을 잠그고 삭제된 번호까지 포함해 새 번호를 배정한다. 기존 병·시음과
  삭제된 병을 보존한다. 첫 규격 생성 후 같은 구매 폼에서 저장할 수 있다.
- 빠른 시음은 사용자 선택대로 SKU별 기본 병 + 개별 병 변경이며 병별 초안을 보존한다.
- 스키마·버전·운영 변경 없음. 합성 데이터·격리 PostgreSQL 54329/Chromium 사용.

## 검증

- F4 관련 구매 회귀 35개 통과: 3→2→3→4, 시음·기존 병 ID 보존, 별도 로그인 두 기기의
  수량 변경 직렬화, 첫 PR 권한 회귀.
- 제품 상세 32개 통과: 첫 규격 생성 직후 구매 저장, 유효한 선택·병수 보존과 삭제된 선택 보정.
- 전체 pytest: 1,380 passed, 30 opt-in skipped, branch 포함 91.65%.
- `npm --prefix web run check`: 746 passed, branch 81.65%, lint·typecheck·PWA build 통과.
- Ruff check/format·ty·secret scan·diff check 통과.
- 실제 Chromium 390px, 개발 웹과 최종 PWA: 첫 규격 생성 직후 구매 3병 저장, API
  3→2→3→4 모두 200. 50/700ml 선택을 분리하고 같은700ml의 다른 구매처 병으로 변경,
  닫기·재열기·새로고침 후 향/양 복원, 선택한 병만700→670ml이고 다른 병은 미개봉 유지.

```text
FIRST_SKU_AND_RESIZE PASS: first purchase 3; quantity 3→2→3→4 all 200
SKU_GROUPS_2 DEFAULT_OLDEST SWITCH_PURCHASE CLOSE_RELOAD_DRAFT CORRECT_BOTTLE_670 PASS
```

저장 transaction을 지연시키는 회귀로 저장 중 닫기/Escape/입력 변경을 차단하는 것도 확인했다.
초안이 있는 대상 병으로 이동할 때 기존 초안을 자동 덮어쓰지 않는다. 검증 SHA는 이 기록을
포함한 PR 코드 커밋이다.

## 미실행

실제 기기·카메라·푸시·외부 서비스 실연결, 운영 복구·배포.
