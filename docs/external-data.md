# 외부 정보: 소스·연결·탐색·가격 감시

술장이 바깥에서 정보를 가져오는 방식과 그 경계를 정리한다. v1.8.0 코드 기준이며, 설계 과정의
긴 근거는 [history.md](history.md)의 결정 로그(아래 §7 번호)에 남아 있다. 데이터 모델과 API
공통 규약은 [architecture.md](architecture.md), 백업·배포 절차는 [operations.md](operations.md)를
따른다.

## 1. 개요

외부 정보는 모두 **사용자가 버튼을 누를 때만** 조회한다. 예외는 사용자가 대상별로 따로 동의한
가격 감시의 정기 조회 하나다. 대량 백그라운드 수집, 검색엔진 SERP 스크래핑, 생성형 요약은 하지
않는다(D167, D206).

| 기능 | 하는 일 | 주요 코드 |
|---|---|---|
| 외부 소스 레지스트리 | 사이트별 `adapter_spec`(HTML 셀렉터 또는 JSON 경로)으로 검색·상세를 파싱해 가격·평점 등을 가져온다 | `application/external_sources.py`, `infrastructure/external/adapter.py` |
| 통합 연결 | 네이버 API HUB·기존 개발자센터, Brave, Exa, OpenAI(라벨 인식), 데일리샷의 인증 정보·상한·사용 여부를 한 곳에서 관리한다 | `application/provider_connections.py`, `infrastructure/external/providers.py` |
| 탐색(Discovery) | 선택한 검색 연결·전문 소스 최대 4개에서 비생성 자료를 모아 보여 주고, 고른 속성만 제품에 적용한다 | `application/discovery.py`, `discovery_evidence.py`, `infrastructure/external/search.py` |
| 관심(Interest) | 아직 사지 않은 술을 구매·재고와 분리된 UUID로 저장하고, 출처별 고정과 가격 관측을 같은 ID에 묶는다 | `application/interests.py`, `interest_conversion.py` |
| 매칭·후보·고정 | 후보를 점수와 함께 보여 주고, 사용자가 확정한 상품을 소스별로 고정한다 | `infrastructure/external/matching.py`, `external_product_match` |
| 가격 관측·비교 | 실제로 받은 판매 조건별 가격을 관측으로 남기고 판매처·규격별로 비교한다 | `application/external_offers.py`, `infrastructure/external/offers.py` |
| 가격 감시·웹 푸시 | 관심 대상의 특정 판매 조건에 목표가를 걸고, 동의한 경우 정기 조회와 웹 푸시로 알린다 | `application/price_watch.py`, `price_watch_worker.py`, `infrastructure/web_push.py` |

관계는 다음과 같다. **연결**은 인증과 요청 상한을 가진다. **소스**는 파싱 규칙을 가지며 연결에
붙을 수 있다(`external_source.connection_id`). **탐색**은 연결(검색)과 소스(전문 조회)를 함께
부른다. 소스 조회 결과의 판매 조건(offer)이 **제품** 또는 **관심**에 관측으로 쌓이고, **가격
감시**는 관심의 관측 하나를 기준으로 만든다.

## 2. 데이터 경계

### 저장하는 것과 하지 않는 것

| 자료 | 저장 | 비고 |
|---|---|---|
| 검색 결과(제목·URL·발췌) | **안 함** | 응답은 `Cache-Control: no-store`. 발췌는 500자, 제목은 300자로 자른다. 장기 원문 보관 없음 |
| 관심에 선택한 출처 URL | 사용자가 저장할 때 `interest.reference_urls`에 보존 | 제목·발췌·검색 본문은 저장하지 않음; 원문 확인용 |
| 탐색에서 고른 속성 | 사용자가 적용할 때만 제품에 반영 | 서버가 서명한 증거 토큰(15분 유효)과 제품 revision을 함께 확인한다 |
| 소스 조회 캐시 `external_lookup_cache` | 성공하고 `source_url`이 있는 결과만, `ttl_hours`(기본 24시간) 동안 | 스냅샷 버전(`SNAPSHOT_VERSION = 4`)이나 소스 `config_revision`이 다르면 다시 조회한다 |
| 가격 관측 `external_offer`·`external_price_observation` | 소스의 `price_history_allowed`가 켜진 경우만 | 꺼져 있으면 복수 가격은 그 응답에서만 보여 주고 캐시에도 남기지 않는다 |
| 소스 헬스 `external_source_probe` | 소스별 최근 20건 | 실패도 남는 운영 로그. 재계산할 수 없는 1차 사실이라 저장한다(D185) |
| 요청 예약 수 `external_request_usage` | 분 단위 30일, 일 단위 366일 | 질의어나 소비 기록은 담지 않는다 |
| LLM 재판정 로그 `external_llm_rematch_log` | 35일 | 비용 가드 계산용 |

- **관측과 캐시는 다르다.** 관측은 새로 받은 성공 응답에서만 만든다. 캐시 적중, 실패 때 보여 주는
  마지막 관측(last-good)은 새 관측이 아니며 원래 관측 시각을 그대로 표시한다. 실패를 가격 0이나
  관측일 갱신으로 바꾸지 않는다.
- **원통화·원척도를 보존한다.** 가격은 원래 통화 문자열로, 평점은 `rating`·`rating_scale`로
  저장한다. 정규화 평점과 100ml당 가격은 응답을 만들 때 계산하고 저장하지 않는다(D183).
- **관심은 구매·재고 합계를 늘리지 않는다.** 관심은 별도 테이블이며 통계·재고 집계에 들어가지
  않는다. 구매 전환(`POST /interests/{id}/purchase`)을 해야 제품·구매·병이 생긴다(D204, D205).
- **외부 관측은 실구매 가격을 덮어쓰지 않는다.** 서로 다른 판매자·규격·조건을 하나로 합치지
  않고, 모르는 조건은 임의 값으로 채우지 않고 확인 필요로 둔다.
- 외부 관련 테이블(소스·캐시·고정·관측·연결·관심·감시)은 오프라인 동기화 대상
  (`SYNC_ENTITIES`)이 아니다. 외부 조회는 온라인 전용이다.

### 비밀 정보

- 연결 키(`provider_credential`)와 소스 자격 증명(`external_source_credential`)은
  `SOOLJANG_SECRET_KEY` 기반 Fernet으로 암호화해 저장한다. 화면에는 마지막 4자 힌트만 보인다.
- 키 입력은 **쓰기 전용**이다. GET 응답에는 등록 상태와 힌트만 있고, 입력란을 비우면 기존 키를
  유지한다. 키는 요청 직전에만 서버에서 복호화한다.
- `/connections`·`/llm-settings`·`/price-watch`·`/external-sources/{id}/credentials` 응답은
  `Cache-Control: no-store, private`이다. 키는 일반 동기화·export·Dexie·outbox·서비스 워커
  캐시에 들어가지 않고, 웹 입력 임시 저장(draft)도 비밀처럼 보이는 값은 받지 않는다.
- **키 교체**는 연결의 `config_revision`을 올리고, 연결된 소스의 이전 확인 결과를 "재검증
  필요"로 돌린다. 다른 곳에서 바뀐 revision으로 저장하면 409로 거절한다.
- **복호화 실패는 인증 오류와 구분**한다(`credential_unavailable`, 화면의 "복구 키 확인 필요").
  기존 암호문을 지우거나 자동 재발급하지 않는다. 올바른 마스터 키와 백업을 복구한 뒤 연결
  확인을 다시 누른다.
- 연결 해제는 키를 지우고 사용을 멈추지만, 그 연결을 참조하던 소스·사용자 고정·구매 기록은
  남긴다.

### 소유권

모든 외부 경로는 로그인과 사용자 소유권 검사를 거친다. 남의 제품·소스·연결·관심 ID는 404다.
고정 URL은 저장할 때와 조회할 때 모두 소스 호스트로 다시 검증한다(D178).

## 3. 기능별 현재 동작

경로는 모두 `/api/v1` 아래다.

### 3.1 외부 소스 레지스트리

| 경로 | 동작 |
|---|---|
| `GET /external-sources` | 목록. 이때 `spec_overridden=False`인 프리셋 소스를 최신 프리셋 버전으로 맞춘다(D188) |
| `GET /external-sources/presets` | 번들 프리셋 카탈로그. 현재 데일리샷 하나(버전 3) |
| `POST /external-sources` | `preset_key` 또는 `adapter_spec` JSON으로 등록 |
| `PATCH /external-sources/{id}` | 수정. 프리셋 소스의 `adapter_spec`을 고치면 `spec_overridden=True`가 되어 자동 갱신에서 빠진다(D190) |
| `PUT /external-sources/{id}/credentials` | 소스 자격 증명 일괄 저장(암호화) |
| `GET /external-sources/health` | 소스별 상태: `healthy`·`degraded`·`failing`(연속 실패 3회)·`unknown`(이력 없음 또는 설정 변경 후 미확인) |
| `POST /external-sources/{id}/probe` | 샘플 이름으로 테스트 조회. 캐시에 저장하지 않고 헬스 로그에만 남긴다 |
| `DELETE /external-sources/{id}` | 삭제. 고정·probe 행은 함께 삭제된다 |

`adapter_spec` 요점:

- `format: "json"`이면 `search.item`이 JSON 경로이고 필드는 `path`로 뽑는다(D147).
  `search.result_fields`가 있으면 상세 페이지를 다시 조회하지 않는다.
- v2 확장: `search.method`(GET/POST), `search.body`(`{query}` 치환), `search.headers`,
  `credentials`(헤더 주입만, D189), `transform: strip_tags`, `search.exclude_keywords`,
  `search.offer_fields`, `search.pagination.next_path`, 최상위 `allowed_hosts`.
- `exclude_keywords`는 토큰 단위 부분집합으로 판정해 `잔`이 `잔티`를 걸러내지 않는다. 고정된
  상품에는 적용하지 않는다(D193).

제품 조회는 소스를 `priority` 순으로 모두 시도하고 소스별 결과를 따로 돌려준다. 한 소스의
실패·한도 초과가 다른 소스를 막지 않는다. 결과의 `outcome`은 `success`·`empty`·`partial`·
`authentication_failed`·`forbidden`·`rate_limited`·`network_error`·`parse_error`·
`policy_blocked`·`invalid_configuration`·`credential_unavailable`·`unknown`으로 구분한다.
조회 도중 제품·고정·소스·연결 설정이 바뀌면 그 결과를 버리고 다시 조회하라고 알린다.

화면: 설정(`#settings`, 옛 주소 `#sources`)의 **API·외부 연결** 아래 "고급: 소스별 자료 수집
규칙"(`SourcesPage`). 추천 소스 추가, JSON 직접 등록, 자격 증명, 헬스 배지, 테스트 조회,
"이 소스의 가격 이력 저장" 체크박스가 여기 있다.

### 3.2 매칭·후보·사용자 고정

- 점수는 `0.6 × 토큰 Jaccard + 0.4 × 정규화 문자열 유사도`다. 프로모션 문구 제거, 용량·숙성
  연수·도수·빈티지 추출, 표기 동의어 처리를 거친다. 용량·숙성·빈티지·도수(0.6%p 허용)는
  **양쪽에 값이 있을 때만** 하드 제약으로 쓴다(D179, D180).
- 구간: `≥ 0.85` 자동 채택, `0.5 ~ 0.85` 확인 필요(`needs_confirmation`), `< 0.5` 값 없이
  후보만 보여 준다. 후보는 최대 5개이며 같은 규격·다른 규격·관련·불일치 관계를 함께 표시한다
  (D175).
- 전문 소스 질의는 `name` → `name_en` → 사용자 별칭 → 브랜드 확장 → 축약형 순으로
  후보를 만들고 중복 제거 후 최대 3개를 사용한다. 자동 채택이 나오면 멈춘다(D181).
- **고정은 사용자가 누를 때만 만든다**(D176). 제품은 `POST /products/{id}/external-matches`,
  `DELETE /products/{id}/external-matches/{source_id}`로, 관심은 관심의 `source_matches`로
  고정한다. 고정하거나 풀면 해당 캐시를 지운다(D178).
- 고정된 소스는 상세 페이지가 있으면 검색을 건너뛰고 고정 URL을 바로 읽는다. `result_fields`
  방식(데일리샷)은 검색은 하되 후보를 키·URL 일치로 고른다. 고정 상품이 검색 결과에서 사라지면
  유사도로 몰래 바꾸지 않고 경고와 후보를 돌려준다(D177).
- 같은 상품의 여러 판매자는 하나로 줄이지 않는다. 고정은 상품(`external_product_key`)과 선호
  판매자(`preferred_seller_key`)를 따로 기억한다(D203).

### 3.3 통합 연결

| 경로 | 동작 |
|---|---|
| `GET /connections/providers` | 제공자 정의: 필요한 인증 항목·기능·안내 링크 |
| `GET /connections`, `GET /connections/{id}` | 등록 상태(`unregistered`·`incomplete`·`saved`·`not_required`·`recovery_required`)와 마지막 확인 결과 |
| `POST /connections` | 등록. 새 연결은 **일시 중지** 상태로 저장한다. 데일리샷 연결은 프리셋 소스를 함께 만든다 |
| `PATCH /connections/{id}` | 이름·사용 여부·분당/일 상한·키 교체·키 삭제, OpenAI 연결의 라벨 인식 모델·AI 매칭 보조·월 상한. `expected_revision` 필수 |
| `PUT /connections/{id}/sources/{source_id}` | 소스를 연결에 붙인다 |
| `POST /connections/{id}/probe` | **연결 확인**. 누를 때만 고정된 최소 요청 1회를 보낸다 |
| `DELETE /connections/{id}` | 해제(키 삭제·사용 중지, 소스·고정은 보존) |

제공자별 확인 요청과 쓰임:

| 종류 | 확인 요청 | 탐색에서 쓰는 요청 |
|---|---|---|
| `naver_hub` (네이버 API HUB) | `webkr` 1건 | `webkr`·`blog` 각 10건, 웹은 1페이지(API는 3페이지까지) |
| `naver_legacy` (기존 개발자센터) | `webkr.json` 1건 | 위와 같음. API HUB 키와 호환되지 않는다 |
| `brave` | `web/search` 1건 | `result_filter=web`, `summary=false`, 10건, 웹은 1페이지(API는 3페이지까지) |
| `exa` | `/search` `type=fast` 1건 | `type=fast`, 10건, `contents.text` 1500자, 첫 묶음만 |
| `openai_ocr` | 모델 목록 조회(추론 호출 없음) | 라벨 인식·선택형 AI 매칭 보조 |
| `dailyshot` | robots 확인 후 공개 검색 1건 | 소스 조회 |

- 2026년 7월 종료된 **네이버 쇼핑 상품 검색은 지원하지 않는다.** API HUB의 Shopping Insight도
  가격 API가 아니다.
- Exa Answer·요약·Highlights·Research·`outputSchema`, Brave summarizer는 호출하지 않는다.
- 연결 확인 성공은 그 endpoint의 인증·응답 형식 확인일 뿐, 자료 재사용 권리나 잔액 확인이 아니다.
  화면의 요청 수는 앱이 예약한 수이며 제공자 청구량이 아니다.
- ChatGPT 구독은 이 앱의 API 키를 대신하지 않는다. 새 탐색은 OpenAI 키를 요구하지 않는다.

`0014_provider_connections`는 기존 소스·LLM 설정마다 별도 연결을 만들고 암호문을 해독 없이
복사했다. 힌트가 같은 키도 합치지 않는다(D202). downgrade는 새 연결 전용 키를 잃을 수 있으므로
운영에서 단독 실행하지 않는다.

화면: 설정의 **API·외부 연결**(`ConnectionsPanel`). 화면을 열거나 새로고침해도 외부 요청은
나가지 않는다.

### 3.4 탐색(Discovery)

| 경로 | 동작 |
|---|---|
| `POST /discovery/search` | 검색 연결 하나로 검색. 제목에 명시된 도수·숙성 연수만 적용 후보로 제안 |
| `POST /discovery/lookup` | 저장하지 않은 대상을 소스 1~4개로 일회성 조회. 관측·캐시를 남기지 않는다 |
| `POST /discovery/products/{id}/lookup` | 제품을 선택한 소스로 조회(캐시·관측 규칙은 §3.1과 같음) |
| `GET /discovery/products/{id}/context` | 제품의 식별 정보와 기존 고정 |
| `POST /discovery/interests/{id}/lookup` | 관심을 조회. 허용된 소스면 관측을 관심 ID로 남긴다 |
| `POST /discovery/apply` | 고른 속성(`name_en`·`country`·`region`·`abv`·`vintage`·`age_years`)만 제품에 적용 |

- 응답은 모두 `no-store`다. 브라우저 연결이 끊기면 남은 외부 요청을 보내지 않는다.
- 같은 URL을 합칠 때 필드·증거·원순위를 보존한다. 검색 응답 도착 순서와 최종 순위를 분리해
  원어명/확인 별칭 일치·판본/규격·자료 충실도로 정렬하며 다른 제품을 URL만으로 병합하지 않는다.
- 화면은 제품 정보·리뷰·가격/판매 조건·기타 자료를 구분한다. 평점·맛·가격·긍부정은 생성하지
  않는다. 질의·언어·제공자·원순위, 부분 실패·캐시·독립 원문 수를 확인할 수 있다.
- 선택 자료에서 실제 제품 이름·판본·규격·출처 URL을 확인한 뒤 관심으로 저장한다. 검색 문구
  자체를 제품명으로 자동 저장하거나 검색 발췌를 장기 보관하지 않는다.
- 적용은 서버가 발급한 증거 토큰(15분), 제품 `updated_at`, 소스·연결 revision을 모두 확인한다.

화면: 주 탭 **탐색**(`#discover`, `DiscoverPage`), 제품 상세와 매장 모드(`#scan`)의 "외부 정보
조회"(`ExternalInfoCard` → `DiscoveryPanel`), 관심 화면의 관심별 조회. 입력 중인 검색어·선택은
계정·탭별 임시 저장으로 복구된다. "외부 브라우저에서 보조 검색" 링크는 D167의 대체 경로다.

#### 한영 검색 사전과 검증 범위 (2026-10-11)

`src/sooljang/domain/search_aliases.json`은 확인된 15개 브랜드의 한영 이름·출처·확인일을
관리한다. 14개는 [페르노리카 코리아 브랜드 안내](https://www.pernod-ricard-korea.com/pernod-ricard-korea),
GlenAllachie는 [롯데호텔 BAR 81의 한영 메뉴](https://www.lottehotel.com/cms/asset/2026/04/27/39519/BAR%2081%20MENU%20260426.pdf)에
표시된 쌍이다. 메뉴는 브랜드 표기 근거로만 사용하며 현재 가격·재고 근거로 쓰지 않는다.
미확인 음역은 자동 추가하지 않는다. 사용자가 확인한 제품 별칭은 별도 `search_aliases`에 둔다.

서버·로컬·자동완성·관심은 같은 정규화/별칭 의미를 사용한다. 일반 검색은 이름 → 원어명 →
사용자 별칭 → 브랜드 확장 순으로 중복을 제거한 최대 2질의를 사용하며 판본·규격·배치·단위를
보존한다. 한 탐색에서 검색 연결과 전문 소스를 합쳐 최대 4개를 선택한다. 일반 검색의 HTTP
요청 합계는 8회 이하(네이버는 질의당 2채널), 전문 소스 adapter는 별도 조회당 최대 12회·20초
상한이다. 현재 웹은 첫 페이지만 요청하고 API의 `page` 1~3 지원과 구분한다.
명시 검색 시작·취소·온라인 조건을 유지하며 별칭은 자동 제품 병합/고정의 증거가 아니다.

고정 평가 자료 `tests/fixtures/search_cases.json` 120개는 한영·공백·Unicode·판본/용량/세트
부정 사례·미확인 오타를 포함한 **합성 이름 회수 검증**이다. 개발/보류 세트를 구분하며,
실제 검색 제공자의 회수율·상위 3개 정확도·지연·비용은 별도 opt-in 실연결 결과로 기록한다.
이 이름 검증의 성공률을 검색 제공자 품질로 표시하지 않는다.

### 3.5 관심(Interest)

| 경로 | 동작 |
|---|---|
| `GET /interests`, `POST /interests` | 목록·생성. `request_id`로 반복 저장을 멱등 처리 |
| `PATCH /interests/{id}` | 식별 정보·출처 고정·메모·보관. `expected_updated_at` 불일치는 409 |
| `DELETE /interests/{id}` | `expected_updated_at`을 검사하는 소프트 삭제 |
| `POST /interests/{id}/restore` | 삭제 버전을 검사해 같은 ID 복구. 감시 자동 재개 없음 |
| `POST /interests/{id}/purchase` | 구매 전환. 기존 SKU 또는 새 제품을 만들고 같은 관심 ID를 영수증으로 남긴다. 같은 요청 재전송은 같은 결과, 다른 내용은 409 |

화면: 주 탭 **관심**(`#interests`, `InterestsPage`). 이름·원어명·별칭·판본·메모 편집,
검색·정렬·활성/보관/삭제 필터, 고정 해제, 삭제와 복구, 관심별 탐색·가격 이력·구매 전환을 제공한다.
`GET /interests?include_deleted=true`는 현재 계정의 삭제 기록도 반환한다. 식별 정보 변경은
기존 고정을 해제하고 감시를 멈춘다. 삭제/고정 해제는 대기 중 감시·푸시 전달을 취소하지만
실측 관측·논리 알림·구매 전환 영수증·재고는 보존한다. 삭제는 저장된 고정도 보존하며,
복구 후 명시적 조회에서 그 고정을 다시 사용할 수 있다. 감시는 자동 재개하지 않는다.

### 3.6 가격 관측·비교

- 소스 조회가 성공하면 판매 조건마다 `external_offer`(소스·대상·`condition_key`별 하나)와
  `external_price_observation`(같은 offer·관측 시각은 한 번)을 남긴다.
- 판매 조건은 가격 종류·회원·쿠폰·수령 방식·지역·배송·세금을 포함한다. 검색 발췌 가격과 권장가는
  최저가 집계와 감시에서 뺀다.
- 등록 빈티지를 상품명보다 우선하고, 상세 필드의 빈티지·도수·숙성·생산자 근거를 관측에
  보존한다. 다른 빈티지와 모순되면 확인 필요로 남긴다(D211).
- 이력: `GET /price-watch/products/{id}/history`, `GET /price-watch/interests/{id}/history`
  (최근순, 최대 200건). 지금 `price_history_allowed`가 꺼진 소스의 이력은 보이지 않는다.

화면: 제품 상세·관심의 비교 표(`ExternalComparisonTable`, `OfferComparison`)와 가격 이력
(`PriceHistoryPanel`). 비교 표는 최저가 배지와 선택한 규격의 내 실평단가 대비 차이를 보여 준다.
같은 용량·KRW 단품이고 판본·판매 조건이 확인된 offer만 비율을 표시한다.
내 구매가 없으면 이력 없음, 0원이면 비율 비교 불가로 표시한다. 조건 식별이 없는 소스
요약 가격에는 비율을 붙이지 않으며 출처·가격·확인 시각은 그대로 표시한다.

### 3.7 가격 감시·웹 푸시

- 감시는 **관심 대상의 관측된 판매 조건 하나**로만 만든다(`POST /price-watch`). 가격 이력 보관이
  허용된 소스, 실제 관측, 확인된 단품 규격·수량·조건이 필요하다(D207).
- 목표가는 기본 수동 조회다(`POST /price-watch/{id}/check`). **정기 조회**(`schedule_enabled`)와
  **웹 푸시**(`push_enabled`)는 감시별로 따로 켜며 기본 꺼짐이다. 화면 진입이나 저장만으로
  조회·브라우저 권한 요청을 하지 않는다.
- 정기 조회 간격과 재알림 간격은 15분~7일, 가격 유효 시간은 1분~24시간이다. 놓친 일정은
  재시작 때 한 번으로 합친다.
- 실행을 막는 조건: 일시 중지, 관심 보관, 고정 해제, 소스·연결 중지, 필수 인증 정보 없음,
  가격 이력 보관 미허용. 기존 관심·이력·알림은 그대로 둔다.
- 알림은 새로 저장한 완전한 관측 중 같은 판매 조건만 비교한다. 캐시·last-good·부분 결과·
  미확정 판본·재고 미확인·오래된 가격·통화나 조건 불일치는 알리지 않는다. 같은 가격 반복은
  억제한다. 앱 내 알림은 푸시 동의 없이도 남는다.
- 실행 원장 `price_watch_run`은 발생 키(수동 요청 ID 또는 UTC 일정 슬롯)가 고유하다. 임대
  120초, 최대 3회. 설정을 바꾸면 대기·실행 중 작업과 대기 중 전송을 취소한다.
- 전송은 먼저 `sending`을 기록한 뒤 보낸다. 30초 임대가 지나도 남은 전송과 응답을 알 수 없는
  전송은 `unknown`으로 끝내고 자동 재전송하지 않는다. 429/503만 60~3600초 뒤 최대 3회 재시도,
  404/410은 구독 만료, 1시간 지난 대기는 취소한다.
- 상한: 사용자당 감시 100개, 유효 구독 5개, 대기·진행 전송 500개(초과 시 `queue_full`과 앱 내
  알림).
- 푸시 본문은 이벤트 UUID만 담는다. 제품명·가격·기록은 잠금 화면에 나가지 않는다. 서비스 워커는
  일반 문구를 띄우고 같은 origin의 가격 감시 화면으로 이동한다. 서버 접수와 화면 표시의
  exactly-once는 보장하지 않는다.
- 구독 endpoint·수신 키는 암호화해 저장하고 API에는 fingerprint·상태만 내보낸다. 해제·만료 시
  암호문을 지우고, 로그아웃하면 현재 브라우저 구독도 끝낸다.

경로: `GET /price-watch/config`, `GET|POST /price-watch`, `PATCH|DELETE /price-watch/{id}`,
`POST /price-watch/{id}/check`, `GET /price-watch/runs/{id}`, `GET /price-watch/notifications`,
`POST /price-watch/notifications/{id}/read`, `GET|POST /price-watch/subscriptions`,
`DELETE /price-watch/subscriptions/{id}`.

화면: 설정 메뉴의 **가격 감시·알림**(`#price-watch`, `PriceWatchPage`).

## 4. 안전 장치

### 4.1 `safe_http` — 요청 경계

`infrastructure/external/safe_http.py`의 `SafeHttpClient`가 모든 외부 송신(소스 조회, 연결 확인,
검색, 웹 푸시)을 감싼다.

- HTTP(S) 기본 포트, userinfo 없는 URL, **명시한 호스트**만 허용한다. 소스는 `base_url`·정적
  `search.url_template` 호스트·`allowed_hosts`가 범위이며, 검색 결과 링크가 범위를 넓히지 않는다.
- DNS 응답 전체가 공인 IP인지 확인하고, 검증한 IP로 직접 연결한다. TLS·Host·SNI는 원래 호스트로
  검증한다. 사설·예약·멀티캐스트와 IPv4 매핑·6to4·Teredo·NAT64 주소를 막는다. 환경 proxy와
  cookie 자동 재생은 쓰지 않는다.
- redirect는 GET/HEAD만 hop마다 다시 검증하며 따라간다. POST 본문은 redirect·재시도로 다시
  보내지 않는다. redirect 위치에 비밀값이 비치면 중단한다.
- **비밀 헤더는 HTTPS 첫 hop의 지정 호스트만** 받는다. robots·상세·redirect에는 붙지 않는다.
  공개 헤더(`accept`·`accept-language`·`content-type`·`user-agent`·`x-requested-with`) 외의 헤더는
  비밀 경로로만 넣을 수 있다.
- 기본 상한: 요청 본문 100 kB, 응답 압축 전후 각 2 MB, redirect 3회, GET/HEAD 재시도 1회
  (Retry-After 2초 이하), 요청 전체 15초·I/O 5초, 프로세스 송신 동시성 4.
  호출별 조정: 소스 조회는 redirect 5회, 전체 20초·12요청 이하. 연결 확인과 검색은 redirect·
  재시도 0회(검색 18초).
- 응답이 키 값을 그대로 돌려주면 결과를 저장하지 않고 `parse_error`로 처리한다. 캐시
  `raw_excerpt`에는 표준 키 중 공개 스칼라 값만 담는다.

### 4.2 robots와 요청 상한

- 소스 조회는 요청마다 **실제 대상 호스트의** `robots.txt`를 확인한다(D187). 404는 규칙 없음,
  다른 오류는 허용으로 보지 않는다(`policy_blocked`). 파서는 프로세스 메모리에 24시간 캐시한다.
  robots 허용은 자료 재사용 권리를 뜻하지 않는다.
- User-Agent는 `SoolJangBot/1.0 (+저장소 URL; personal-use lookup)`이다.
- 요청 예약은 robots·검색·상세·redirect·재시도 각각 직전에 별도 트랜잭션으로 `external_request_usage`에
  남긴다. 주 작업이 롤백되거나 프로세스가 재시작해도 줄지 않는다(D197). 연결과 소스 예산은 함께
  원자적으로 예약하고 잠금 순서를 고정한다. 기본 상한은 소스·연결 모두 분당 6회, UTC 하루 1000회이며
  설정에서 바꿀 수 있다. 캐시 적중은 예약하지 않는다.
- 송신 직전마다 소스·연결의 revision과 사용 여부를 다시 읽는다. 바뀌었으면 남은 요청을 보내지
  않는다. 이미 나간 요청을 취소했다고 표시하지는 않는다.

### 4.3 LLM 재판정(선택)

- 확인 필요 구간(0.5~0.85)에서만, OpenAI 연결의 **AI 매칭 보조**를 켠 경우에만(기본 꺼짐) 부른다.
- LLM에는 내 제품 식별 정보와 후보 **이름만** 보낸다. 가격·URL·개인 기록은 함수 시그니처상
  넘길 수 없다.
- 비용 가드: 같은 (소스, 제품)은 24시간에 1회, 사용자별 월 상한(기본 200회). 호출 전에 로그를
  먼저 남겨 실패 반복으로 비용이 새지 않게 한다(D191, D192).
- 결과는 "LLM 추천" 배지일 뿐 **자동 고정하지 않는다**. 실패·거절·범위 밖 응답은 조용히 기존
  점수 결과로 돌아간다.
- 새 탐색(Discovery)은 생성형 호출 없이 동작하며 LLM 재판정을 끈 채 조회한다(§6 참고).

## 5. 운영 설정

환경 변수(이름만 적는다. 값은 배포 비밀로 주입하고 저장소에 넣지 않는다):

| 변수 | 쓰임 |
|---|---|
| `SOOLJANG_SECRET_KEY` | 연결 키·소스 자격 증명·LLM 키·푸시 구독 암호화와 탐색 증거 토큰 서명. 바꾸면 기존 암호문을 읽을 수 없다 |
| `SOOLJANG_PRICE_WATCH_WORKER_ENABLED` | 가격 감시 worker 실행(기본 켜짐, `test` 환경은 자동 기동 안 함). 끄면 수동 실행 API도 409, 저장한 목표가는 보존 |
| `SOOLJANG_PUSH_VAPID_PRIVATE_KEY` | P-256 개인 스칼라 32바이트의 base64url. API는 공개키와 준비 여부만 돌려준다 |
| `SOOLJANG_PUSH_VAPID_SUBJECT` | 운영 연락처 `mailto:` 또는 HTTPS URL |
| `SOOLJANG_PUSH_ALLOWED_HOSTS` | 쉼표 구분 푸시 서비스 호스트. 기본은 FCM·Mozilla·Apple 호스트 |

- worker는 별도 서비스 없이 API lifespan에서 15초마다 돈다. 여러 API 프로세스가 떠도 DB
  잠금·임대로 한 곳만 실행한다. `/ready`는 worker task와 120초 이내 heartbeat를 확인한다.
- VAPID 키를 바꾸면 이전 키로 맺은 구독은 전송 대상에서 빠진다. 사용자가 브라우저에서 구독을
  다시 등록해야 한다. 푸시 암호화는 `http-ece`(aes128gcm)를 쓴다(RFC 8291, RFC 8292).
- 원장·알림·전송 상태와 암호화된 구독은 PostgreSQL 백업 대상이다. 복구 뒤 불확실한 전송을 새
  대기로 되돌리지 않는다.

연결 등록 순서(설정 → API·외부 연결):

1. 제공자를 고르고 인증 항목을 입력해 저장한다. 연결은 일시 중지 상태로 생긴다.
2. **연결 확인**을 눌러 인증·응답 형식을 확인한다(요금·사용량에 반영될 수 있다).
3. **사용 시작**을 켠다. 필요하면 분당/일 상한을 조정한다.
4. 전문 소스가 연결 키를 써야 하면 소스를 연결에 붙인다.

소스 등록 순서(설정 → API·외부 연결 → 고급):

1. "추천 소스에서 추가"로 프리셋을 고르거나, `adapter_spec` JSON을 직접 등록한다.
2. 필요한 자격 증명을 저장하고 **테스트 조회**로 헬스를 확인한다.
3. 제공자가 가격 자료 보관을 허용한다는 근거가 있을 때만 "이 소스의 가격 이력 저장"을 켠다.

새 사이트를 붙일 때는 [sooljang-source-review](../.agents/skills/sooljang-source-review/SKILL.md)
절차로 robots·약관·공식 API·로그인 필요 여부를 먼저 확인하고, 실제 검색 요청과 응답 샘플(쿠키·
개인정보 제거), 실제 제품 3종 조회로 검증한다. 추측으로 스펙을 쓰지 않는다.

### 출처 검토 상태(2026-09-07 조사)

| 출처 | 상태 |
|---|---|
| 데일리샷 | 공개 검색 무인증 응답 확인. 같은 상품의 복수 판매자 확인. 약관상 게시물 재사용 제한이 있어 가격 이력 보관 허용 근거는 미확정 |
| 키햐 | 두 번째 국내 가격 후보. 공개 HTML 확인만, 자동 파싱·보관 권리 미확정 |
| 네이버 API HUB / Brave / Exa | 공식 문서 확인. Exa는 사용자 승인 키로 실검색 성공. 네이버·Brave 실키 연결은 미실행 |
| 이마트·트레이더스·코스트코·CU·GS25·emart24 | robots·약관상 자동 수집 불가 또는 미검증. 검색 발견만 |
| Whiskybase / Untappd | 파트너 계약·승인 키 필요. Untappd는 24시간 캐시·자체 DB 구축 금지 조건 |
| Wine21 / 더술닷컴 / 제조사 공식 | 조건부. 자료별 저작권·공공누리 범위 확인 필요 |

데일리샷 경유 CU·emart24, 여러 검색 제공자가 찾은 같은 URL은 독립 출처로 세지 않는다.

## 6. 알려진 제한과 후속

- **#142 국내 가격 2출처**: 서로 독립된 국내 판매 원문 두 곳의 실제 허용 사례가 없다. 복수
  offer·조건 비교·관측 저장은 구현돼 있지만, 데일리샷·키햐의 재사용 허용을 확인하기 전에는
  완료로 기록하지 않는다. 코스트코·이마트 수집으로 조용히 대체하지 않는다.
- **#143 실기기 웹 푸시**: 실제 HTTPS 기기 구독·수신 수용이 남았다. 동의·worker·암호화 전송·
  복구는 구현과 자동 검증까지 끝났다.
- 두 건은 사용자 승인 후속이며 소스 이용 허가나 실제 성공 판정을 뜻하지 않는다(D209).
- 소스 정책은 `price_history_allowed` 하나로만 표현한다. 조사 단계에서 제안한 소스별
  `fetch_allowed`·`display_allowed`·`retention` 분리는 구현하지 않았다.
- LLM 재판정은 `POST /products/{id}/external-lookup`에서만 실행된다. 현재 웹은 제품 조회에
  `/discovery/products/{id}/lookup`(재판정 끔)을 쓰므로 화면에서 "LLM 추천" 배지가 나오지 않는다.
- 네이버 연결의 기능 안내에는 카페글 검색이 있지만 탐색은 `webkr`·`blog`만 요청한다.
- robots 캐시는 프로세스 메모리라 재시작하면 다시 받는다.

## 7. 결정 이력

| 결정 | 요지 |
|---|---|
| D147 | `adapter_spec` JSON 모드(`path`, `result_fields`, `url_template`) |
| D148 → D181 | 이름 앞 4글자 접두사 게이트를 도입했다가 토큰 점수·하드 제약으로 대체해 제거 |
| D166 | 외부 화면 테스트는 기존 렌더 유틸을 재사용 |
| D167 | 검색엔진 SERP 스크래핑·LLM 요약 전략 폐기, "웹에서 검색" 링크로 대체 |
| D175~D178 | 신뢰 구간 3분할과 후보 노출, 사용자 명시 고정만 허용, 소스 형태별 고정 조회 경로, 고정 변경 시 캐시 삭제와 양쪽 호스트 검증 |
| D179~D181 | 순수 매칭 모듈, 토큰·문자열 가중 점수, 양쪽 값이 있을 때만 하드 제약, 질의 3개·조기 종료 |
| D182~D184 | 표준 필드 분류를 응용 계층에서, 파생값 비저장, 스냅샷 버전으로 캐시 무효화 |
| D185~D186 | 롤링 probe 로그와 헬스 상태, 실제 시도만 기록 |
| D187~D190 | 요청 호스트별 robots, Python 프리셋 카탈로그와 목록 조회 시 자동 갱신, 헤더 전용 자격 증명, 사용자 편집 시 `spec_overridden` |
| D191~D192 | LLM 매칭 보조 설정(기본 꺼짐·월 200회)과 DB 로그 기반 비용 가드 |
| D193 | 토큰 부분집합 제외 키워드, 고정 상품은 제외 대상 아님 |
| D197~D199 | 검증 IP 직접 연결과 hop별 영속 예산, revision 기반 재검증 표시, 합성 정답셋·소스 원장 분리 |
| D202 | 기존 소스·LLM 설정을 별도 연결로 이전하며 암호문 보존 |
| D203 | 판본·규격을 검색어와 분리, 복수 판매 조건과 실제 관측 저장, 장기 보관은 소스별 허용 후 |
| D204~D205 | 구매와 분리된 관심 UUID, 멱등 저장, 관심 ID를 보존하는 구매 전환 |
| D206 | 최대 4개 비생성 탐색, 원문·증거 비보관, 선택 필드만 revision 확인 후 적용 |
| D207 | 관심 ID와 실제 관측 판매 조건 기반 가격 감시, 정기 조회·푸시 별도 동의, 원장 영속화 |
| D209 | #142·#143을 승인 후속으로 이연하고 1.7.0 릴리스 |
| D211 | 등록 빈티지 우선과 외부 관측 근거 보존 |
