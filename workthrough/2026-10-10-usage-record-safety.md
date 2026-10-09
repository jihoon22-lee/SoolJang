# 실사용 흐름 WP01 — 기록 보호·조건부 실행 취소

- 기준 main `d47bbf7`, `feature/usage-record-safety`의 이 기록을 포함한 코드 변경.
  로컬 검증 시 미커밋 상태였으며 R07/R08, S09/S10 및 S11/S18의 부분 범위다.
- 병 revision과 서버 receipt 기반 취소를 도입했다. 이후 같은 병에 시음·잔량·상태 변경이
  있으면 취소를 거부한다. 다른 병의 변경은 허용하고, 일괄 결과는 적용/거부 수로 알린다.
- 상세/빠른 시음·구매 수정은 제출한 입력·대상·초안 버전을 고정한다. 실패 시 입력을
  보존하며 이전 성공 응답은 새 초안을 지우지 않는다. 실패 명령 재시도 시 동일 병의
  후속 의존 참조도 같은 IndexedDB transaction에서 갱신한다.
- 데이터: `0020_bottle_revision`이 UUID revision을 추가한다. 기존 병·구매·시음 ID는
  보존한다. 기존 PWA의 조건 없는 역전이는 안전하게 실패시키며 원본 명령은 남긴다.
  사용자 소유권·receipt 소유권을 검사하며 IndexedDB schema 변경은 없다.

## 실제 검증

- 격리 PostgreSQL 54329의 `sooljang_test`에서 `.venv/bin/pytest -q`:
  **1,425 passed, 30 opt-in skipped, coverage 91.80%**. 환경 파일 자동 로딩을 끄고
  `SOOLJANG_ENVIRONMENT=test`와 격리 `SOOLJANG_DATABASE_URL`을 명시했다.
- 취소·시음·동기화 집중 회귀 81개 통과. 누락/타인/오래된 receipt, 후속 시음,
  ABA 상태 변경, 동일 트랜잭션 revision과 구버전 요청 거부를 포함한다.
- `npm --prefix web run check`: **784 passed, branch 81.86%**, format/lint/typecheck/build 통과.
  지연 promise로 저장 중 입력·접기·중복 제출, 새 초안 보존을 검증했다.
  마지막 제품 ID 경계 remount 보완 후 TypeScript·프로덕션 빌드도 통과했다.
- `.venv/bin/ruff check .`, `.venv/bin/ruff format --check .`, `.venv/bin/ty check`,
  `bash scripts/scan-secrets.sh`: 통과.
- 별도 합성 DB `sooljang_usage_migrate_20261010`: 0019의 사용자·제품·SKU·구매·병·시음을
  준비해 0020 upgrade 후 기존 값/ID 보존, 서로 다른 non-null UUID를 확인했다.
  재실행 시 revision 유지, downgrade base→upgrade head, `alembic check/current` 통과.
- Chromium 실제 UI, API 8212/웹 5176, 전용 합성 DB에서 아래 다섯 흐름 통과.
  제품·700ml SKU·2병 구매를 UI로 생성했고 확인은 화면·IndexedDB·인증 GET을 대조했다.

| 흐름 | 관찰 결과 |
|---|---|
| 초기 설정→제품·규격·구매 등록 | 같은 제품/SKU/구매 아래 2병 생성 |
| 개봉→30ml 시음→최초 개봉 취소 | 취소 거부, 670ml·원래 병/시음 ID 유지 |
| 다른 병 개봉→취소 | 정상 취소, 첫 병 670ml 유지 |
| 상세·빠른 시음 초안 닫기/재열기 | 각각 17ml·23ml 복원 |
| 로드한 앱에서 오프라인 개봉·30ml 시음→재접속 | 원래 병/시음 ID로 670ml 반영, 페이지 오류 없음 |

```text
2026-10-09T16:19:35Z → 16:19:39Z (2026-10-10 KST)
Chromium: 5 flows passed, pageErrors=[]
stale undo: remainingMl=670; independent undo: secondStatus=unopened
drafts: detailRestoredMl=17, quickRestoredMl=23
offline reconnect: remainingMl=670, original IDs retained
```

합성 로그·스크린샷 원본은 로컬 `/tmp/sooljang-usage/wp01-browser-artifacts/`에 있다.
위 로그에는 실제 사용자 기록·자격증명을 포함하지 않았다. 테스트 스크립트의 초기 setup
경로와 합성 이메일 도메인 오류를 수정한 뒤 위 흐름을 실행했다.

## 범위와 미실행

지연 저장 보호는 Vitest 검증이며 실브라우저에 인위 지연을 주지는 않았다. 오프라인은
이미 로드한 앱 범위다(`serviceWorkerControlled=false`). 설치·cold start·SW 업데이트,
실기기·유료/외부 실연결·운영 복구/배포는 미실행이다. 전체 S01~S20 수용은 WP06에서
별도로 실행한다. 운영 버전·DB·키·실제 기록은 변경하지 않았다. [#162](https://github.com/jihoon22-lee/SoolJang/pull/162)의 [CI](https://github.com/jihoon22-lee/SoolJang/actions/runs/37958640737) 전체 통과 후 merge commit `c6d00c1`로 통합했다.
