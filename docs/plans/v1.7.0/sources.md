# v1.7.0 B01 / WP01 외부 소스 실현 가능성 조사

확인일: **2026-09-07 (KST)**. 조사 범위: #119의 모든 후보, 공개 공식 문서·이용약관·robots와 소량 공개 응답 구조. 기존 운영 키·설정·소비 기록을 읽지 않았고 가입·키 발급·유료 계약·로그인·접근 제한 우회·메시지 발송·대량 수집은 하지 않았다. 이 문서는 구현/사용자 화면 수용 결과가 아니다.

## 먼저 반영할 결정

1. **NAVER의 기존 쇼핑 검색 API는 현재 지원으로 계획하면 안 된다.** 2026-07-31 시행 약관은 Developers의 신규 Search 신청 종료와 API HUB 이관, 기존 검색 이용자의 2027-06-30까지 유예를 명시한다. 그러나 쇼핑·책·학술정보는 2026-07-31 종료로 유예 대상에서도 제외된다. 새 API HUB 공식 목록에도 쇼핑 상품 검색은 없으며 Shopping Insight는 클릭 추이 API다. 기존 shopping.md의 25,000회/일 설명은 현행 제공 여부의 근거가 아니다. [약관 부칙](https://developers.naver.com/products/intro/terms/terms.md), [이관 공지](https://developers.naver.com/notice/article/32530), [API HUB 목록](https://api.ncloud-docs.com/docs/naver-api-hub-overview)
2. **데일리샷 복수 판매 후보는 기술적으로 가능성을 확인했다.** 공개 검색 1페이지에서 같은 `top_product_id` 아래 서로 다른 `seller_id`를 가진 복수 `id`를 확인했다. `product_id`로 결과를 하나만 남기는 구현은 판매 후보를 잃는다. 다만 지점·지역·세금·쿠폰·픽업·전수 완전성 및 앱에서의 저장/표시는 미검증이다.
3. **데일리샷+키햐는 서로 다른 가격 원문 도메인 후보지만, 허용된 앱 가격 관측 두 곳을 확보했다고 기록할 수 없다.** 두 사이트 약관 모두 제휴 정보·사진·리뷰 등 게시물의 동의 없는 영리/비영리 사용을 제한한다. 공개 접근 가능성과 재표시/보관 권리는 별도다. 원문 재사용 범위 확인이나 계약 근거가 필요하다. 사용자 작업 승인만으로 공급자의 권리가 생기지 않는다.
4. **검색 결과·본문·가격 관측의 보관 정책을 분리한다.** Brave는 결과 전체/일부 저장에 저장 권리를 명시한 요금제가 필요하고, Untappd 기본 API는 24시간 캐시 삭제·맥주 DB 구축/분석 금지가 있다. 모든 소스에 공통 장기 retention을 적용하면 안 된다.
5. **비생성 요청을 명시적으로 제한한다.** Brave `/web/search`의 `web` 결과만 사용하고 summarizer/Answers를 호출하지 않는다. Exa `/search`의 `instant`/`fast`/`auto`만 허용하며 `deep-lite`/`deep`/`deep-reasoning`, `outputSchema`, `systemPrompt`, `contents.summary`, Answer/Research는 차단한다. 현재 Exa는 모든 type에 `outputSchema`를 넣으면 합성 출력이 추가된다고 문서화한다. [Brave API](https://api-dashboard.search.brave.com/api-reference/web/search/get), [Exa API](https://exa.ai/docs/reference/search)

## 소스 원장

모든 행의 확인일은 2026-09-07이다. `조건부`는 공개 문서/접근 경로가 있지만 credential·이용 범위·실연결 검증 중 남은 조건이 있다는 뜻이다. `검색 발견만`은 자동 취득과 가격 관측 수용을 뜻하지 않는다. robots 200은 데이터 보관·재배포 허가로 해석하지 않는다.

| ID / 역할 | 공식 자료·정책 | 상태·credential / 계약 | 지원 범위·실제 검증 | 제한·다음 행동 |
|---|---|---|---|---|
| SEARCH-NAVER / 한국어 발견 | [현행 약관](https://developers.naver.com/products/intro/terms/terms.md), [API HUB](https://api.ncloud-docs.com/docs/naver-api-hub-overview), [등록/한도](https://guide.ncloud-docs.com/docs/apihub-application), [웹문서 endpoint](https://api.ncloud-docs.com/docs/naver-api-hub-search-webkr) | **조건부**; 신규는 NCP API HUB Client ID/Secret. 기존 Developers 키는 별도 레거시 방식. 쇼핑 상품 검색은 **미지원(종료)** | 블로그·웹·카페글·이미지·뉴스·백과·지식iN 등의 검색 URL/발췌. 공식 문서만 확인, 키/실호출 없음 | API HUB 호스트 `naverapihub.apigw.ntruss.com`, `/search/v1/webkr`, 인증 `X-NCP-APIGW-API-KEY-ID`/`X-NCP-APIGW-API-KEY`. 최신 신청 가이드는 월 통합 775,000건, 일부 endpoint 문서는 여전히 일 25,000건으로 불일치하므로 계약/콘솔 상한을 우선하고 앱에는 낮은 상한을 둔다. 검색 특약 2.1 결과 독립 표시·내용/URL 임의 변경 금지. 원문 권리/retention 별도 검토. |
| SEARCH-BRAVE / 국내외 발견 | [Web Search](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started), [API 필드](https://api-dashboard.search.brave.com/api-reference/web/search/get), [저장 권리 FAQ](https://brave.com/search/api/) | **조건부**; `X-Subscription-Token`, 사용 플랜·저장 권리 확인 필요 | URL·title·description·추가 발췌, language/country/domain 검색. 문서 확인만, 직접 인증 호출 없음 | 1회 max 20/offset max 9, 결과 중복 가능. 같은 원문을 독립 소스로 중복 집계하지 않는다. 원문 크롤 권리를 검색 API가 대체하지 않는다. 요금·quota는 실제 선택 플랜 기준. |
| SEARCH-EXA / 검색·Contents | [Search](https://exa.ai/docs/reference/search), [이용약관 PDF](https://exa.ai/assets/Exa_Labs_Terms_of_Service.pdf/), [개인정보 정책](https://exa.ai/privacy-policy) | **조건부**; `x-api-key` 또는 Bearer, 사용 계약·한도 확인 | URL·제목·작성일 및 선택 text/highlights. 공식 문서만 확인, 앱 키로 호출 없음 | Search type과 synthesis 필드를 위 결정대로 제한. 기존 `keyword` type은 현재 enum에 없으므로 예전 SDK 예제를 그대로 사용하지 않는다. 제3자 자료의 권리·완전성은 보장하지 않음; API 입력에 개인 소비 이력 포함 금지. Contents 장기 보관은 원문 권리/계약 확인 후. |
| RETAIL-DAILYSHOT / 가격·판매·자료 | [공식 서비스](https://dailyshot.co/), [약관](https://team.dailyshot.co.kr/termsofuse), [web robots](https://dailyshot.co/robots.txt), [API robots](https://api.dailyshot.co/robots.txt), [기존 공개 검색 경로](https://api.dailyshot.co/items/search/?q=balvenie%2012) | **조건부**; 검색은 무인증 200 확인. 공식 개발자 API 계약/공개 재사용 라이선스 미확인 | 검색 8개 결과/6 product 그룹, 같은 product 복수 seller 확인. 상세 증거는 아래. 국내외 위스키·와인·사케·맥주·전통주와 픽업/직구/택배 등 공식 안내 | 약관 23조(1)(12) 게시물 무동의 영리/비영리 사용 제한. `price`를 모든 지점의 무조건 실판매가로 표시하지 않는다. `seller_id`와 지점 ID 동일시 금지. 복수 판매·지점 조건 수용에 필요한 데이터 권리·상세 경로 확인 필요. |
| RETAIL-KIHYA / 두 번째 가격 후보 | [공식 홈](https://m.kihya.com/), [약관](https://m.kihya.com/service/agreement.php), [robots](https://m.kihya.com/robots.txt) | **조건부**; 공개 상품명·규격·가격 읽기 가능, 공개 개발 API/재사용 계약 미확인 | 홈 공개 HTML에서 일반가/할인가, 용량, 세트, 세금 포함·해외직구·국내픽업 등 구분 확인. 앱 자동 파싱/매칭/보관 미검증 | 약관 19조(1)(12) 게시물 무동의 영리/비영리 사용 제한. robots `/pickup/`, `/connect/`, `/module/` 등 금지; 매장 조회 우회 금지. 국내 사업자의 해외직구 가격을 국내 재고 가격과 구분. 독립 도메인 두 번째 후보이나 수용 전 권리 확인 필요. |
| RETAIL-EMART / 가격 후보 | [공식 앱 이벤트](https://eapp.emart.com/news/event/progress_list_renew.do?eventTp=E), [robots](https://eapp.emart.com/robots.txt) | **검색 발견만**; 일반 UA robots 전체 금지 | 와인그랩 존재를 공식 자료로 확인. 가격 API·지점 가격·재고 실검증 없음 | `smartOrder`는 허용 검색봇에도 금지 경로. 구글 UA 사칭 금지. 앱/계약 경로 또는 사용자가 제공하는 허용된 수동 사실이 필요; 두 번째 자동 가격 소스로 계산하지 않는다. |
| RETAIL-TRADERS / 가격 후보 | [이마트/트레이더스 점포](https://eapp.emart.com/brandbranch/main.do?trcknCode=traders_brandbranch), [traders robots](https://www.traders.co.kr/robots.txt) | **미검증**; 공개 상품 API/보관 조건 미확인 | 공식 점포 분리 안내 확인. traders robots 요청은 200 HTML을 반환하여 robots 정책으로 해석 불가 | 이마트와 같은 원문/플랫폼을 독립 도메인·독립 공급 데이터로 계산하지 않는다. 점포·회원 할인·기간 구분 필요. |
| RETAIL-COSTCO / 가격 후보 | [공식 홈](https://www.costco.co.kr/), [약관](https://www.costco.co.kr/termsAndConditions), [온라인/매장 차이 명시](https://www.costco.co.kr/FY26P11W2/c/FY26P11W2), [robots](https://www.costco.co.kr/robots.txt) | 자동 수집 경로는 **미지원(서면 허용 없을 때)** / 수동·검색 발견만 | 공식 약관·홈 확인. 주류 SKU 가격·회원 조건·실재고 미검증. robots GET 200이 HTML이라 유효 규칙 확인 실패 | 약관 17조는 상품 목록/설명 취합, 봇/데이터 취합·발췌 등을 제한하며 권리의 서면 허용 요구. 온라인 상품 가격과 매장 가격 차이 가능성 명시. 회원 가격을 일반가로 표시 금지. |
| RETAIL-CU / 지점·재고 후보 | [공식 CU](https://cu.bgfretail.com/), [BGF 포켓CU 설명](https://www.bgfretail.com/eng/), [robots](https://cu.bgfretail.com/robots.txt) | **검색 발견만** / API·허용 범위 **미검증** | 포켓CU의 매장 재고/픽업 기능 존재만 확인. robots 404. 주류 endpoint·매장 재고 실검증 없음 | 404는 API 권리나 완전성 보장이 아니다. 데일리샷 CU offer는 판매 채널이 CU여도 원문 도메인이 데일리샷이므로 독립 원문 두 번째로 세지 않는다. |
| RETAIL-GS25 / 지점·주류 후보 | [공식 와인25플러스 설명](https://www.gsretail.com/media/gsr-magazine-view?magazineId=8798419606985), [GS25 robots](https://gs25.gsretail.com/robots.txt) | **검색 발견만** / 공개 API·retention **미검증** | 공식 O4O 주류 예약 서비스·지점 기반 설명 확인. 가격/개별 상품/재고 실조회 없음; robots는 HTML 응답 | 오래된 출시 설명을 현 가격·한도 근거로 쓰지 않는다. 우리동네GS 앱의 비공개 endpoint를 역공학·자동화하지 않는다. |
| RETAIL-EMART24 / 지점·주류 후보 | [공식 사이트](https://www.emart24.co.kr/), [공식 점포 지도](https://everse.emart24.co.kr/store), [robots](https://www.emart24.co.kr/robots.txt), [데일리샷 안내](https://dailyshot.co/) | **검색 발견만** / API·재사용 범위 **미검증** | 매장 지도·데일리샷 오늘/예약 픽업 지원 설명 확인. 공식 robots는 가맹 상담 일부만 금지 | 데일리샷 경유 emart24를 새 원문 도메인으로 세지 않는다. 자체 endpoint·가격 추출·실사용 미검증. |
| INFO-WINE21 / 와인·생산자·수입사 | [공식 사이트](https://www.wine21.com/), [회사 소개](https://www.wine21.com/17_company/company_introduction.html), [약관](https://www.wine21.com/16_member/join3.html), [robots](https://www.wine21.com/robots.txt) | **조건부** / 자동 재사용 계약 미확인 | 와인정보·기사·수입사 B2B 네트워크 공식 설명 확인. robots는 일반 / 허용, `/search/`, admin/mypage/pop preview/email 금지 | 가격은 권장가/등록가/실판매가를 확인 전 `retail_offer`로 쓰지 않는다. 저작권·게시물 이용 범위 및 이미지/시음노트 권리 별도. parser/갱신률 미검증. |
| INFO-THESOOL / 전통주·양조장 | [공식 홈](https://thesool.com/front/home/M000000000/index.do), [우리술 찾기](https://thesool.com/front/find/M000000082/list.do), [robots](https://thesool.com/robots.txt), [공식 안내서](https://thesool.com/file/2022_GUIDEBOOK.pdf) | **조건부**, 이미지/공공누리 범위 **미검증** | 브라우징 도구 open 실패했으나 일반 urllib GET은 홈 200/133,714자 확인. robots 일반 UA `/admin/` 금지, Googlebot은 find/list 금지. 메뉴 존재만 확인 | 정부/공공 운영이 모든 이미지·본문의 자유 이용을 뜻하지 않는다. 각 자료의 공공누리 유형·업체 제공 이미지 권리·갱신일 확인 필요. AI 소믈리에 경로는 v1.7 새 탐색에 쓰지 않는다. |
| INFO-OFFICIAL / 제조사·수입사 사실 | [Suntory 공식 제품군](https://www.suntory.com/about/index.html), [공식 주류 FAQ](https://www.suntory.com.tw/suntory/qa-list.php), [약관 예시](https://www.suntoryglobalspirits.com/jp/terms-conditions) | 도메인별 **조건부**; 하나의 일괄 허용 소스가 아님 | 생산자 제공 도수/판본/주종의 보완 경로 확인. 실제 사케·백주·와인·맥주 각 후보 회수/필드 추출은 미검증 | 제품별 공식 도메인·locale·판본·공개 이용조건·이미지 권리를 확인. FAQ의 일반 설명을 특정 SKU의 사실로 합치지 않는다. 로그인/나이확인 우회 금지. |
| REVIEW-WHISKYBASE / 위스키 전문 데이터 | [공식 API](https://www.whiskybase.com/wp/api), [robots](https://www.whiskybase.com/robots.txt) | **조건부(파트너 계약)**; 비계약 스크래핑은 **미지원** | 공식 API가 카탈로그·ratings·retail/auction price·WB IDs 제공한다고 안내. robots 직접 요청 403, 우회 안 함. 계약/실인증 없음 | 공식 안내는 scraping 금지·API만 지원 라이선스 경로라고 명시. 데이터 범위·volume·가격/보관/재표시는 파트너별 협의. 제3자 비공식 Whiskybase API 사용 금지. |
| REVIEW-UNTAPPD / 맥주 정보·평점 | [공식 API docs](https://untappd.com/api/docs), [API 약관](https://untappd.com/terms/api), [일반 약관](https://untappd.com/terms), [robots](https://untappd.com/robots.txt) | **조건부(승인된 credential)**, 신규 접근 자격 **미검증** | beer/brewery·평점 API 문서 확인, 기본 100회/시간/key. tap list는 Public API 미지원. 실제 등록/실인증 없음 | Client ID/Secret 쿼리 인자를 로그에서 제거해야 함. 24시간 캐시 삭제·출처 표시, 자체 맥주 DB 구축/분석 금지. 장기 관측·분석은 별도 계약 없으면 부적합. 문서화되지 않은 앱 API 금지. |
| REVIEW-PUBLISHERS / 독립 리뷰·블로그 | [NAVER 블로그 API](https://developers.naver.com/docs/serviceapi/search/blog/blog.md), [Brave 검색 docs](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started) | **검색 발견만**, 개별 원문은 **미검증** | 검색 발췌와 원문 링크 제공 경로만 검토. 특정 독립 리뷰 본문 추출/저장 검증은 하지 않음 | 작성일·제품/판본 관련성·광고 여부·원문 권리/robots를 후보별 확인. 검색 발췌를 실제 시음 검증이나 새 가격 관측으로 변환하지 않는다. |

## 공개 응답 구조 최소 검증: 데일리샷

환경: 이 저장소 개발 호스트의 Python 3 표준 urllib, `User-Agent: SoolJang-SourceReview/1.0`, 무인증 HTTPS, timeout 15초. 한 검색어의 첫 페이지만 사용, 총 2회 요청(필드 확인 및 복수 판매 집계 확인), 페이지네이션/상세/지점 전수 수집 없음. 원문 body·사진·리뷰·실제 가격 값은 파일로 보관하지 않았다.

- URL: `https://api.dailyshot.co/items/search/?q=balvenie%2012`
- HTTP 200. 응답 최상위: `count`, `next`, `previous`, `results`.
- 반환 결과 8 / total 8 / next 없음. `top_product_id` 6그룹, 한 그룹 item 최대 2개.
- 같은 `top_product_id`에 서로 다른 non-null `seller_id`가 존재함. 8개 모두 seller_id와 price 필드 있음.
- 구조적으로 확인한 관련 필드: `id`, `top_product_id`, `seller_id`, `service_type`, `status`, `price`, `price_usd`, `net_price_usd`, `price_twd`, `item_coupon`, `cart_coupon`, `case_info`, `thumbnail_display_volume`, `expose_service`.
- 판정: **복수 판매 후보 구조 확인**, **상품별/지점별 전체 판매 목록 및 판매조건 완전성 미확인**, **반복 가격 관측·앱 재표시/보관 권리 미확정**, **앱 사용자 화면 미검증**.
- `next=null`은 이 query endpoint의 반환 끝을 뜻할 뿐 전국 지점 재고의 완전성을 증명하지 않는다. `seller_id`를 실제 픽업 지점 ID로 사용하려면 별도 근거가 필요하다.

## 구현 계약에 넣을 영향

- source별 `policy_status`, `policy_checked_at`, `policy_url`, `fetch_allowed`, `display_allowed`, `retention`을 분리한다. `unknown`을 allowed로 승격하지 않는다. unknown/null TTL과 무기한 보관도 분리한다.
- provider credential은 NAVER legacy/NCP HUB 형식을 구별하고 같은 connection에 세로 검색 endpoint quota를 묶는다. API HUB 쇼핑 인사이트를 가격 API처럼 연결하지 않는다.
- `source_document`는 검색 발췌/허용 원문/공식 API 자료를 구분한다. Brave 저장권 미확정이면 응답을 장기 DB 가격 이력으로 넘기지 않는다. Untappd는 허용 출처표시 캐시와 금지된 자체 DB를 분리해야 한다.
- 판매 identity는 `(source_domain, external_product_id, external_offer_id, seller_id, branch_id?, condition_revision)`를 후보 계약으로 사용하되 모르는 값은 null로 둔다. 같은 상품/다른 seller를 하나로 줄이지 않는다.
- 독립성 지표: search providers, original domains, actual sellers, pickup branches, terms/SKU 각각 집계. Dailyshot 내 CU/emart24나 NAVER·Brave·Exa에서 동일 dailyshot URL 발견을 독립 원문 수로 늘리지 않는다.
- 원문 수집 실패/robots 불명·차단/계약 미확정/로그인 필요/미등록/품절을 서로 구분한다. 실패를 price=0 또는 마지막 관측일 갱신으로 처리하지 않는다.

## 필요한 외부 입력과 현재 진행 가능한 것

필수 수용 전체를 면제할 근거는 없다. 다만 아래 미확정 사항과 무관하게 합성 평가셋·계약·네트워크 안전 경계·UI 제한 상태·허용 제공자 어댑터 단위 검증은 계속 구현 가능하다.

1. **데일리샷/키햐 기존 사용 허락 또는 공급 계약의 유무와 범위**: 상품 기본 사실·가격·판매자/지점·이미지·리뷰의 취득/재표시/보관, 요청 한도. 아직 문서가 없다면 사용자가 허가된 범위를 확인하거나 대체 소스/수동 경로에 대한 수용 범위 결정을 해야 한다. 외부 문의는 보내지 않았다.
2. **선택 검색 제공자의 기존 계정·플랜·키 사용 승인**: 값을 채팅/기록에 요구하지 않고 앱의 암호화 설정 경로로 등록·선택한다. NAVER 신규는 API HUB, Brave는 저장권 여부, Exa는 계약/본문 권리 확인. 유료 자동 계약·기존 키 읽기·재발급은 하지 않았다.
3. **Whiskybase/Untappd를 실제 필수로 채택할 경우 접근 계약**: 공식 API 문서가 존재해도 실접근/재표시/보관 수용은 아니다. 미계약이면 링크 발견 상태로 유지한다.
4. **독립 국내 가격 두 곳의 허용된 실제 수용 대상**: 기술 후보는 Dailyshot+Kihya. 허용이 확정되지 않은 현재 이를 완료로 기록하거나 Costco/Emart 앱 수집으로 조용히 대체하면 안 된다.

이 조사의 `실검증`은 공개 접근·응답 구조에 한정된다. 인증 제공자, 원문 필드 매칭 정확도, 복수 판매 화면, 주종별 커버리지/회수율·추출률, 가격 관측 저장, 브라우저 수용, 배포 상태는 모두 아직 이 문서로 검증하지 않았다.
