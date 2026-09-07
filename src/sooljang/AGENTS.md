# 백엔드 지침

이 지침은 `src/sooljang/`와 대응하는 `tests/` 작업에 적용한다. 공통 규칙은 루트
[AGENTS.md](../../AGENTS.md), 검증 명령은 [development.md](../../docs/development.md)에 있다.

- 순수 계산은 `domain/`, 유스케이스·트랜잭션은 `application/`, HTTP·DB·파일은
  `infrastructure/`, 요청/응답과 의존성은 `api/`에 둔다. 기존 책임 경계를 유지한다.
- API 입력 검증과 별개로 참조 대상의 사용자 소유권을 확인한다. 공개 인증/health 경로는
  현재 계약과 테스트를 확인하고 변경하며 새 사용자 데이터 경로에는 인증을 적용한다.
- 구매·병·시음 변경은 기존 서비스의 상태 전이·트랜잭션·동기화 삭제 전파를 거친다.
  재시도·부분 실패·멱등 처리에서 성공한 작업과 실패한 작업의 경계를 테스트한다.
- 금액·평점·잔량의 정밀도와 null/0 의미를 유지한다. 온라인/오프라인 계산 변경은
  `tests/fixtures/metrics_cases.json` 등 공통 합성 fixture로 Python과 TS 결과를 대조한다.
- 스키마/키 이전은 기존 기록·사용자 고정·암호문 보존을 포함한다. additive migration을
  우선하고 중단·재실행·구버전 데이터·복구를 같은 PR에서 검증한다. autogenerate 결과는
  직접 검토한다. downgrade/base와 DB fixture 초기화는 폐기 가능한 테스트 DB에서만 한다.
- 외부 HTTP 부수효과와 파싱/매칭을 분리한다. 요청·redirect마다 대상/비밀 전달 경계를
  검증하고 timeout·응답 크기·rate limit·retry를 제한한다. 기본 CI는 외부/유료 API를 목킹한다.
- 필수 설정 추가 시 pytest fixture뿐 아니라 CI의 독립 Alembic 명령 환경도 갱신한다.
  테스트 DB URL을 명시하고 운영 환경의 `.env` 값이나 DB를 테스트에 재사용하지 않는다.
