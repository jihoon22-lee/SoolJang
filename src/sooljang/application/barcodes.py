"""바코드 정규화·분류.

GS1 표준 전체가 아니라 이 프로젝트에 필요한 부분만 구현한다: EAN-8·UPC-A·EAN-13 인식,
UPC-A → EAN-13 정규화, RCN(Restricted Circulation Number) 판별.

**RCN 은 매장 내부용 바코드**다(무게에 따라 가격이 바뀌는 상품 등). 제조사가 발급한
전역 고유 번호가 아니라 매장마다 같은 번호가 다른 상품을 가리킬 수 있어, Open Food Facts
조회가 실패하거나 엉뚱한 상품과 매칭될 위험이 있다 — 그래서 `barcode_type` 을 강제로
`RCN` 으로 분류해 호출부(API 응답)가 사용자에게 경고할 수 있게 한다. 클라이언트가 보낸
`barcode_type` 힌트보다 이 판별 결과를 항상 우선한다 — 분류는 신뢰 경계에서 서버가
확정해야 한다.
"""

import re

from sooljang.infrastructure.database.models import BarcodeType

_DIGITS_ONLY = re.compile(r"^\d+$")
# EAN-13 이 매장 내부용으로 예약한 접두어 범위(20~29, 04). 네이티브 13자리 코드에만
# 적용한다 — UPC-A 를 0 패딩한 13자리는 자릿수가 한 칸 밀려 이 범위와 겹치지 않는다.
_EAN13_RCN_PREFIXES = frozenset(f"{i:02d}" for i in range(20, 30)) | {"04"}
# UPC-A 자체의 "number system digit" 예약 규칙 — 2 로 시작하면 무게 따라 가격이 바뀌는
# 매장 내부용 상품이다(0 패딩 전의 원본 12자리 기준).
_UPCA_RCN_LEAD_DIGIT = "2"


class InvalidBarcodeError(ValueError):
    """스캔되거나 입력된 문자열이 EAN-8·UPC-A·EAN-13 형식이 아니다."""


def normalize_and_classify(raw: str) -> tuple[str, BarcodeType]:
    """스캔 원본 문자열을 저장용 숫자 문자열과 바코드 종류로 바꾼다.

    UPC-A(12자리)는 앞에 0 을 채워 EAN-13 과 같은 13자리로 저장한다(GS1 표준) — 매장에
    따라 같은 상품이 UPC-A 로도 EAN-13 으로도 찍히는 경우를 하나의 바코드로 매칭하기
    위해서다. RCN 판별은 패딩 **전** 원본 자릿수 기준으로 한다 — UPC-A 와 EAN-13 은
    예약 범위 규칙 자체가 다르다.
    """
    digits = re.sub(r"[\s-]", "", raw)
    if not digits or not _DIGITS_ONLY.fullmatch(digits):
        raise InvalidBarcodeError(f"바코드는 숫자로만 이루어져야 합니다: {raw!r}")

    if len(digits) == 8:
        return digits, BarcodeType.EAN8
    if len(digits) == 12:
        kind = BarcodeType.RCN if digits[0] == _UPCA_RCN_LEAD_DIGIT else BarcodeType.UPCA
        return "0" + digits, kind
    if len(digits) == 13:
        kind = BarcodeType.RCN if digits[:2] in _EAN13_RCN_PREFIXES else BarcodeType.EAN13
        return digits, kind

    raise InvalidBarcodeError(f"지원하지 않는 바코드 길이입니다(8·12·13자리만 지원): {raw!r}")


def normalize_optional(raw: str | None) -> tuple[str | None, BarcodeType | None]:
    """`raw` 가 없으면 (None, None). 있으면 `normalize_and_classify` 를 적용한다.

    규격에 바코드를 쓰는 모든 지점(등록·수정)이 이 함수를 거쳐야 저장된 값이 항상
    `GET /barcodes/{code}` 의 조회 정규화와 같은 형식을 유지한다.
    """
    if raw is None or not raw.strip():
        return None, None
    return normalize_and_classify(raw)
