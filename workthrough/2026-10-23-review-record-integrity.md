# F1 구매·시음 연결과 병 종료 상태 보존

- 기준: main `8f21ba9`, `feature/review-record-integrity`.
- 요구사항: 리뷰 ①·⑤, QS02·QS03·QS04·QS17, D249·D250·D254.
- 사용자 승인: 2026-10-23 F1~F5 구현·검증·Push·PR·Release와 작업 정리.
- 데이터/권한: schema 0021 유지. 활성 시음 연결을 보존하고 종료 병의 다른 명령을 거절한다.
  인증·소유권·동일 멱등키 재전송·삭제 시음 원본 보존 계약을 유지한다.

## 변경

구매 병수를 줄일 때 미개봉 상태만 확인하던 경로를 활성 시음 연결까지 검사하도록 바꾼다.
정정으로 시음이 연결된 미개봉 병은 남기고, 다른 안전한 병을 큰 번호부터 제거한다. 가능한
수가 부족하면 409로 전체 요청을 거절한다. 구매 전체 삭제와 같은 시음 연결 조회를 사용한다.
구매 수정·삭제는 정정·복구·outbox와 같은 사용자 쓰기 잠금을 먼저 획득한다.

소진 병의 재소진과 이미 증여·판매한 병의 재처분은 충돌이다. 동기화의 기존 receipt 재전송은
성공 결과를 그대로 돌려주며, 늦은 다른 명령의 충돌 뒤에도 관계없는 작업은 계속 처리한다.

## 실행 증거

환경은 Python 3.14, 로컬 PostgreSQL 17.10 `127.0.0.1:54329/sooljang_test`다.
모든 pytest는 `SOOLJANG_ENV_FILE=''`, `SOOLJANG_ENVIRONMENT=test`, 명시한 테스트 DB URL을
사용한다. 다른 작업의 DB는 별도로 분리했다. 아래 명령은 저장소 루트에서 실행했다.

| 단계 | 명령·시나리오 | 결과 |
|---|---|---|
| 수정 전 재현 | `uv run --frozen --no-sync pytest --no-cov -q tests/api/test_review_record_integrity.py` | 10 실패·8 통과. 시음 병 축소 2건, 종료 재전이 5건, 늦은 outbox 명령 3건 실패 |
| 관련 회귀 | 구매·시음·동기화·정정·복구 테스트 | 174 통과 |
| 실제 DB 경합 | `tests/api/test_purchase_resize_concurrency.py`: 수량 축소와 시음 연결 정정·복구를 두 로그인 세션에서 양 순서로 실행 | 4 통과 |
| 전체 Python | `uv run --frozen --no-sync pytest` | 1,809 통과·31 opt-in 제외, branch 포함 coverage 92.44% |
| 웹 | `npm --prefix web run check` | 1,384 통과, branch coverage 83.36%, lint·typecheck·build 통과 |
| 정적·비밀 검사 | `uv run --frozen --no-sync ruff check .`, `ruff format --check .`, `ty check`, `bash scripts/scan-secrets.sh` | 통과 |
| 독립 검토 | 별도 검토자가 잠금 순서·시음 삭제/복구·종료 명령·멱등 재전송을 읽기 전용 확인 | 추가 차단 결함 없음 |
| 실제 브라우저 | Chromium 151, 390×844, 합성 계정과 격리 API. UI로 2병 생성 → 시음을 다른 미개봉 병으로 정정 → UI에서 1병으로 축소 | 409 표시, 병 2개와 시음 연결 보존 |

브라우저 [결과 로그](assets/2026-10-23-review-record-integrity/browser-results.json)와
[모바일 화면](assets/2026-10-23-review-record-integrity/mobile-quantity-conflict.png)을 남긴다.
외부 네트워크·운영 기록을 사용하지 않았다. API 데이터 오류와 별개로 초기 브라우저 스크립트의
버튼 접근성 이름 선택자를 고친 뒤 위 흐름을 완료했다.

## 제한

수정 전 10건 실패는 실제 격리 DB API 재현이다. `--no-cov` 관련 테스트를 전체 커버리지 수용으로
해석하지 않는다. 운영 DB·개인 기록은 사용하지 않으며 실제 운영 데이터 자동 복구는 하지 않는다.
PR·CI·병합은 로컬 수용과 별개이며 최종 릴리스 기록에 실제 결과를 연결한다.
