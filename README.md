# 술장 (SoolJang)

개인 주류 컬렉션을 기록·관리·분석하는 웹 플랫폼. 위스키, 브랜디, 와인, 사케, 맥주,
전통주, 백주 등 주종에 상관없이 **제품 → 규격 → 구매 건 → 개별 병 → 시음 세션** 계층으로
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
| 기록 | 제품 아래 용량별 재고·가격, 구매 건·개별 병·시음 맥락. 두 번째 용량 등록·재구매와 50건을 넘는 시음 탐색 |
| 빠른 기록·정정 | 홈의 "오늘 마셨어요", 지연 저장의 새 초안 보호, 후속 기록을 보존하는 조건부 실행 취소. 구매 규격·시음 대상·양의 명시적 정정 |
| 파생 지표 | 평단가, 실평단가, 100ml당 가격, 구매/소비/재고/미개봉/개봉 병수, 할인율, 재고 자산가치, 용량별 지표 |
| 검색 | 한글 부분 문자열 검색, 같은 구매 건의 용량·구매처·날짜·재고 필터, 조건별 가격 정렬과 전체/조건 지표 CSV |
| 모바일 입력 | 라벨·영수증 사진 첨부, 바코드 스캔 제품 매칭, 라벨 OCR 폼 자동 채우기 |
| 외부 정보 | 선택한 Naver·Brave·Exa 연결과 등록 소스에서 제품 정보·후기를 탐색하고 출처·판매 조건별로 비교 |
| 관심·가격 감시 | 비보유 관심 대상, 허용된 가격 관측 이력·목표가, 정기 조회와 웹 푸시 각각 동의 |
| 정리·재고 실사 | 구매처 병합 미리보기, 병별 위치·QR·연속 스캔 실사와 관찰 위치 정정, 개봉 후 오래된 병 알림, 병·구매 변경 이력 |
| 통계 | 기존 엑셀 통계 전부 재현 + 시계열·취향 분석 + 사용자 커스텀 피벗 |
| 오프라인 | PWA 서비스워커 + 계정별 IndexedDB, 즉시 로컬 저장과 재동기화, 대기열 확인·재시도, 소유자 미확인 기록의 원본 격리 보관 |

## 문서

| 문서 | 용도 |
|---|---|
| [docs/plan.md](docs/plan.md) | 현재 위치·진행 중인 마일스톤·최근 결정. **작업을 재개할 때 여기부터 읽는다** |
| [docs/development.md](docs/development.md) | 개발 환경·앱 실행·변경별 검사 선택·검증 증거·자주 겪는 함정 |
| [docs/architecture.md](docs/architecture.md) | 시스템 구조, 데이터 모델, API 목록, 동기화 규약, 배포 토폴로지 |
| [docs/external-data.md](docs/external-data.md) | 외부 소스·통합 연결·탐색·관심·가격 감시의 동작과 안전 경계 |
| [docs/operations.md](docs/operations.md) | 운영 가이드 — `.env` 변수, 배포·마이그레이션·백업·복구, Tailscale, 문제 해결 |
| [docs/legacy-schema.md](docs/legacy-schema.md) | 기존 엑셀 시트 실측 분석과 임포트 매핑 규칙 |
| [docs/history.md](docs/history.md) | 릴리스 연표, v1.7 이전 Task 기록, 결정 로그, 정리된 옛 문서 링크 |
| [AGENTS.md](AGENTS.md) | 개발 관례, 커밋·브랜치 규칙, 품질 게이트 |
| [workthrough/](workthrough/) | PR 묶음별 실제 검증 기록 |

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

**운영 배포가 있는 기기에서는 `make db-up`·`docker compose up/down`을 개발에 쓰지 않는다.**
`docker-compose.yml`의 `db`는 실사용자 데이터가 든 운영 DB다. 개발은 micromamba 기반 격리
PostgreSQL 17(`make db-local-*`)을 쓰고, 포트·대상 DB 확인·웹 build·migration 같은 `make check`
밖의 검사는 [docs/development.md](docs/development.md)를 따른다. Compose 기동·재배포·백업은
[docs/operations.md](docs/operations.md)를 따른다.

## 개발 현황

v1.9.0 실사용 흐름 개선을 준비 중이다. 같은 제품의 용량별 재고·가격을 구분하고,
등록→구매→시음→정정을 원본 ID·첨부·QR 연결을 보존하며 이어 수행한다.
재고 원가는 규격별 실평단가에 재고 병수를 곱해 합산한다. 개봉 잔량에 비례한 평가액이 아니다.
구현 스키마는 0020이며 현재 운영은 1.8.2/0019다. 최종 수용·릴리스·운영 반영은 실제 완료 후 갱신한다.
진행 상태는 [docs/plan.md](docs/plan.md), 실제 검증과 배포 결과는
[workthrough/](workthrough/), 게시한 릴리스는
[Releases](https://github.com/jihoon22-lee/SoolJang/releases)에서 확인한다.

국내 가격 2출처의 실제 허용 사례와 실기기 푸시 수용은 사용자 결정으로
[#142](https://github.com/jihoon22-lee/SoolJang/issues/142)·[#143](https://github.com/jihoon22-lee/SoolJang/issues/143)에
이연돼 있다. 검색 API 키는 앱의 통합 연결 화면에서 관리하며, 새 탐색은 생성형 답변·요약을
호출하지 않는다.

## 라이선스

개인용 비공개 프로젝트. 별도 라이선스를 부여하지 않는다 (All rights reserved).
