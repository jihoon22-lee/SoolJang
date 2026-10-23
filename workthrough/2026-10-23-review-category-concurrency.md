# F3 주종 계층과 제품 배정의 동시성

- 기준: main `8f21ba9`, `feature/review-category-concurrency`. F1 통합 이후 동일 경합을 다시 확인한다.
- 요구사항: 리뷰 ③, QS07·QS17, D256. 2026-10-23 사용자의 구현·PR·Release 승인 범위.
- 데이터/권한: schema 0021 유지. API·ID·첨부·사용자 소유권은 변경하지 않는다.

## 변경

주종 생성·이동·삭제·병합·순서 변경·시드 저장/복원은 같은 사용자 쓰기 잠금을 얻은 뒤
현재 계층을 읽는다. 잠금 대기 전 ORM 캐시에 있던 부모·시드도 다시 조회한다. 제품 생성과
동기화의 기존 공통 잠금에 제품 수정·일괄 주종 정리를 맞춰, 삭제된 주종에 늦게 연결하지 않는다.
제품·정리 미리보기 행보다 사용자 잠금을 먼저 획득한다. 서로 반대 방향으로 부모를 옮기거나
병합하는 요청은 두 번째 요청이 최신 계층으로 검증되어 순환·삭제 부모 참조를 거절한다.

## 실행 증거

모든 DB 검사는 `PYTHONPATH=src SOOLJANG_ENV_FILE='' SOOLJANG_ENVIRONMENT=test`와
명시한 `127.0.0.1:54329`의 작업 전용 DB를 사용했다. 운영 DB는 사용하지 않았다.

| 검사 | 결과 |
|---|---|
| 수정 전 실제 PostgreSQL 경합 | 고유 10개 실패. 반대 이동·병합, 부모 삭제와 온라인/sync 자식 생성, 제품 create/update/sync/cleanup, 오래된 ORM 부모, 동시 시드 복원 |
| `pytest --no-cov -q tests/api/test_category_concurrency.py` | 10개 통과. 별도 로그인 세션을 사용하며 실패 sync 재전송 결과도 일치 |
| 전체 `pytest -q` | 1,794 통과·31 opt-in 제외, branch 포함 coverage 92.46%. migration 3개는 테스트 DB 이름 안전가드에서 실행 전 거절 |
| migration 3개 보완 | 이름이 `_test`로 끝나는 새 빈 `sooljang_review_f3_20261023_test`에서 3개 모두 통과. 전체 검사를 무조건 통과한 것으로 기록하지 않음 |
| 정적 검사 | 전체 `ruff check .`, `ruff format --check .`, `ty check` 통과 |
| 독립 코드 검토 | 계층 쓰기 진입·잠금 순서·소유권·삭제/재배정·sync 경계 확인. 추가 차단 결함 없음 |

최초 전체 검사 URL은 `postgresql+psycopg://sooljang@127.0.0.1:54329/sooljang_review_f3_20261023`.
보완 검사는 같은 접두 환경에 `_test`로 끝나는 DB URL을 지정하고 다음을 실행했다.

```bash
uv run --frozen --no-sync pytest --no-cov -q \
  tests/infrastructure/database/test_price_watch_migration.py \
  tests/infrastructure/database/test_provider_connection_migration.py \
  tests/infrastructure/database/test_record_event_migration.py
```

웹 소스는 이 묶음에서 변경하지 않는다. F1의 웹 전체 검사·CI와 최종 통합 검증을 참조한다.
실브라우저·외부 실연결은 이 묶음에서 미실행이다. 실제 PostgreSQL 경합 수용과 구분한다.
F4 인증 활동 시각 갱신을 분리한 뒤에도 F1/F3 경합을 다시 확인한다.
