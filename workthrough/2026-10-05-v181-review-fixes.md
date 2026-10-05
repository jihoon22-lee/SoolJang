# v1.8.1 — v1.8.0 최종 코드 리뷰 7건 수정

v1.8.0 배포 뒤 `v1.7.1..main` 전체를 다시 리뷰해 찾은 7건을 한 패치로 고쳤다. 브랜치
`feature/v181-review-fixes`. 결정은 `docs/history.md` D226·D227. 스키마 변경 없음(head `0019`).

## 수정

| # | 문제 | 수정 |
|---|---|---|
| 1 | 보관 화면 "보이는 병 모두 선택" 후 이동이 500병 상한에 걸려 422. 운영은 재고 1,140병이 모두 미지정이라 첫 정리에서 바로 막힌다 | `collectionApi.moveMany` 가 `MOVE_BATCH_LIMIT`(500)씩 나눠 보내고 결과를 합친다. 실행 취소도 같은 함수라 함께 해결 |
| 2 | 기본 주종 "주정강화와인·셰리와인·마데이라와인"이 이름의 "와인" 때문에 7일 규칙에 먼저 걸려 일주일 만에 "빨리 마시면 좋은 병"으로 뜸 | 규칙을 구체적인 것부터(주정강화·리큐르 90일 → 청주·사케 → 맥주·막걸리 → 와인) 검사, 마데이라·마르살라·주정강화 키워드 추가 |
| 3 | 실사 "위치 반영"이 실사 뒤 삭제된 병·위치 하나 때문에 404로 전부 취소 | 살아 있는 병·위치만 옮기고 나머지 관찰은 `relocation_skipped`("반영 못 함")로 남김. 응답에 `skipped` 건수, 알림에 건너뛴 수 표시 |
| 4 | 오프라인 소진일이 개봉일보다 앞서거나 잔량이 용량을 넘는 입력이 "다른 기기의 변경"으로 처리돼 서버 상태로 조용히 되돌아감 | 입력 오류를 `BottleInputError`(BottleTransitionError 하위)로 구분해 동기화에서 실패(`failed`)로 돌려준다. 동기화 창에서 고쳐 다시 보낼 수 있다. 온라인 API의 409는 그대로 |
| 5 | `SOOLJANG_TIMEZONE` 오타가 기동은 통과하고 날짜를 비운 기록마다 500 | 설정 검증기에서 `ZoneInfo` 로 확인해 기동 단계에서 거절 |
| 6 | `POST /collection/stocktakes/{id}/scans:batch` 와 웹 `scanMany` 를 호출하는 화면이 없음 | 엔드포인트·스키마·클라이언트·타입 제거, 테스트는 단건 `/scan` 기반으로 바꿈 |
| 7 | AGENTS.md가 100ml당 가격을 "실평단가 기준"으로 정의했지만 구현·결정(D5·D68)은 정가 기준 | AGENTS.md 용어 표를 정가 기준(실구매가 기준은 `price_per_100ml_paid`)으로 정정 |

버전: `pyproject.toml`·`__init__.py`·`web/package.json`·`package-lock.json`·`uv.lock` → 1.8.1,
`bash scripts/check_version_consistency.sh 1.8.1` 일치.

## 검증

- 새 회귀 테스트: `test_invalid_bottle_input_fails_instead_of_becoming_a_conflict`,
  `test_apply_locations_skips_bottles_deleted_after_the_scan`(+ 단건 스캔 기반으로 바꾼
  `test_apply_locations_moves_mismatched_bottles`), `test_unknown_timezone_is_rejected_at_startup`,
  `test_valid_timezone_is_accepted`, `api/collection.test.ts`(1,001병 → 500·500·1 분할),
  `openedShelfLife.test.ts`(기본 주종 이름 3종 90일, 레드와인 7일).
- `make test`: Python 1368 passed(branch 91.62%), 웹 703 passed.
- `npm --prefix web run check` 통과(branch 80.88%), `ruff check`·`ruff format --check`·`ty check` 통과.

## 미실행

- 실브라우저로 1,000병 이상 일괄 이동은 하지 않았다(분할은 단위 테스트로 확인).
- 운영 배포 결과는 머지 후 operations.md §4로 진행하고 이 기록에 이어서 남긴다.
