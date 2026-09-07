# Repository Guidelines

술장(SoolJang)은 개인 주류 컬렉션을 기록·관리·분석하는 PWA 웹 플랫폼이다. Python 3.14
백엔드와 TypeScript 프론트엔드로 구성한다.

## 작업 시작과 범위

- [docs/plan.md](docs/plan.md) §1에서 현재 위치를 읽고, 연결된 마일스톤 메인 계획·수용
  명세·담당 WP만 확인한다. 과거 Task·세션 기록은 관련 결정이 필요할 때 읽는다.
- 구현 전에 현재 브랜치·작업 트리·최신 main·열린 PR을 대조해 중복 작업을 피한다.
  진행 중인 변경을 보존하고, 재개할 때 무조건 main으로 전환하거나 환경을 재설치하지 않는다.
- 수정 대상의 하위 `AGENTS.md`를 읽는다. 백엔드와 그 테스트는
  [src/sooljang/AGENTS.md](src/sooljang/AGENTS.md), 웹은 [web/AGENTS.md](web/AGENTS.md)를 따른다.
- 승인된 구현 범위에서는 조사·수정·검증을 이어서 수행하고 이미 결정된 사항을 다시 묻지
  않는다. 사용자의 명시적 범위·선택이 스킬의 일반 지침보다 우선한다.
- 검토만 요청된 경우 검토로 마친다. 마일스톤 등록은 유료 계약·키 발급/교체·운영 데이터
  변경·릴리스 승인이 아니다. 필요한 승인이 남아도 독립적으로 준비 가능한 작업은 완료한다.

## Skills와 병렬 작업

아래 스킬은 해당 절차가 필요할 때만 읽는다. 모든 스킬을 매 작업에 일괄 로딩하지 않는다.

- [sooljang-task](.agents/skills/sooljang-task/SKILL.md): 마일스톤 작업 착수·재개·PR 묶음 확인.
- [sooljang-verify](.agents/skills/sooljang-verify/SKILL.md): 변경별 검증 선택과 실제 증거 기록.
- [sooljang-source-review](.agents/skills/sooljang-source-review/SKILL.md): 외부 소스 조사·연결 검증.
- 사용 가능한 `openai-docs`는 OpenAI 관련 조사에, `workthrough`는 완료한 변경 기록에 쓴다.
  마케팅용 `landing-page-guide-v2`를 일반 앱 UI 작업에 적용하지 않는다.

독립적인 조사·회귀/보안 검토를 병행하면 도움이 되는 작업은 서브에이전트에 위임한다
(동시에 최대 2개, 단순 수정에는 불필요). 범위·읽기/쓰기 권한·필요한 결과를 지정하고
근거 경로와 결론만 돌려받는다. 동시 수정은 파일 소유 범위를 나누며 공통 스키마와
`docs/plan.md`는 주 담당자가 통합한다. 같은 DB를 초기화하는 테스트는 병렬 실행하지 않는다.

모델·reasoning은 Codex 설정에서 관리한다. 사용자가 지정한 컨텍스트 윈도우와 자동 압축
한계는 유지한다. 스킬이나 모델 도입을 이유로 앱의 AI 기능·프레임워크를 확대하지 않는다.

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

- `uv sync --frozen` — `.venv` 생성 및 락된 의존성 설치
- `make db-local-setup` / `make db-local-start` — 격리 PostgreSQL 최초 준비 / 재개
- `make api` / `make web` — 로컬 API / 웹 기동 (포트 설정은 `docs/handoff.md` §1)
- `make test` — 격리 테스트 DB의 Python 테스트(85%)와 웹 커버리지 검사(80%)
- `uv run ruff check .` / `uv run ruff format --check .` — 린트와 포맷 검사
- `uv run ty check` — 정적 타입 분석
- `make migrate` — 격리 개발 DB에 마이그레이션 적용 (대상 URL 확인 후 실행)
- `npm ci --prefix web` — 락된 프론트엔드 툴체인 설치
- `npm --prefix web run check` — 포맷 검사, 린트, 타입 체크, 테스트, 빌드 일괄 실행
- `make help` — 사용 가능한 개발 명령 목록

`docker-compose.yml`은 이 기기의 운영 스택이다. 개발 준비에 `make db-up`, `make db-down`,
`docker compose up/down`을 쓰지 않는다. DB 테스트는 스키마를 지우므로 운영 DB에서 실행하지
않는다. `make check`는 lint·typecheck·test·secret scan이며 전체 CI와 같지 않다.
검증별 명령과 추가 CI 범위는 [docs/development.md](docs/development.md)를 따른다.

## Coding Style & Naming Conventions

Python은 4-space 인덴트와 Ruff 포맷을 사용한다. 함수·모듈은 `snake_case`, 클래스는
`PascalCase`, 공개 함수에는 명시적 타입 애너테이션을 붙인다. line-length는 100이다.
`web/` 아래 TypeScript는 Biome 포맷·린트를 따른다.

모듈은 하나의 책임에 집중시키고, **네트워크 부수효과를 순수 변환 로직과 분리**한다.
특히 외부 소스 조회(HTTP·LLM 호출)는 어댑터 경계 안에 격리해 도메인 계산이 이를 알지
못하게 한다. 변경을 제출하기 전에 Ruff, `ty`, 프론트엔드 검사를 모두 실행한다.
재계산 가능한 도메인 파생값은 DB에 저장하지 않는다. 가격 관측처럼 재계산할 수 없는
1차 사실의 저장과 구분한다.

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

행위 변경은 관찰 가능한 회귀 테스트로 검증한다. 문서·지침만 바뀌면 코드 동작을 흉내 내는
테스트를 추가하지 않는다. Python은 **브랜치 커버리지 85% 이상**을 요구하고
`tests/`가 소스 경로를 미러링한다. TypeScript는 **80% 이상**을 요구하며 Vitest를 사용한다.

테스트 이름은 관찰 가능한 행위로 짓는다.
예: `test_multiple_purchases_produce_weighted_avg_paid_price`

파생 지표 계산, 레거시 CSV 파싱, 동기화 병합 규칙은 단위 테스트로 촘촘히 덮는다. 외부
경계(외부 소스 사이트, LLM, 브라우저 API)는 목킹한다. 실제 네트워크·LLM 호출이 필요한
테스트는 opt-in 마커로 분리하고, 필요한 환경 변수는 **값 없이 이름만** 문서화한다.

레거시 데이터 테스트에는 실제 기록을 쓰지 않는다. 익명화·축약한 fixture를 `tests/`
아래에 두고, 실측 합계 대조가 필요한 검증은 별도 opt-in 테스트로 분리한다.

구현 중에는 관련 검증부터 실행하고 제출 전 필수 검사를 완료한다. 동일 코드·환경·입력의
검증은 새로운 실패나 미해결 우려가 없으면 반복하지 않는다. 구현·CI·실연결·실브라우저·
복구·배포를 구분하고 미실행을 통과로 기록하지 않는다.

## Commit & Pull Request Guidelines

Conventional Commits(`type(scope): subject`)를 사용하고 subject는 간결하게, 커밋은 하나의
관심사에 집중시킨다. 허용 type은 `feat`, `fix`, `docs`, `style`, `refactor`, `perf`,
`test`, `build`, `ci`, `chore`, `revert` 이다. scope는 선택이며 예시는
`feat(import): 통계 블록 경계 인식 추가`, `test(domain): 100ml당 가격 경계 케이스 보강`
이다. breaking change는 `!`로 표시한다. `commit-msg` 훅과 PR 품질 게이트가 형식을 강제한다.

검토 가능한 PR 묶음 하나는 `feature/<task-slug>` 브랜치 하나에 대응한다. 이슈와 PR은
N:M으로 연결하며 현재 마일스톤 메인 계획의 매핑을 따른다. 파일·계층별 자동 분할을 피하고,
분할·결합 시 검토 범위와 이유를 기록한다. `main`에 직접
푸시하지 않는다(저장소 최초 부트스트랩 커밋만 예외). PR은 동기, 변경 요약, 검증 명령,
관련 이슈를 설명한다. 필수 체크가 통과한 뒤에만 머지한다. UI 동작이 바뀌면 스크린샷이나
민감정보를 제거한 로그를 첨부한다.
머지할 때는 커밋 단위를 보존하는 merge commit을 사용한다(`gh pr merge --merge`).

작업이 명시적으로 미완료인 경우가 아니라면 PR은 draft가 아닌 review 가능한 상태로
생성한다. README, PR 설명, 커밋 메시지처럼 사용자가 직접 읽는 내용에는 한글을 우선
사용한다. Library, API concept, technical term은 자연스러운 English를 함께 사용해 어색한
번역투를 피하고, 기술 식별자와 명령어는 원문 표기를 유지한다.

**모든 Task PR에는 `docs/plan.md` 갱신을 포함한다.** 진행 상태, "현재 위치", 결정 로그를
갱신해 작업이 중단되어도 다음 사람이 이어받을 수 있게 한다.
실제 검증은 PR 묶음당 `workthrough/` 기록 하나에 모으고 계획 문서에는 요약·링크를 남긴다.
마일스톤 메인·수용 명세를 개별 구현 PR의 `Closes` 대상으로 삼지 않는다. 부분 구현인 WP도
전체 수용 전 닫지 않는다. PR 설명에는 관련 요구사항·데이터/권한 변화·검증·미실행을 적는다.

## Release & Deployment

이미 1.x를 출시했다. 버전은 Python·웹·패키지 설정에서 일치시키고, 패키지 버전과 실제 배포
버전은 구분한다. 버전 태그(`vX.Y.Z`) 푸시는 릴리스 워크플로를 실행하므로 명시적 릴리스
승인과 마일스톤 수용을 확인한 뒤 [docs/operations.md](docs/operations.md)의 절차를 따른다.
운영 자동 복구는 기존 컨테이너의 `--no-recreate` 시작이며 새 이미지 배포와 구분한다.

기능 구현이 끝나면 직접 써 보며 개선 여지를 찾는 단계를 반드시 거친다. 단위 테스트가
통과하는 것과 쓰기 좋은 것은 다른 문제다.

## Security

- 개인 소비 이력은 민감 정보다. 실제 데이터·백업 덤프·업로드 이미지를 커밋하지 않는다
- 사용자 데이터 API는 인증·소유권 검사를 요구한다. 로그인·초기 설정·health처럼 설계상
  공개된 경로의 예외는 명시적으로 유지하며 Tailscale을 앱 인증의 대체물로 삼지 않는다
- 부팅용 비밀·암호화 마스터 키는 환경 설정으로 주입하고 사용자 API 키는 기존 암호화 DB
  저장을 사용한다. 복호화 실패로 암호문을 초기화하지 않는다. 평문을 저장소·로그·에러에 남기지 않는다
- 업로드 파일은 MIME·크기·확장자를 검증하고 저장 경로를 격리한다
- 외부 사이트 수집은 robots.txt와 rate limit을 준수하고, 출처 URL을 항상 보관한다

## Code Review Rules

- 온라인·오프라인의 계산/상태 전이 불일치, outbox 재전송·동시 수정·계정 전환의 데이터
  손실을 확인한다. 파생 가격에서 null과 0, 제품·판본·SKU·판매 조건을 혼합하지 않는다.
- 외부 요청 전 URL·redirect·연결 대상과 비밀 헤더 전달 범위를 검증하고 외부 HTML은
  신뢰하지 않는다. 실패·캐시·미검증 자료를 새 관측이나 정상 실연결로 표시하지 않는다.
- migration·키 이전에서 기존 구매·병·시음·사용자 고정·암호문 보존과 복구를 확인한다.
  구체적 결함·재현 조건·영향·근거 경로를 보고하고 포맷 지적은 CI에 맡긴다.
