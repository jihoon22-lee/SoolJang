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
| 외부 정보 | 사용자가 등록한 소스에서 평점·시세·후기를 온디맨드 조회하고 출처와 함께 보관 |
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
make db-up        # PostgreSQL 기동 (Docker, 이 저장소 전용 새 환경일 때만 — 아래 경고 참조)
make migrate
make api          # 다른 터미널에서 make web
make check        # CI 와 동일한 전체 검증
make help         # 전체 명령 목록
```

**이미 이 저장소를 `docker compose up -d` 로 운영 배포해 둔 기기에서는 `make db-up` 을
쓰지 않는다** — `docker-compose.yml` 의 `db` 서비스가 그 운영 배포와 같은 컨테이너·같은
실사용자 데이터라서, 개발용으로 별도로 뜨는 게 아니라 운영 DB에 그대로 연결된다. 이
경우엔 [docs/operations.md](docs/operations.md) §2 의 격리된 개발용 DB(`scripts/dev-db.sh`)
를 쓴다. 그 외 항목(`.env` 변수 의미, 프로덕션 재배포 절차, 백업, 트러블슈팅)도 전부
그 문서에 있다.

Docker 를 쓸 수 없는 환경에서는 `make db-local-setup` → `make db-local-start` 로 폴백한다.
micromamba 로 홈 디렉토리에 PostgreSQL 17 을 설치해 root 없이 실행한다.

전체 스택을 컨테이너로 띄우려면 `.env` 에 `POSTGRES_PASSWORD` 를 채운 뒤
`docker compose up -d --build` 를 실행하고 `http://127.0.0.1:8080` 으로 접속한다.

## 개발 현황

현재 [`v1.6.0`](https://github.com/jihoon22-lee/SoolJang/releases/tag/v1.6.0)을 운영 중이다.
완료된 Task와 향후 선택 사항은 [docs/plan.md](docs/plan.md)의 "현재 위치" 절에서 확인한다.

## 라이선스

개인용 비공개 프로젝트. 별도 라이선스를 부여하지 않는다 (All rights reserved).
