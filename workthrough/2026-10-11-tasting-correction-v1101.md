# v1.10.1 시음 정정 초안 안전성 핫픽스

## 범위와 상태

- 사용자 승인: 결함 수정·문서 정리·v1.10.1 버전·태그/릴리스·운영 배포.
- 시작 main `9d45ca0fe72f68600278a2d4180b5177083c60de`, clean·원격 동일·열린 PR 없음.
- 브랜치 `feature/tasting-correction-v1101`; 연계 수용은 plan의 Q02/QS02·03·05·17·19·20.
- v1.10.1 / `0021_quality_aliases` 릴리스·운영 배포 완료. 태그·이미지·운영 기준은 `451a86811d9cd7685610be4213ef4145453ef59f`다.

## 결함과 재현

[PR #168 리뷰](https://github.com/jihoon22-lee/SoolJang/pull/168#discussion_r4241539061)의
고급 변경→취소→버전 불변 상태에서 재열기→메모 저장을 실제 React 폼의 Vitest/jsdom
합성 자료로 재현했다. 날짜·시음량·병/SKU·최종 잔량이 함께 제출됐다. `preserve`는 병의
상태·잔량만 보호하며 날짜·양·병 연결 변경은 그대로 남는다. 기존 초안 복원과 일반 편집을
따로 검사했지만 이 조합은 누락됐다. 실제 사용자 피해 발생 여부를 조사한 결과는 아니다.

## 구현·검증 기록

실제 완료한 검사, 브라우저의 관찰 결과, CI/태그/이미지/운영 기준을 아래에 기록했다.
운영 DB는 테스트나 합성 입력에 사용하지 않는다. 스키마·외부 소스·키 변경은 이번 범위가 아니다.

### 동작 변경

- 일반 저장은 평점·메모만 부분 변경하고 `preserve`를 사용한다. 미적용 고급값은 저장 전
  안내대로 초안에서 정리하며 서버 날짜·양·병/SKU·상세 노트·현재 잔량에는 적용하지 않는다.
- 고급 변경은 자동으로 펼치고 접어도 안내를 남긴다. 고급 적용에는 이번 편집의 명시 확인이
  필요하다. 확인은 초안에 저장하지 않으며 입력 변경·재열기 시 다시 확인한다.
- 입력 폐기와 보관 후 닫기를 구분한다. 결과 미확정 요청은 입력·폐기를 잠그고 기존 ID와
  payload를 별도 버튼으로 재확인한다. 일반 저장과 관계없는 고급 대상 조회 실패가 이를 막지 않는다.
- 독립 검토에서 발견한 고급 입력 Enter의 암시적 일반 저장도 차단했다. 계정·초안 버전·
  최신 서버 상태와 outbox 검사는 유지한다. API·DB schema·권한·외부 제공자 계약 변경은 없다.

### 합성 브라우저 수용

격리 PostgreSQL `127.0.0.1:54329/sooljang_hotfix_v1101`, schema 0021, API 8212와 Vite 5175,
합성 계정·제품·500/750ml 두 병으로 Chromium에서 확인했다. 운영 데이터로 쓰기 시험하지 않았다.

| 시나리오 | 관찰 결과 |
|---|---|
| v1.10.0 형식의 날짜·양·병·잔량 초안 복원 | 변경 영역 자동 펼침, 확인 전 고급 적용 비활성 |
| 고급 영역 접기 → 메모만 저장 | 요청 changes는 rating/note만, preserve·final_bottles=[]; 서버 원래 날짜·50ml·500ml 병 유지, 두 병 잔량 450/750ml 보존 |
| 입력 보관 → 닫기 → 새로고침·재열기 | 날짜·양 초안 복원, 고급 확인은 해제 |
| 입력 폐기 → 닫기 → 새로고침·재열기 | 원래 값 복원, 미적용 고급 안내 없음 |
| 고급 확인 후 다시 값 변경 | 확인 해제·적용 비활성; 재확인 후 날짜·100ml·750ml 대상과 최종 500/650ml 적용 |
| 고급 장소 입력에서 Enter → 보관·재열기 | POST 0회, 장소 초안 보존; 360px 가로 넘침·미처리 JS 오류 없음 |
| 서버 성공 후 응답만 중단 → 새로고침·동일 요청 확인 | 입력·폐기 잠금, 원래 요청 재확인 성공, updated_at·병 revision 추가 변경 없음, 초안 정리 |

합성 스크린샷과 상세 로그는 로컬 `output/playwright/v1101-*`,
`/tmp/sooljang-v1101-release/*-browser.log`에 보관한다. 오류 주입의 네트워크 실패와
초기 미로그인 401은 예상된 응답이며 정상 동작의 통과 근거로 사용하지 않는다.
실제 사용자 피해 사례 조사·물리 휴대전화·오래 열린 모든 사용자 PWA는 검사 범위가 아니다.

### 회귀·독립 검토

수정폼 43건 통과. 기존 27건을 새 명시적 적용/재확인 동작으로 유지하고 16건을 추가했다.
초기 결함, 미적용 대상 조회 실패, 늦은 조회와 초안 완료 경합, Enter 암시적 제출,
일반 저장 409 뒤 미적용 병/SKU 404의 실패를 먼저 확인하고 수정 후 통과했다.
독립 읽기 검토의 Enter·충돌 복구 두 지적을 모두 반영했다. 충돌 시 실제 제출 범위는
입력 수정·재열기에도 유지하고 최신 상태 승인 후 해제한다. 고급 정정의 전체 맥락 검사는 유지한다.

Ruff check·format(334 files)·ty·버전 일치·diff 공백 검사 통과. 백엔드 동작은 변경하지 않았다.
첫 전체 웹 검사에서 기존 BottlePanel.pagination의 200건 목록 테스트가 5초 시간 제한에 걸렸다.
동일 코드의 해당 10건 검사와 전체 재검사에서는 통과했다. 시간 제한·커버리지 기준은 변경하지 않았다.
후속 경계 수정마다 관련 검사 후 최종 전체 웹 검사를 다시 수행했다. 원격 전체 Python·migration·
컨테이너 검증은 아래 Quality/Release CI 결과로 구분했다.

### 릴리스·배포 준비

별도 Windows DPAPI 복구 매체의 현재 마스터 키 일치를 평문 파일 없이 메모리에서 확인했다.
최종 merge SHA의 태그 전 새 백업·빈 격리 복원과 전환 직전 새 백업·복원을 각각 수행했다.
배포 도구는 운영 v1.10.0/schema0021, 버전 외 backend/의존성 무변경, 정확한 Release SHA와
이미지를 확인하고 `.env`의 버전만 바꾼다. migration은 실행하지 않는다. 같은 schema의
이전 이미지 복귀는 최신 DB/uploads를 보존하며 오래된 백업으로 운영 데이터를 덮지 않는다.

최종 코드의 `npm --prefix web run check`는 100파일·1,278테스트 통과, statements88.82% /
branches83.04% / functions85.80% / lines90.59%, typecheck·빌드·PWA 생성 통과다.
기존 Biome 권고 18개와 500kB 초과 chunk 안내는 남아 있으며 이번 회귀 실패가 아니다.
최종 독립 재검토에서 두 지적 해소와 추가 blocker 없음(읽기 검토)을 확인했다.
운영 PWA 전환 비교용 비로그인 Chromium에서 기존 1.10.0의 SW 제어·캐시와
`index-ClKtvmvf.js`를 확인해 두었다. 배포 후 새 자산 전환도 아래에 기록했다.

## 최종 릴리스·운영 결과

- [PR #170](https://github.com/jihoon22-lee/SoolJang/pull/170): head `98ebeaf5c16e9298d6b9a9ebeb3afb8b6a72a68c`, [Quality 38148322426](https://github.com/jihoon22-lee/SoolJang/actions/runs/38148322426) 필수 job 성공과 리뷰 재확인 후 merge commit `451a86811d9cd7685610be4213ef4145453ef59f`로 병합했다.
- PR·태그의 Python 검사는 각각 1,708 passed / 31 opt-in skipped, coverage92.26%였다. 웹은 각각 1,278 passed이며 검사 기준을 바꾸지 않았다.
- 같은 merge에 `v1.10.1` 태그를 게시했다. [Release CI 38149372156](https://github.com/jihoon22-lee/SoolJang/actions/runs/38149372156) 성공 후 [정식 Release](https://github.com/jihoon22-lee/SoolJang/releases/tag/v1.10.1)와 API/웹 이미지를 확인했다.
- 태그 전 백업 `sooljang-20261011T145811320772Z-5111799c`와 전환 직전 백업 `sooljang-20261011T151955059490Z-74729486`를 각각 생성·검증하고 빈 격리 DB/uploads에 복원했다. 쿠키 로그인·인증 조회 뒤 임시 변경을 rollback했고 원본 전체 열 해시가 일치했다.
- 새 API 이미지의 READ ONLY 조회 후 운영 DB 전체 해시가 그대로임을 확인한 다음 쓰기를 재개했다. schema0021 유지, migration0회, 기존 DB 컨테이너·DB/uploads 볼륨 유지. `.env`의 버전만 1.10.0→1.10.1로 변경했다.

| 항목 | 실제 확인 |
|---|---|
| 태그/OCI revision | v1.10.1 / `451a86811d9cd7685610be4213ef4145453ef59f` |
| API image digest | `ghcr.io/jihoon22-lee/sooljang-api@sha256:232e71c158c7cd72cb3dd804dd83e60bcdd968178ffff35c2ca6d07baabc8c6d` |
| 웹 image digest | `ghcr.io/jihoon22-lee/sooljang-web@sha256:34496068b876bec6e06bc6b4b6ca2286bfd5eb350e7e687c098a48bbe4629743` |
| API 컨테이너 | `bb8a029c75ca`, 2026-10-12 00:20:20 KST, healthy·restart0 |
| 웹 컨테이너 | `3fc4aaf1cc2c`, 2026-10-12 00:20:26 KST, healthy·restart0 |
| DB | `3a44186161ed`, identity/start/restart·volume 보존 |
| 시작 후 로그 | API·웹의 ERROR/Traceback 표시0 |
| HTTP/자산 | localhost/HTTPS live·ready,1.10.1/schema0021/worker ready; 익명 products401; HTML/JS/SW/manifest 이미지 파일 일치 |
| PWA | 기존 `index-ClKtvmvf.js` → 새 `index-B_WPZb_g.js`; SW 설치 완료 뒤 origin 닫기/재진입, controller·로그인 화면·미처리 JS 오류0 확인. 캐시 삭제 없음 |

운영 쓰기·사용자 비밀번호를 이용한 편집은 하지 않았다. 실제 쿠키 인증은 격리 복원본에서,
운영 조회는 READ ONLY 트랜잭션에서 검증했다. 보존 해시 비교는 writers 재개 전을 경계로 한다.
이후 정상 사용/worker 변경을 데이터 손실로 해석하지 않는다. 이 문서 정리 커밋은 운영 이미지에
다시 배포하지 않는다. 실제 사용자 피해 조사와 물리 휴대전화 검증은 미실행이다.

배포용 로컬 production 번들도 Vite preview4175에서 합성 API8212와 연결해 직접 사용했다.
PWA precache/SW 준비 후 날짜·150ml 고급 초안을 남기고 평점·메모만 저장했을 때, 실제 서버의
원래 날짜·100ml·병·650ml 잔량을 보존했다. 이는 개발 서버 검사와 별도이며 운영 사용자 기록은 쓰지 않았다.

PWA 첫 즉시 재진입은 worker 설치/활성화 전에 이루어져 이전 자산이었다. 설치 완료 후 앱
origin을 닫았다가 다시 진입해 새 자산과 공개 이미지 일치를 확인했다. 즉시 새로고침만으로
항상 업데이트된다고 주장하지 않는다. 두 복원본 모두 인증 조회19개·첨부0개였으며 schema를
포함한44테이블(업무43)의 모든 열을 비교했다. 별도 DPAPI 키도 이번 실행에서 대조했다.
