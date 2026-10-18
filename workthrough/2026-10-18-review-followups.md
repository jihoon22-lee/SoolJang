# 전체 코드 리뷰 후속 R1~R6 실행 기록

## 범위와 기준

- 사용자 승인(2026-10-18): 정적 전체 리뷰의 묶음 R1~R6을 순차 구현하고, 각 PR의 CI를 확인한 뒤
  자체 판단으로 병합한다. 모두 끝나면 버전 갱신·태그·릴리스·운영 배포까지 진행한다.
- 리뷰 기준 main `b98587f`(v1.10.1, schema 0021). 리뷰 원문은 정적 분석이며 테스트·DB·브라우저를
  실행하지 않았다. 각 결함은 이 기록의 PR별 절에서 실패하는 회귀 테스트로 다시 확인한다.
- 검증은 격리 PostgreSQL(127.0.0.1:54329 `sooljang_test`)과 Vitest/jsdom에서 한다. 운영 기록·
  운영 DB·운영 `.env`는 테스트에 쓰지 않는다. 같은 DB를 쓰는 pytest를 동시에 돌리지 않는다.

## R1 쓰기 내구성 (`feature/review-write-durability`)

### 재현과 변경

1. **응답 전 commit(B1).** `db_session`이 기본 범위 의존성이라 FastAPI 0.141.1이 응답을 보낸 뒤
   commit했다. 새 테스트에서 commit 실패를 주입하면 기대 500, 실제 201로 실패했다.
   `Depends(db_session, scope="function")`로 바꿔 응답 직렬화 뒤·전송 전에 commit한다.
2. **온라인 생성 중복(B9).** `POST /products`, `POST /purchases`에 선택 `request_id`를 추가했다.
   서버가 `uuid5(user_id, 종류:request_id)`로 id를 정해 이미 있으면 같은 행을 돌려주고, 이름·규격·
   병수가 다르면 409다. 웹은 `draftRequestId(form)`로 폼 초안 버전(revision 포함) 해시를 키로 쓴다.
   같은 초안 재전송은 같은 키, 수정·저장 후에는 새 키다. 구매처는 기존 `(user_id, name)` 유일성과
   목록 재조회로 이미 중복이 막혀 바꾸지 않았다.
3. **오프라인 연속 수정의 기준 시각(B7).** 보내지 않은 수정 뒤의 수정이 낙관적 기기 시각을
   `base_updated_at`으로 써서, 앞 수정이 충돌해도 뒤 수정이 다른 기기 변경을 덮어썼다.
   `enqueue`가 같은 행의 대기 중 수정에서 서버 기준 버전을 이어받는다. 수정 전 테스트는
   `[원래, 낙관값]`으로 실패했고 수정 후 두 명령 모두 원래 서버 버전을 기준으로 삼는다.
4. **실패한 병 동작 폐기 범위(B8).** 이미 있는 병의 `set_remaining` 실패를 폐기하면 같은 병의
   시음까지 의존 명령으로 지웠다. 수정·동작 실패의 의존 명령을 `expected_operation_id`·
   `origin_operation_id`로 이어진 명령으로 한정한다. 생성 실패는 기존처럼 참조 명령을 묶는다.

### 실행 검증

- RED: commit 실패 주입 테스트 기대 500·실제 201. 연속 수정 기준 테스트는 수정 전 코드로 실패.
- GREEN(격리 DB): 전체 `uv run --frozen pytest` 1,710 passed / 30 opt-in skipped(11분 35초).
  이 실행 뒤 추가한 멱등성 테스트와 products/purchases/commit 경계 69건 통과.
- `ruff check .`, `ruff format --check .`, `ty check`, `scan-secrets.sh`, 버전 일치(1.10.1) 통과.
- `npm --prefix web run check`: lint(기존 경고 18), typecheck, Vitest 100파일/1,287건,
  branch 83.18%, build(precache 16) 통과.
- `BottlePanel.pagination` 200건 경우는 coverage 계측에서 기본 5초를 넘겨 main 기준에서도
  타임아웃이 재현됐다(5.1초). 동작 변경 없이 해당 테스트만 20초 제한을 명시했다.
- 미실행: 실브라우저(이번 변경은 서버 commit 시점·요청 본문·outbox 기준값이며 화면 변화 없음),
  실제 commit 실패(연결 단절) 주입은 단위 수준의 commit 예외로 대체했다.
- CI: PR #173 Quality run `39101537931`은 두 번 시도 모두 모든 작업이 단계 0개·러너 미할당으로 2초 만에
  실패했다. 같은 워크플로가 2026-10-12에는 통과했고 이 PR은 `.github`를 바꾸지 않았다. 비공개
  저장소의 Actions 사용량·결제 한도 차단으로 추정하며 토큰 권한으로 annotation을 읽지 못했다.
  2026-10-18 18:50 KST 무렵 Actions가 다시 실행돼 재실행 `39103320339`의 10개 작업이 성공했다.

### PR 자동 리뷰 반영

Codex 리뷰(5b6954e 기준) 4건을 재현해 반영했다.

1. **기본값만 제출한 재전송(P1).** 초안이 저장되지 않은 제출은 매번 새 `request_id`였다. 제출 내용 지문과
   요청 id를 탭·계정별 `sessionStorage`에 두고 같은 내용이면 재사용, 저장 성공 뒤에는 지운다
   (`submissionRequestId`/`finishSubmission`). 저장 성공 후 같은 내용을 다시 등록하면 새 요청이다.
2. **제품 재전송 비교(P2).** 이름만 비교해 같은 키로 용량·도수·생산자·품종이 다른 요청도 201이었다. 생성
   내용 전체(규격·바코드 정규화, 생산자 대소문자, 품종 정규화 포함)를 비교하고 다르면 409.
3. **구매 재전송 비교(P2).** SKU·병수만 비교했다. 구매처·날짜·가격·통화·할인·병 생성 여부까지 비교한다.
4. **요청 전 계정 확인(P2).** 요청 id 계산이 동기화되어 await 틈이 사라졌고, 제품 생성 직전에 세션을
   다시 확인한다.
- 두 번째 리뷰(66723cb 기준) 2건: 재전송을 행의 **현재** 값과 비교해, 만든 뒤 병수·용량을 고치면 원래
  요청의 재전송은 409, 고친 값의 새 요청은 201이 됐다. 처음 요청의 정규화 지문을 `outbox_receipt`에
  남겨 비교한다(스키마 변경 없음). 고친 뒤 재전송 테스트 2건은 이전 구현에서 실패했다.
- 반영 후 `sooljang_test` 단독 전체 pytest 1,719 passed / 30 skipped, branch 92.26%. `ruff`·`ty`·secret scan
  통과. `npm --prefix web run check` 통과(Vitest 1,290건, branch 83.03%, 검사 오류 0).
- 같이 고친 결함: 토스트 닫기 타이머를 unmount 때 지우지 않아 전체 웹 검사에서 테스트 환경 종료 뒤
  `window is not defined` 미처리 오류가 났다(검사 exit 1). 타이머를 추적해 지운다.
- RED→GREEN: `test_create_idempotency.py` 신규 3건(수정 전 2건 실패), `drafts.test.tsx` 3건,
  `Toast.test.tsx` 1건(수정 전 실패).
  CI 통과 전에는 병합하지 않는다.
