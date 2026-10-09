# 실사용 리뷰 PR 1 — 저장·계정 보호

- 기준: `9404534`(v1.8.1), `feature/review-sync-ownership`, F1/F2/F3.
- 요구: 실제 오프라인 입력을 즉시 로컬 저장하고 로그아웃 뒤 이전 작업이 다른 계정에 쓰지
  않는다. 이미 깨진 대기열은 원본 보존 후 격리하고 정상 동기화를 재개한다. 구매 분할의
  명시·상속 구매처를 검증하고 타 계정 이름 노출을 차단한다.
- 변경: 세션 고정 mutation·로컬 쓰기 경계, 격리 기록 및 상태 안내, 구매처 소유권 검사.
- 환경: PostgreSQL `127.0.0.1:54329/sooljang_test`, 브라우저 합성 전용 DB와 Chromium.
  운영 DB·버전·배포 변경 없음. API/schema/IndexedDB schema 버전은 기존 그대로다.

## 검증

- `SOOLJANG_ENV_FILE='' SOOLJANG_ENVIRONMENT=test SOOLJANG_DATABASE_URL=…:54329/sooljang_test .venv/bin/pytest -q`: 1,378 passed, 30 opt-in skipped. 전체 커버리지 91.65%.
- 구매/소유권/보관 관련 49개 회귀 통과. 다른 계정·삭제·존재하지 않는 구매처와 상속 참조,
  분할 원자성·기존 잘못된 연결 이름 비노출을 검증했다.
- `npm --prefix web run check`: 729 passed, branch 81.14%, lint·typecheck·build 통과.
  로컬쓰기→계정전환·지연 응답, 격리 원본 보존·동시 실행·
  저장 실패 롤백, 타 계정 내보내기 제한, 전송 중 들어온 의존 명령을 회귀로 검증한다.
- `.venv/bin/ruff check .`, `ruff format --check .`, `ty check`, `bash scripts/scan-secrets.sh`: 통과.
- 실제 Chromium 390px, 합성 데이터 API(8210): 오프라인 제품 두 건 입력 시 즉시
  명령 6건/병 2개 저장 → 그중 원래 결함을 모사한 빈 소유자 명령 3건 주입 →
  오프라인 로그아웃·온라인 재로그인 → pending 0, 원본 보관 1묶음, 정상 제품 1건 전송,
  비정상 제품은 활성 목록에서 제거. 운영 데이터를 사용하지 않았다.

```text
OFFLINE_LOCAL { count: 6, normal: 3 }
QUARANTINE_AND_NORMAL_SYNC { pending: 0, quarantines: 1, normal: 1, invalid: 0 }
```

구현 중 독립 보안 검토에서 원본 내보내기의 foreign row 소유권 우선순위, 전송 중 새 의존
명령, 내보내기 응답 뒤 계정 확인을 추가 보완했다. 실패 receipt 또는 명령 원문을 새 키로
자동 발급하지 않는다. 검증 SHA는 이 기록을 포함한 PR 코드 커밋이다.

## 미실행

실제 모바일 기기·카메라·푸시·외부/유료 서비스 실연결, 운영 복구·배포.

최종 PWA 빌드(5174)에서도 같은 흐름을 재검증했다. "별도로 보관한 기록" 안내와 원본
내보내기 버튼이 표시되고 정상 제품만 전송되는 것을 확인했다.
