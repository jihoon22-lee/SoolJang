# B01 합성 평가 기준선

측정: 2026-09-07, WSL 로컬 Python 3.14.7/PostgreSQL 17, 기존 lockfile + httpcore 직접 의존성.
매칭 구현은 main `30b573f`의 `matching.py`와 동일하다. B01은 평가셋/계측을 추가했으며
매칭 개선은 B04에서 수행한다. 실제 소비 이력이나 유료/생성형 API를 사용하지 않았다.

## 매칭 평가 v1

`tests/fixtures/discovery_cases.json`은 합성 16질의/정답이 있는 13질의다. 배치·캐스크·
빈티지·용량·세트, 일본어·한자·악센트·전각, 미등록/빈결과를 구분한다. 각 후보의 정답 여부와
근거가 있으며 소스가 후보를 실제 회수하는 능력과는 다른 **제공된 후보의 매칭** 평가다.

실행: `uv run --frozen python scripts/evaluate-discovery.py` (7회 median, 별도 tracemalloc).

| 지표 | 기준선 |
|---|---|
| 자동 채택 / 정확한 자동 채택 | 9 / 7 |
| 자동 오탐 | 2 (`batch-parentheses`, `cask-parentheses`) |
| 자동 판정 precision | 77.78% |
| 정답 후보 회수율(top 5, score ≥ 0.5) | 9/13 = 69.23% |
| 올바른 자동 채택 coverage | 7/13 = 53.85% |
| 후보 누락 | 일본어·한자·악센트·전각 4질의 |
| 16질의 median / 측정 중 peak | 0.436 ms / 4,858 bytes |
| 외부 HTTP 요청 | 0 |

B04 gate를 구현 전에 고정한다: 이 fixture에서 **자동 오탐 0**, precision 100%, 후보 회수율
80% 이상, 올바른 자동 채택 coverage 50% 이상. `--check`는 이 gate를 검사한다. 현재 기준선은
**미통과**이며 B01 코드/안전 요청 테스트 통과와 별개다. fixture를 삭제/정답을 바꿔 gate를
맞추지 않는다. 추가 실제 허용 샘플은 별도 revision과 근거를 남긴다.

필드 추출률은 소스 응답 fixture와 실제 허용 응답의 필수 필드 수로 별도 집계한다. 이 매칭
수치를 인터넷 전체의 실제 회수율이나 가격/후기 추출률로 사용하지 않는다.

## 합성 API 규모 측정

기존 `tests/performance/test_scale_benchmarks.py`의 고정 seed 42, 격리 `sooljang_test` 사용.
`SOOLJANG_RUN_BENCHMARKS=1`과 명시한 테스트 URL로 `pytest --no-cov tests/performance -m benchmark -s`
실행: 2개 테스트 통과. 각 endpoint 1회 측정으로 p95/SLA를 추정하지 않는다.

| API | 429제품/1,078병 | 4,290제품/10,780병 |
|---|---|---|
| 목록 첫 50개 | 103.7 ms | 140.8 ms |
| 통계 합계 | 92.0 ms | 250.7 ms |
| 주종 집계 | 23.1 ms | 162.1 ms |
| 랭킹 | 23.0 ms | 392.4 ms |
| 구매처×주종 pivot | 21.9 ms | 87.0 ms |
| 시계열 | 13.2 ms | 57.8 ms |

넉넉한 기존 회귀 상한(목록 5초, 집계 10초 등)은 유지한다. 이후 성능 비교는 동일 환경·seed·
schema/input 조건에서 반복 측정하고 새 병목만 고친다. DB fixture 초기화를 병렬로 실행하지 않는다.

## 브라우저·요청 기준선

Playwright 1.63.0 / Chromium 153, Vite dev 서버와 **실제 격리 API·PostgreSQL**을 연결했다.
합성 계정/소스에서 루프백 대상 probe가 요청 전 차단되고, 설정 revision 변경 후 재검증 표시,
UTC 하루 예약 0/25 표시를 390px·1280px에서 확인했다. 모바일 화면 준비 1,649ms(1회 dev 서버,
처음 변환 비용 포함). 운영 초기 화면 SLA나 캐시된 PWA 성능으로 해석하지 않는다.

현재 outbox/PWA 성능·메모리 기준은 WP02에서 계정/배치 계약 fixture와 함께 측정한다.
외부 요청은 mock/통제된 transport에서 실제 hop 예약과 금지 대상 0회로 확인한다.
허용 실소스의 추출·판매 조건/지점 완전성, 인증 제공자, 운영 브라우저 수용은 아직 미검증이다.
