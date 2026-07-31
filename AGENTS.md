# Repository Guidelines

술장(SoolJang)은 개인 주류 컬렉션을 기록·관리·분석하는 PWA 웹 플랫폼이다. Python 3.14
백엔드와 TypeScript 프론트엔드로 구성한다.

## Project Structure & Module Organization

루트에는 프로젝트 전역 설정과 문서만 둔다.

- `src/sooljang/` — 백엔드 애플리케이션 코드. 책임별로 묶는다
  - `domain/` — 엔티티, 값 객체, 파생 지표 계산 규칙. 외부 의존성 없음
  - `application/` — 유스케이스 서비스, 트랜잭션 경계
  - `infrastructure/` — DB(SQLAlchemy·Alembic), 외부 소스 어댑터, 파일 저장소
  - `api/` — FastAPI 라우터, 스키마, 의존성
- `tests/` — 자동화 테스트. `src/` 계층을 미러링한다
- `web/` — Vite + React + TypeScript 프론트엔드와 그 테스트
- `docs/` — 아키텍처·작업 계획·레거시 스키마 문서
- `scripts/` — 개발 유틸리티와 일회성 유지보수 명령
- `assets/` — 코드가 아닌 fixture, 템플릿, 샘플 미디어

생성 산출물, 로컬 자격증명, 실제 음주 기록, 백업 덤프, 업로드 이미지는 커밋하지 않는다.

## Build, Test, and Development Commands

의존성 관리는 `uv`를 사용하고, 명령은 저장소 루트에서 실행한다.

- `uv sync` — `.venv` 생성 및 락된 의존성 설치
- `uv run --env-file .env.local sooljang-api` — 로컬 API 서비스 기동
- `uv run pytest` — 브랜치 커버리지 포함 테스트, 85% 최소치 강제
- `uv run ruff check .` / `uv run ruff format --check .` — 린트와 포맷 검사
- `uv run ty check` — 정적 타입 분석
- `uv run alembic upgrade head` — 마이그레이션 적용
- `npm ci --prefix web` — 락된 프론트엔드 툴체인 설치
- `npm --prefix web run check` — 포맷 검사, 린트, 타입 체크, 테스트, 빌드 일괄 실행
- `make help` — 사용 가능한 개발 명령 목록

명령은 로컬과 CI에서 동일하게 동작해야 한다.

## Coding Style & Naming Conventions

Python은 4-space 인덴트와 Ruff 포맷을 사용한다. 함수·모듈은 `snake_case`, 클래스는
`PascalCase`, 공개 함수에는 명시적 타입 애너테이션을 붙인다. line-length는 100이다.
`web/` 아래 TypeScript는 Biome 포맷·린트를 따른다.

모듈은 하나의 책임에 집중시키고, **네트워크 부수효과를 순수 변환 로직과 분리**한다.
특히 외부 소스 조회(HTTP·LLM 호출)는 어댑터 경계 안에 격리해 도메인 계산이 이를 알지
못하게 한다. 변경을 제출하기 전에 Ruff, `ty`, 프론트엔드 검사를 모두 실행한다.

도메인 용어는 한글 개념과 영문 식별자를 다음과 같이 대응시킨다.

| 한글 | 식별자 | 의미 |
|---|---|---|
| 주종 | `category` | 계층형 분류 (와인 > 레드와인) |
| 제품 | `product` | 논리적 제품 (이름·빈티지·도수) |
| 규격 | `sku` | 용량별 단위, 바코드 매칭 대상 |
| 구매 건 | `purchase` | 한 번의 구매 (구매처·가격·병수) |
| 개별 병 | `bottle` | 물리적 병 1개 (상태·잔량) |
| 시음 세션 | `tasting_session` | 한 번 마신 기록 (평점·노트) |
| 평단가 / 실평단가 | `avg_list_price` / `avg_paid_price` | 병당 평균 정가 / 실구매가 |
| 100ml당 가격 | `price_per_100ml` | 실평단가 기준 단위 가격 |

## Testing Guidelines

모든 행위 변경에는 테스트를 추가한다. Python은 **브랜치 커버리지 85% 이상**을 요구하고
`tests/`가 소스 경로를 미러링한다. TypeScript는 **80% 이상**을 요구하며 Vitest를 사용한다.

테스트 이름은 관찰 가능한 행위로 짓는다.
예: `test_multiple_purchases_produce_weighted_avg_paid_price`

파생 지표 계산, 레거시 CSV 파싱, 동기화 병합 규칙은 단위 테스트로 촘촘히 덮는다. 외부
경계(외부 소스 사이트, LLM, 브라우저 API)는 목킹한다. 실제 네트워크·LLM 호출이 필요한
테스트는 opt-in 마커로 분리하고, 필요한 환경 변수는 **값 없이 이름만** 문서화한다.

레거시 데이터 테스트에는 실제 기록을 쓰지 않는다. 익명화·축약한 fixture를 `tests/`
아래에 두고, 실측 합계 대조가 필요한 검증은 별도 opt-in 테스트로 분리한다.

## Commit & Pull Request Guidelines

Conventional Commits(`type(scope): subject`)를 사용하고 subject는 간결하게, 커밋은 하나의
관심사에 집중시킨다. 허용 type은 `feat`, `fix`, `docs`, `style`, `refactor`, `perf`,
`test`, `build`, `ci`, `chore`, `revert` 이다. scope는 선택이며 예시는
`feat(import): 통계 블록 경계 인식 추가`, `test(domain): 100ml당 가격 경계 케이스 보강`
이다. breaking change는 `!`로 표시한다. `commit-msg` 훅과 PR 품질 게이트가 형식을 강제한다.

Task 하나는 `feature/<task-slug>` 브랜치 하나, PR 하나에 대응시킨다. `main`에 직접
푸시하지 않는다(저장소 최초 부트스트랩 커밋만 예외). PR은 동기, 변경 요약, 검증 명령,
관련 이슈를 설명한다. 필수 체크가 통과한 뒤에만 머지한다. UI 동작이 바뀌면 스크린샷이나
민감정보를 제거한 로그를 첨부한다.

작업이 명시적으로 미완료인 경우가 아니라면 PR은 draft가 아닌 review 가능한 상태로
생성한다. README, PR 설명, 커밋 메시지처럼 사용자가 직접 읽는 내용에는 한글을 우선
사용한다. Library, API concept, technical term은 자연스러운 English를 함께 사용해 어색한
번역투를 피하고, 기술 식별자와 명령어는 원문 표기를 유지한다.

**모든 Task PR에는 `docs/plan.md` 갱신을 포함한다.** 진행 상태, "현재 위치", 결정 로그를
갱신해 작업이 중단되어도 다음 사람이 이어받을 수 있게 한다.

## Release & Deployment

버전 태그(`vX.Y.Z`) 푸시는 릴리스 워크플로를 실행한다. **개발 기간 중에는 태그를 푸시하지
않는다.** 첫 정식 릴리스는 모든 기능 Task 와 자체 통합 테스트·다각도 분석·개선 실행
(`docs/plan.md` Task 21·22)이 끝난 뒤 한 번만 수행한다. 개발 중 버전은 `0.x`를 유지한다.

기능 구현이 끝나면 직접 써 보며 개선 여지를 찾는 단계를 반드시 거친다. 단위 테스트가
통과하는 것과 쓰기 좋은 것은 다른 문제다.

## Security

- 개인 소비 이력은 민감 정보다. 실제 데이터·백업 덤프·업로드 이미지를 커밋하지 않는다
- 모든 API는 인증을 요구한다. Tailscale로 접근이 제한되더라도 앱 레벨 인증을 생략하지 않는다
- 시크릿은 `.env`로만 주입한다. 저장소, 로그, 에러 메시지에 값이 노출되지 않게 한다
- 업로드 파일은 MIME·크기·확장자를 검증하고 저장 경로를 격리한다
- 외부 사이트 수집은 robots.txt와 rate limit을 준수하고, 출처 URL을 항상 보관한다
