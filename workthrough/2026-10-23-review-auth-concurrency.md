# F4 인증 전환과 활동 시각 갱신의 경합

- 요구사항: 리뷰 ⑥·⑦, QS03·QS17·QS19, D257. 2026-10-23 사용자 승인 범위.
- 코드 기준: `63dca1c`, F1 #182·F3 #183·F5 #184·F2 #185 통합.
- 데이터/권한: schema 0021·사용자 소유권·세션 만료/폐기·응답 전 commit 계약 유지.
  비밀이 아닌 인증 세대만 공유하며 계정별 Dexie·outbox·초안을 삭제하지 않는다.

## 변경

JSON·multipart 요청은 시작 및 응답 처리에서 인증 세대를 확인한다. 다른 탭의 전환 이벤트를
아직 처리하지 않았어도 새 쿠키로 이전 화면의 요청을 보내지 않는다. 로그인·로그아웃·현재 계정
조회와 offline bootstrap은 같은 cookie Web Lock을 사용하고, 로그인 시작부터 이전 화면과 DB를
잠근다. 새 문서·refocus도 확정 전 계정을 열지 않는다. 로그인 확정은 잠금 안에서 세대와 함께
반환하며, 늦은 성공/401·시작 계정 조회·이전 로그아웃 완료는 새 세션을 덮지 않는다.
로그아웃 중 새 로그인 제출을 막고 취소된 공개 setup 안내 조회는 다시 확인한다.

인증 조회는 Session ORM을 dirty로 만들지 않는다. CSRF 검증 후 필요한 활동 시각만 요청의
commit·close 뒤 별도 transaction에서 갱신한다. 5분 간격, connection 대기 포함 0.5초 제한,
SKIP LOCKED와 만료·폐기·소유자 재검사로 업무 결과에 영향을 주지 않는다. 관찰 시각은 뒤로
가지 않으며 인증 기한을 연장하지 않는다. 기존 세션 행 잠금이 우연히 막던 동시 비밀번호 변경은
User 행을 현재 암호 확인 전에 잠그고 다시 읽어, 같은 옛 암호의 두 요청이 모두 성공하지 않게 한다.

## 실행 증거

| 검사 | 결과 |
|---|---|
| 수정 전 재현 | 늦은401·logout pending, 같은 쿠키의 느린 요청 직렬화, 동시 비밀번호 변경, cookie lock handoff·시작 전환·새 문서·offline·공개 조회 취소 경계를 실패로 확인 |
| 서버 관련 | 인증·CSRF·만료·폐기·commit·실제 PostgreSQL 경합 67개 통과 |
| 서버 전체 | 1,804 통과·31 opt-in 제외, branch 포함 coverage 92.40% |
| 웹 집중 | authRace 23개를 포함한 인증·App 52개 통과 |
| 웹 전체 | 110파일·1,407개 통과. statements 89.53%·branches 83.53%·functions 86.51%·lines 91.41% |
| 정적·빌드 | Ruff·format·ty·웹 lint/typecheck/build·secret scan·diff-check 통과 |
| F1~F5 통합 경합 | 기록 보존·구매 축소·주종·활동 시각·sync 경합·입력 계약 83개 통과 |
| F1~F5 통합 웹 | 111파일·1,438개 통과. statements 89.50%·branches 83.69%·functions 86.60%·lines 91.38%, lint·typecheck·build 통과 |
| 복원본 조회 | 별도 복원 DB에서 기존 코드와 최종 통합 코드의 로그인·조회 44개씩 통과. 8종 API 결과 digest 일치, 임시 인증 정리 후 전체 테이블 hash 보존. 실제 첨부가 없어 원본 첨부 열람은 제외 |
| 독립 검토 | 서버는 루트, 웹은 별도 프런트 검토자가 읽기 전용 재검토. 발견한 교차탭 startup/refocus 경계를 보완한 뒤 추가 차단 결함 없음 |

서버 검사는 `PYTHONPATH=src SOOLJANG_ENV_FILE='' SOOLJANG_ENVIRONMENT=test` 및
`postgresql+psycopg://sooljang@127.0.0.1:54329/sooljang_review_f4_20261023_test`를 명시했다.
같은 쿠키의 느린 외부 호출은 mock으로 붙잡고 다른 읽기·쓰기·로그아웃이 먼저 끝나는지 실제 DB에서
확인했다. 단일 connection pool·잠긴 세션·기한·실패 격리·응답 전 commit도 포함한다.

전체 웹은 `npm --prefix web run lint`, `typecheck`, `test:coverage -- --maxWorkers=1`,
`build` 순서로 실행했다. 동시 full 실행의 timeout과 별도 SIGTERM143 중단은 통과로 계산하지
않았다. 단독 재실행은 기존 timeout/coverage 기준을 유지했다.

## 실제 브라우저

Chromium 151, 390×844, 합성 계정과 격리 API에서 실제 쿠키 로그인/로그아웃을 사용했다.
이전 JSON·multipart 요청의 401만 지연 주입했다. 새 로그인 뒤에도 현재 화면·Dexie 소유자·로컬
계정이 유지되고 서버 `/auth/me`는 200이었다. 실제 로그아웃 응답 대기 중에는 로그인 제출이 막혔다.

두 로그인 화면 중 한 탭을 먼저 로그인시킨 뒤 다른 탭의 실제 로그인 응답을 붙잡았다. 첫 탭은
로그인 화면과 잠긴 DB로 전환됐다. 그 사이 새 세 번째 탭을 열어 native Web Lock 대기를 확인했고,
쿠키 확정 전 `/auth/me` 전송과 이전 계정 화면 진입이 없었다. 두 번째 탭의 확정 계정은 서버와
Dexie가 일치했다. 실제 브라우저는 같은 계정의 새 세션이며, 다른 계정 조합은 자동화 회귀로 검증했다.

- [지연 응답 결과](assets/2026-10-23-review-auth-concurrency/f4-browser-results.json)
- [세 탭 전환 결과](assets/2026-10-23-review-auth-concurrency/f4-cross-tab-results.json)
- [로그아웃 대기 화면](assets/2026-10-23-review-auth-concurrency/f4-logout-pending-390.png)
- [새 세션 유지 화면](assets/2026-10-23-review-auth-concurrency/f4-new-session-390.png)
- [다른 탭의 잠금 화면](assets/2026-10-23-review-auth-concurrency/f4-other-tab-locked-390.png)

외부 실연결·운영 데이터 쓰기·실기기 PWA는 미실행이다. Web Locks 미지원 환경은 현재 탭의
대기열로 처리하며, 여기의 실제 다중 탭 수용은 Web Locks를 지원하는 Chromium 환경이다.

## PR CI와 최종 통합

- [PR #186 최초 Quality CI](https://github.com/jihoon22-lee/SoolJang/actions/runs/39944014886)는
  Python 1,854개 통과·31 opt-in 제외(coverage 92.53%), 웹 1,438개 통과(branch 83.66%)였다.
  migration 왕복·컨테이너 빌드·npm/pip 감사와 별도 CodeQL도 모두 통과했다.
- F2 #185의 확정 409 명시 중단 보완을 통합했다. 제품 복구의 추가 회귀·실제 API 브라우저 결과는
  [F2 기록](2026-10-23-review-product-save-recovery.md)에 있으며, 이 변경 이후 최종 head의 필수 CI를
  확인한 뒤 병합한다. 인증 동작 코드는 최초 CI와 같다.
- 이어 이 PR의 자동 리뷰에서 확인한 전송 전 라벨 복구는 F2 `71142b4`에서 보완해 통합했다.
  최초 확정 422와 요청 키만 있는 오프라인 거절도 포함하며 관련 100개 검사가 통과했다.
  이 후속은 웹 제품 저장 hook만 바꾸며 인증·서버 동작은 유지한다. 결과는 F2 기록에 모았다.
