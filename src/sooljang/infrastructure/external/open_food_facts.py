"""Open Food Facts 바코드 조회.

`docs/architecture.md` §1.1 이 그리는 유일한 온디맨드 외부 조회다(Task 16 시점). 인증이나
API 키가 필요 없는 공개 API 라 별도 자격 증명 설정이 없다. 실패해도 예외를 던지지 않고
`None` 을 반환한다 — 이 조회는 "있으면 좋은" 보조 정보일 뿐, 실패해도 로컬 미매칭 경로로
자연스럽게 넘어가야 한다.
"""

import logging

import httpx

BASE_URL = "https://world.openfoodfacts.org/api/v2/product"
#: 응답 필드를 좁혀 전송량을 줄인다. 이 프로젝트가 쓰는 값만 요청한다.
_FIELDS = "product_name,brands,quantity,image_url"
_TIMEOUT_SECONDS = 5.0

logger = logging.getLogger(__name__)


class OpenFoodFactsProduct:
    """조회 결과. 사용자가 확인·수정한 뒤에만 저장한다 — 그대로 신뢰하지 않는다."""

    def __init__(
        self,
        *,
        barcode: str,
        name: str,
        brand: str | None,
        quantity_text: str | None,
        image_url: str | None,
    ) -> None:
        self.name = name
        self.brand = brand
        self.quantity_text = quantity_text
        self.image_url = image_url
        # 절대 규칙 7: 외부 데이터는 출처 URL 없이 저장하지 않는다.
        self.source_url = f"https://world.openfoodfacts.org/product/{barcode}"


async def lookup(
    barcode: str, *, transport: httpx.AsyncBaseTransport | None = None
) -> OpenFoodFactsProduct | None:
    """바코드로 Open Food Facts 를 조회한다. 못 찾거나 오류면 `None`.

    `transport` 는 테스트가 `httpx.MockTransport` 로 실제 네트워크 호출 없이 응답을
    흉내 낼 수 있게 하는 자리다 — 운영에서는 항상 `None`(기본 전송)이다.
    """
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS, transport=transport) as client:
            response = await client.get(f"{BASE_URL}/{barcode}.json", params={"fields": _FIELDS})
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError) as error:
        # 네트워크 장애·타임아웃·잘못된 JSON — 전부 "찾지 못함" 으로 취급한다. 이 조회
        # 하나 때문에 전체 요청을 실패시키지 않는다.
        logger.warning("Open Food Facts 조회 실패(barcode=%s): %s", barcode, error)
        return None

    if payload.get("status") != 1:
        return None

    product = payload.get("product") or {}
    name = product.get("product_name") or None
    if not name:
        # 이름 없는 결과는 사용자에게 보여줄 게 없다 — 못 찾은 것과 같이 취급한다.
        return None

    return OpenFoodFactsProduct(
        barcode=barcode,
        name=name,
        brand=product.get("brands") or None,
        quantity_text=product.get("quantity") or None,
        image_url=product.get("image_url") or None,
    )
