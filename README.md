# 술장 (SoolJang)

개인 주류 컬렉션을 기록·관리·분석하는 웹 플랫폼. 위스키, 브랜디, 와인, 사케, 맥주,
전통주, 백주 등 주종에 상관없이 **제품 → 구매 건 → 개별 병 → 시음 세션** 4계층으로
기록하고, 파생 지표와 통계를 자동으로 계산한다.

PC와 안드로이드에서 같은 데이터를 보며, 오프라인에서도 기록할 수 있는 PWA로 만든다.

## 왜 만드는가

기존에는 엑셀 한 시트로 관리했다. 한계는 명확했다.

- 제품 정보와 구매 정보가 한 행에 뒤섞여, **같은 술을 여러 번 사면 구매처·가격 이력이 소실**된다
- 평단가, 실평단가, 100ml당 가격, 재고·미개봉·개봉 병수를 **손으로 계산·관리**해야 한다
- 검색·필터가 불편하고, 통계를 볼 때마다 수식과 표를 다시 만들어야 한다
- 외부 평점·시세·후기를 참고하려면 매번 브라우저를 열어 따로 찾아야 한다

술장은 이 네 가지를 구조적으로 해결한다.

## 주요 기능

| 영역 | 내용 |
|---|---|
| 기록 | 제품·구매 건·개별 병·시음 세션 4계층. 같은 술의 서로 다른 구매처·가격을 각각 보존 |
| 파생 지표 | 평단가, 실평단가, 100ml당 가격, 구매/소비/재고/미개봉/개봉 병수, 할인율, 재고 자산가치를 자동 계산 |
| 검색 | 한글 부분 문자열 검색, 주종 계층·도수·가격·재고·평점 다중 필터, 임의 정렬 |
| 모바일 입력 | 라벨·영수증 사진 첨부, 바코드 스캔 제품 매칭, 라벨 OCR 폼 자동 채우기 |
| 외부 정보 | 선택한 Naver·Brave·Exa 연결과 등록 소스에서 제품 정보·후기를 탐색하고 출처·판매 조건별로 비교 |
| 관심·가격 감시 | 비보유 관심 대상, 허용된 가격 관측 이력·목표가, 정기 조회와 웹 푸시 각각 동의 |
| 정리·재고 실사 | 구매처 병합 미리보기, 병별 위치·QR·실사, 통계의 결측·집계 근거 |
| 통계 | 기존 엑셀 통계 전부 재현 + 시계열·취향 분석 + 사용자 커스텀 피벗 |
| 오프라인 | PWA 서비스워커 + IndexedDB 로컬 미러, outbox 큐 기반 재동기화 |

## 문서

| 문서 | 용도 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 시스템 아키텍처, 데이터 모델, API·동기화 규약, 배포 토폴로지, 기술 선택 근거 |
| [docs/operations.md](docs/operations.md) | **운영 가이드** — `.env` 변수 레퍼런스, 로컬 개발 환경, 프로덕션 재배포 절차, 백업, 트러블슈팅 |
| [docs/plan.md](docs/plan.md) | 작업 계획과 진행 현황. **작업을 재개할 때 여기부터 읽는다** |
| [docs/legacy-schema.md](docs/legacy-schema.md) | 기존 엑셀 시트 실측 분석과 임포트 매핑 규칙 |
| [AGENTS.md](AGENTS.md) | 개발 관례, 커밋·브랜치 규칙, 품질 게이트 |

## 기술 스택

- **백엔드** Python 3.14, FastAPI, SQLAlchemy 2.0, Alembic, Pydantic v2, uv
- **데이터베이스** PostgreSQL (`pg_trgm` 한글 부분 문자열 검색)
- **프론트엔드** React, Vite, TypeScript, TanStack Query, Tailwind CSS, Dexie, Workbox
- **인프라** Docker Compose, Tailscale HTTPS, GitHub Actions, GHCR

## 개발 환경

```bash
make install      # 의존성 설치 + git 훅 활성화
make db-local-setup # 격리 PostgreSQL 설치·기동 (최초 1회)
make db-local-start # 이후 작업 재개
make migrate
make api          # 다른 터미널에서 make web
make check        # lint·typecheck·test·secret scan
make help         # 전체 명령 목록
```

**이미 이 저장소를 `docker compose up -d` 로 운영 배포해 둔 기기에서는 `make db-up` 을
쓰지 않는다** — `docker-compose.yml` 의 `db` 서비스가 그 운영 배포와 같은 컨테이너·같은
실사용자 데이터라서, 개발용으로 별도로 뜨는 게 아니라 운영 DB에 그대로 연결된다. 이
경우엔 [docs/operations.md](docs/operations.md) §2 의 격리된 개발용 DB(`scripts/dev-db.sh`)
를 쓴다. 그 외 항목(`.env` 변수 의미, 프로덕션 재배포 절차, 백업, 트러블슈팅)도 전부
그 문서에 있다.

개발 기본 경로는 micromamba 기반의 격리 PostgreSQL 17이다. `make check`에 포함되지 않는
웹 build·migration·추가 CI 검사와 대상 DB 확인은 [docs/development.md](docs/development.md)를
따른다. 운영과 겹치지 않는 API 포트 설정은 [docs/handoff.md](docs/handoff.md) §1을 참조한다.

전체 스택의 Compose 기동·재배포는 [운영 절차](docs/operations.md)를 따른다.

## 개발 현황

현재 구현·수용 검증 범위는 [v1.7.0 마일스톤](https://github.com/jihoon22-lee/SoolJang/milestone/1)이다.
현재 위치와 기존 Task/WP 대응은 [docs/plan.md](docs/plan.md),
작업 진입점은 [v1.7.0 로드맵](docs/roadmap/v1.7.0.md)에서 확인한다.
패키지 버전과 마지막 확인한 배포 버전은 계획 문서에서 구분한다.
국내 가격 2출처의 실제 허용 사례와 기기 푸시 수용은 사용자 결정으로 [#142](https://github.com/jihoon22-lee/SoolJang/issues/142)·[#143](https://github.com/jihoon22-lee/SoolJang/issues/143)에 이연했다. 구현·실연결·
릴리스 상태와 제한은 [수용 원장](docs/plans/v1.7.0/acceptance.md)에서 구분한다.
검색 API 키는 앱의 통합 연결 화면에서 관리하며, 새 탐색은 생성형 답변·요약을 호출하지 않는다.
기존 OCR·선택형 AI 설정은 보존한다. 가격은 같은 규격·통화·판매 조건의 실제 관측끼리 비교한다.

## 라이선스

개인용 비공개 프로젝트. 별도 라이선스를 부여하지 않는다 (All rights reserved).
