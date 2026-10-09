# 실사용 흐름 개선 WP06 — 전체 PWA 수용·1.9.0 준비

같은 제품 아래 용량별로 **무엇이 남았는지**, 전체 이력과 선택 조건에서 **얼마에 샀는지**를
구분한다. 구매·병·시음 링크는 판본·용량·구매 건을 유지한다. 구매 규격과 시음 대상을
정정해도 원본 ID·첨부·QR을 보존하며, 잔량은 명시한 최종값만 적용한다.

2026-10-10 합성 자료로 usage/S01~S20을 수용했다. 이 문서 작성 시 패키지는 **1.9.0**,
운영은 **1.8.2 / schema 0019**다. 원격 CI·태그·백업 복원·운영 배포는 아직 실행 결과를
기록하기 전이며, 아래 브라우저 결과를 운영 실데이터 재현으로 표현하지 않는다.

## 범위와 최종 수정

- 기준 main `a8d21ff`(WP05 #165), 브랜치 `feature/usage-acceptance`. R01~R12,
  WP01~WP05의 부분 검증을 이번 최종 PWA에서 연결했다. 선행 PR은 #162, #163, #164, #165다.
- 정정 폼이 캐시된 원래 병 버전으로 먼저 만들어져 불필요한 409를 내는 문제를 수정했다.
  최초 최신 조회 성공 후 폼을 만들며, 앱의 전역 `staleTime: 30_000`과 무관하게 재열 때
  다시 조회한다. 대상 병·병 없는 시음의 SKU도 새로 확인하고, 과거 캐시를 최초 승인 버전으로
  고정하지 않는다. 작성 도중 바뀐 상태는 자동 승인하지 않고 기존 재확인 절차를 유지한다.
- 홈 최근 시음이 같은 날의 오래된 5건을 먼저 보여주던 정렬을 날짜·ID 내림차순으로 고쳤다.
  전체 시음 이력의 소유권·유효 부모 조회를 재사용해 삭제된 구매·병의 시음을 숨기고 원본은
  남긴다. 새로 저장한 시음에서 해당 SKU·병·시음으로 이동하는 흐름을 다시 확인했다.
- Python/웹/락 파일의 버전을 1.9.0으로 일치시켰다. 의존성은 바꾸지 않았다.
  README·architecture·development·plan에 현재 집계·필터·정정·수용 계약을 반영했다.
- schema 0020은 WP01에서 추가한 `bottle.revision`이다. 이번 PR에서 DB 구조를 추가 변경하지
  않는다. 파생 가격을 DB에 저장하거나 실제 기록을 fixture로 옮기지 않았다.

## 환경과 증거 경계

- 격리 PostgreSQL `127.0.0.1:54329/sooljang_usage_acceptance_20261010`, API 8213,
  최종 PWA 5177. 서비스워커 업그레이드만 별도 프리뷰 5178을 사용했다. 운영 Compose는
  개발 검증에 사용하지 않았다.
- 첫 계정은 초기 설정 UI로 생성했다. 계정 전환·독립 합계용 빈 계정만 `create_user`로
  준비했다. 제품·SKU·구매·시음·분할·정정의 입력 흐름은 UI로 수행했다.
- G04의 개봉·잔량 미기록은 UI로 만든 병 한 행을 합성 legacy 상태로 준비했다. S17도
  지정한 BOUNDARY 제품 한 행만 parent-only tombstone으로 준비했다. 나머지 자식 원본을
  변경하지 않았다. 시음 첨부는 기존 업로더 UI가 없어 합성 1px PNG만 인증 API로 준비했다.
- 바코드 판독·카메라 stream·바코드 응답, 외부 가격 응답은 경계 mock이다. 실제 UI의 규격
  선택·바코드 연결·가격 표시·구매 저장을 확인했으며 유료 호출과 실제 소스 수집은 하지 않았다.
- 저장 지연은 IndexedDB 잠금 또는 실제 서버 응답 전달 지연이다. 응답 유실은 서버 commit을
  확인한 뒤 브라우저 전달만 실패시켰다. 미실행 명령을 성공 응답으로 꾸미지 않았다.
- Chromium에서 360/390/768/1440px를 실제 조작하고 스크린샷도 확인했다. 모바일 실기기,
  실제 카메라, 푸시 수신 수용은 별개이며 기존 #142·#143 이연을 유지한다.
- 최초 실패 보고서·스크린샷은 남겨 두고 원인별로 재검증했다. 화면의 비동기 로딩, 펼침 상태,
  실제 API 경로, 동일 이름의 여러 버튼, 재확인 필요 상태를 잘못 가정한 스크립트 오류를
  앱 결함으로 세지 않았다. 실제 발견한 두 동작 문제는 위 수정과 회귀 테스트로 해결했다.

## usage/S01~S20 결과

| 수용 | 실제 결과와 독립 기대값 | 주요 원본 증거 |
|---|---|---|
| S01 | UI 생성 G01: 750ml 재고 1/미개봉 1, 500ml 지난 규격/재고 0. 전체 평균 20,000원, 재고 원가 30,000원. 선택 SKU와 병 일치 | `wp06-core-artifacts/report.json` |
| S02 | 역순 등록의 두 규격 재고 40,000원→500ml만 10,000원→전체 소진 0원. 현재 규격 우선·지난 규격 표시 | core |
| S03 | 단일 SKU, 구매 없는 SKU의 가격 null, 0원 구매, 개봉 잔량 미기록을 구분 | core |
| S04 | UI 2병 구매를 1+1로 분할. 두 병 번호가 모두 1이 돼도 UUID·QR 문자열·시음 ID/대상 보존, 구매 맥락별 재선택 | core, 최초 분할 실행 로그와 후속 표시 확인 연결 |
| S05 | 빈 제품 첫 SKU와 기존 제품 두 번째 SKU 추가, 수량·날짜·구매처·가격 초안 유지. 같은 용량은 기존 SKU 재사용 | `wp06-registration-artifacts/report.json` |
| S06 | 매장 등록 후보에서 2021 판본 선택→기존 SKU로 재구매. 2020 제품 병수 불변 | registration |
| S07 | 미확인 바코드는 명시적 SKU 연결 후 이동. 이후 로컬 750ml 결과→매장 평균 10,500원→12,000원 구매 추가, 같은 SKU의 3병 평균 11,000원 | registration, `wp06-navigation-artifacts/report.json` |
| S08 | 같은 이름의 2020/2021 후보 구분, 빠른 시음에서 2021 선택·저장. 2020 시음 0건, 실제 선택한 병만 30ml 차감 | navigation |
| S09 | 개봉 후 시음이 있는 병 취소 거부, 다른 병 변경은 허용. 일괄 취소 결과 적용 1/거부 1 | `wp06-safety-browser-artifacts/aggregate-report.json` |
| S10 | 상세·빠른 시음의 실제 저장 경합, 구매 수정의 commit 후 응답 지연 동안 새 입력·접기·이동 보호. 실패 재시도 | safety |
| S11 | G09 A450/B750→같은 시음·첨부로 A500/B700. 기록만 이동·분리·재연결은 현재 잔량 유지. A/B 각각 동시 변경 시 전체 정정 무변경. commit 응답 유실 뒤 동일 request ID 재확인, 삭제도 잔량 700ml 유지 | `wp06-correction-complete-artifacts/report.json`의 초기 단계 + `wp06-correction-remaining-artifacts/report.json`, safety |
| S12 | G05 70,000/3×재고2=46,666.67원, 표시 46,667원. 독립 계정 합계 재고6병/구매10병/실구매170,000원/원가96,666.67원, 홈·통계·API·CSV·offline reload 일치 | core |
| S13 | 매장 모드 G08 750ml 최근·최저·평균 24,000원, 같은 규격 제안 대비 0%. 0원/미구매는 비율 비교 불가, 다른 용량에는 같은 SKU 비율 없음 | `wp06-store-comparison-artifacts/report.json`, 상세 비교 별도 report |
| S14 | A매장+2026 불일치를 재고 없음으로 재포함하지 않음. 무필터 A→B, 750ml/재고 조건 B→A. 조건 평균/전체 원가 구분. 숨은 선택 B는 일괄 동작 제외. 맞는 A매장/2026/750ml 구매 추가 후 조건가25,000원·전체 원가49,000원 | registration |
| S15 | UI 시음 53건: 첫 50+선택 고정 1, 이어 보기 53건. 다음 페이지 503에서도 읽은 51건 유지 후 복구. 기간 조건 1+고정1, offline 조회. 홈 최근 링크는 정확한 시음 ID로 이동 | correction remaining, navigation |
| S16 | 미개봉·개봉·소진·증여·판매·삭제 병 6개를 500→750ml로 이동, ID/상태/날짜/잔량/삭제 보존. 연결 시음만 SKU 이동, standalone·다른 구매 불변. 원가40,000→35,000원. 가격·병수 재수정 때 삭제 병 부활 없이 새7번 생성. 구매 삭제 후 독립 기록·다른 구매 유지 | `/tmp/wp06-purchase-states-aggregate-report.json` |
| S17 | UI 500ml 병에 30ml 시음→470ml. 전역 250ml 축소·삭제 각각409, 원본 행 동일. parent-only 삭제 후 API/온라인/offline reload/홈에서 숨김, 자식·470ml 원본 보존 | `wp06-boundaries-summary.json` |
| S18 | SW 제어 offline reload의 초안·outbox 보존, reconnect 후 동일 명령 한 번만 반영. 실제 v1.8.2 SW→1.9.0 전환에서 dirty 폼은 업데이트 차단, 닫은 뒤 큐/17ml 초안 보존, 대기25ml 시음 한 번 반영해675ml, 새 SW offline reload도 보존 | safety, `wp06-upgrade-artifacts/report.json` |
| S19 | 별도 로그인 context 수정409/삭제404/분할404. 지연 응답 중 계정 변경은403/404, 새 계정 미러·초안에 원계정 값 적용 없음 | safety |
| S20 | 네 화면 폭에서 용량·병 선택→reload→목록 필터 복원, 정정 폼 조작·표시. UI로 만든35개 목록의 확장 범위·정렬·내부 스크롤을 상세 reload/뒤로가기 후 복원(현재 최대 스크롤로 clamp) | registration, correction remaining, navigation |

표의 상대 파일은 `/tmp/sooljang-usage/` 아래 실행 원본이다. 공개 PR에는 아래처럼 합성 결과만
요약한다. 자동 생성 이미지·실제 개인 자료·백업·자격증명은 저장소에 넣지 않는다.

```text
usage/S11 same_tasting=true same_attachment=true A=500 B=700 retry_same_request=true
usage/S12 G01_cost=30000.00 G05_cost=46666.67 account_cost=96666.67
usage/S16 preserved_states=unopened,open,finished,gifted,sold,deleted
usage/S18 old_PWA=1.8.2 new_PWA=1.9.0 queued_tasting_count=1 remaining_ml=675 draft_ml=17
usage/S20 widths=360,390,768,1440 expanded_rows=35 scroll_restored=true
```

## 검사·리뷰

| 검사 | 결과 |
|---|---|
| Ruff check / format | 통과, 319개 Python 파일 포맷 유지 |
| `ty check` | 통과 |
| `npm --prefix web run check` | 포맷·린트·타입·웹944개/90파일·빌드 통과, branch82.89% |
| 버전 일치·secret scan·diff check | 통과, 1.9.0 |
| Python 전체 | Python 동작 코드는 WP05와 동일. 해당 로컬 전체1,559개/opt-in skip30/92.11% 및 #165 CI 통과 근거를 유지. WP06 CI 결과는 이후 기록 |
| 독립 검토 | 정정 폼의 전역 캐시30초 회귀를 지적받아 강제 최신 조회와 실제 전역 설정을 쓰는 테스트로 보완. API/audit 문서 누락도 수정. 최근 시음 live chain·원가·버전 구분 재검토 |
| 릴리스 프로브 | 읽기 전용 원본 해시·독립 SKU 원가·커서/맥락 조회 프로브를 합성 DB에서 먼저 실행해 통과. 운영/복원본 검증은 아직 아님 |

최종 웹 로그: `/tmp/sooljang-usage/wp06-web-accepted.log`. 앞선 941/943개 검사는 중간 수정의
결과이며 최종 수치로 혼합하지 않는다. 최초 조회·재시도·대상 병 캐시·같은 날 정렬·삭제 부모
숨김을 회귀 테스트로 덮었다. DB를 초기화하는 테스트는 병렬 실행하지 않았다.

## 통합·릴리스 상태

- WP06 review 가능한 PR 생성·원격 CI·merge commit 통합: 대기.
- 태그 전 운영 쓰기 중지/전체 백업/별도 빈 DB 복원/0019→0020 리허설: 대기.
- v1.9.0 태그·Release workflow·GHCR 이미지·실제 운영 전환·보존 확인: 대기.
- 릴리스 후 실제 버전·schema·원본/암호문/파일 보존·PWA 확인을 별도 릴리스 기록에 남긴다.
