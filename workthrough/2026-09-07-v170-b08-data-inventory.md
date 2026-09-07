# v1.7.0 B08 — 데이터 품질·관심 구매 전환·보관·실사

WP11 #129 / WP12 #130. 정리할 기록과 영향부터 확인하고, 관심 기록은 실제 구매 전환을
확정할 때만 재고·지출로 연결한다. 기존 제품·규격 자동 병합은 추가하지 않았다.

## 변경과 경계

- 데이터 품질 화면은 이름·주종·구매처·가격 누락, 규격 미등록, 이름 정규화가 같은 중복
  후보를 보여 준다. 제품 상세로 이동해 근거 기록을 확인한다. 통계 화면에서도 로컬
  Dexie 기준 가격 포함 건수와 누락 제품을 확인할 수 있으며 기존 계산·오프라인 조회는 유지한다.
- 구매처 병합과 제한된 제품 주종/구매처 일괄 변경은 `CleanupPreview`에 선택·영향을
  저장하고 확정 시 소유권·수정 시각·참조를 다시 읽는다. 구매처 이름, 구매 건수·병수,
  확인된 구매 합계·가격 미상 건수를 보여 주며 전체 변경을 한 트랜잭션으로 저장한다.
  같은 미리보기 재확정은 멱등이다. 기존 `/vendors/{id}:merge`도 미리보기 식별자를 요구한다.
  영향 기록에는 URL·노트·외부 원문·자격증명을 넣지 않는다.
- B05의 공유 `Interest`/CRUD와 `request_id` 계약을 사용한다. 관심 목록·노트·비교·보관·복원을
  제공하며 입력 draft와 노트 작성 시작 revision을 보존한다. 서버 변경을 발견하면 입력을
  유지하고 사용자가 명시적으로 최신 노트를 불러온다.
- 구매 전환은 기존 SKU 또는 새 제품·SKU와 실제 구매를 확정한다. 구매·병 생성과
  `InterestConversion` 영수증 저장은 원자적이다. 응답 유실 재시도와 두 로그인 세션의
  동시 요청은 같은 구매 결과를 반환한다. Interest ID·identity·source_matches와 기존
  관측 참조는 유지하고 연결 제품 ID와 보관 상태를 갱신한다. 추가 구매는 연결 제품에서 기록한다.
- 찬장·선반·상자와 병별 `BottlePlacement`·이동 이력을 추가했다. 기존 `Bottle.storage_location`
  자유 입력은 보존한다. 위치 이름 변경은 ID를 유지하고 삭제는 영향 확인 후 현재 병을
  미지정으로 옮긴다. 과거 위치·이동·실사 참조는 soft delete로 보존한다.
- 내부 QR은 `sooljang:bottle:<uuid>`이며 로그인 토큰이나 제품 바코드가 아니다. 실사 API는
  사용자 소유권·병 존재·현재 재고 상태를 확인한다. 중복 스캔, 미확인 병, 예정 목록 밖의 병,
  위치 불일치, 미등록 발견과 중지·재개·완료를 구분한다. 완료는 병 상태를 변경하지 않는다.
- 정리·관심·보관·실사는 온라인 전용이다. 오프라인 쓰기를 비활성화한다. QR 생성 모듈은
  필요할 때 로딩해 초기 앱 번들을 늘리지 않는다. 물리 카메라·인쇄물 스캔 검증은 별도다.

## 실제 검증

| 검사 | 결과 |
|---|---|
| `uv run ruff check .` / `uv run ruff format --check .` | 통과 |
| `uv run ty check` / `git diff --check` / `bash scripts/scan-secrets.sh` | 통과 |
| 격리 DB 전체 `uv run pytest -q --tb=short` | **1,170 passed / 30 skipped**, Python branch 포함 **92.15%** |
| `npm --prefix web run check` | **50 files / 591 tests passed**, statements 88.37%, branches **80.57%**, functions 83.83%, lines 89.94%; lint·typecheck·build 통과 |
| 0016→0017→0016→0017, 각 upgrade 후 `alembic check` | 통과. 기존 테이블 모든 행을 JSON snapshot으로 비교해 구매·병·시음·관심·출처 고정·가격 관측 보존 확인 |
| Chromium production preview + 실제 격리 API/DB | 위치 이동, QR 이미지 해독, 중복 확인, 중지→reload→재개, 미등록 발견, 완료 후 합계 불변, 병합 preview→confirm, 관심 저장의 합계 제외, 0원 구매 전환, 모바일 품질, offline 쓰기 비활성 확인 |

Python DB는 `127.0.0.1:54329/sooljang_inventory_test`, migration·브라우저 DB는
`sooljang_inventory_browser_test`만 사용했다. API 8221 / preview 5181. 합성 기록만 사용했다.

회귀 근거는 [정리·실사 API 테스트](../tests/api/test_collection_management.py),
[구매 전환·두 세션 동시성 테스트](../tests/api/test_interest_conversion.py),
[관심 UI 테스트](../web/src/pages/InterestsPage.test.tsx),
[위치·실사 UI 테스트](../web/src/pages/InventoryPage.test.tsx)에 있다.
실제 브라우저에서 비동기 저장 전에 controlled select 값이 복구되는 문제를 발견해
이벤트 시점의 선택값을 고정했고, 관찰 가능한 이동 요청 회귀 테스트로 확인했다.

- [마이그레이션 재현 스크립트](assets/v170-b08-migration.py)
- [브라우저 재현 스크립트](assets/v170-b08-browser.cjs) · [결과](assets/v170-b08-browser-results.json)
- [보관·실사 desktop](assets/v170-b08-inventory-desktop.png) · [품질 mobile](assets/v170-b08-quality-mobile.png)
- [내부 병 QR](assets/v170-b08-bottle-qr.png)

## 미실행·통합 메모

실제 레거시 데이터·유료 외부 요청·물리 카메라/인쇄물·운영 복구·배포·릴리스는 실행하지 않았다.
30 skipped는 기존 opt-in 실자료·실연결·성능·복구 검사이며 통과로 간주하지 않는다.
Vite의 기존 500KB chunk 경고는 남아 있다. 관리 화면 추가로 모바일 주 메뉴가 길어져
B05/B07 화면 통합 때 관리 항목을 보조 메뉴로 묶을 필요가 있다.

공유 기반은 B05 `1981c0e`와 B06을 합친 로컬 merge `612bf7a`이다. B08 migration
`0017_data_inventory`의 선행은 `0016_discovery_interest`이며 Interest 테이블을 중복 생성하지 않는다.
`docs/plan.md`·PR·원격 push는 주 담당자가 통합한다. 기반 B06의 합성 키 fixture에
이미 `f33c94c`에 반영된 스캔 허용 주석을 동일하게 반영해 기존 false positive를 해소했다.

주 담당 검토에서 구매처 병합(Vendor→Purchase)과 온라인/동기화 구매 수정(Purchase→Vendor)의 잠금 순서 역전을 확인해 같은 순서로 통일했다. 반대 방향 병합은 두 구매처를 UUID 순서로 잠그고 일괄 구매처 수정도 대상 구매처를 먼저 잠근다. 서로 다른 로그인 세션을 사용한 실제 DB 동시 병합/수정 2개와 정리·관심 전환·구매 회귀를 합쳐 **32 passed**. Ruff·ty 통과.
