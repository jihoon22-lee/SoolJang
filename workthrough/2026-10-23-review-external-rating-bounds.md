# F5 외부 평점의 유효 범위와 정규화

- 기준: main `8f21ba9`, `feature/review-external-rating-bounds`.
- 요구사항: 리뷰 ⑧, D251·D258, QS13·QS18. 2026-10-23 사용자의 구현·PR·Release 승인 범위.
- 데이터/권한: schema 0021 유지. 제공자·소스·수집 권한·캐시 키·개인 평점을 변경하지 않는다.

## 변경

`NormalizedFields.rating_normalized`는 원평점·척도가 유한하고 `0 <= rating <= scale`,
`scale > 0`일 때만 5점 척도로 환산한다. 잘못된 수치는 0·5로 보정하지 않고 정규화 값만
누락한다. `rating / scale * 5` 순서로 정상적인 큰 척도의 중간 overflow를 피하고 Decimal
연산 실패를 경계에서 처리한다. 원본 fields와 출처·캐시 표시를 유지하므로 한 소스의 깨진
평점 때문에 다른 정상 소스의 응답 전체가 실패하지 않는다.

## 실행 증거

| 검사 | 결과 |
|---|---|
| 수정 전 회귀 | 8개 실패. 큰 유한 값·작은 척도·음수·척도 초과·비유한 수치 및 발견 응답 직렬화 경계 확인 |
| 관련 mock/contract | 113개 통과. 0점·100점 척도·최댓값·매우 큰 정상 척도·캐시/새 결과·정상 소스 공존 확인 |
| 정적 검사 | 전체 Ruff check·format(343파일)·ty 통과 |
| 독립 읽기 검토 | 유효성·Decimal 실패·원본 보존·캐시 경로 확인, 추가 차단 결함 없음 |
| 전체 Python | 1,804 통과·31 opt-in 제외·경합 준비 대기 timeout 1건. branch 포함 coverage 92.18% |
| timeout 보완 | 값 불일치가 아닌 기존 sync 경합 테스트의 3초 준비 대기 초과. 같은 코드·기준으로 해당 파일 4개를 재실행해 모두 통과(10.23초). 호스트의 다른 빌드·검사가 병행 중이었음 |
| F1·F3 통합 | 주종 경합·구매 축소 경합·외부 평점 53개 통과 |

검사는 `PYTHONPATH=src SOOLJANG_ENV_FILE='' SOOLJANG_ENVIRONMENT=test`로 실행한다.
DB 검사는 명시한 격리 URL `postgresql+psycopg://sooljang@127.0.0.1:54329/sooljang_test`를
사용한다. 전체 검사를 일괄 성공했다고 해석하지 않으며 timeout과 보완 결과를 구분한다.

외부 HTTP·유료 API·운영 데이터·실브라우저는 이 묶음에서 미실행이다. 순수 변환과 응답
직렬화 변경이므로 합성 contract 및 캐시 fixture를 사용했고 실제 소스 관측으로 표시하지 않는다.
F1·F3 및 도구 보안 패치를 통합했다. 웹 소스는 F1과 같아 Vite 7.3.7/Vitest 4.1.12에서
1,384개·branch 83.35%·build·audit 0 결과를 재사용한다. 최종 CI 결과는 릴리스 기록에 연결한다.
