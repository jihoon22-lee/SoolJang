"""바코드 정규화·분류 테스트."""

import pytest

from sooljang.application.barcodes import (
    InvalidBarcodeError,
    normalize_and_classify,
    normalize_optional,
)
from sooljang.infrastructure.database.models import BarcodeType


def test_ean13_stays_as_is() -> None:
    code, kind = normalize_and_classify("8801234567890")
    assert code == "8801234567890"
    assert kind == BarcodeType.EAN13


def test_upca_gets_zero_padded_to_ean13() -> None:
    code, kind = normalize_and_classify("012345678905")
    assert code == "0012345678905"
    assert kind == BarcodeType.UPCA


def test_ean8_stays_8_digits() -> None:
    code, kind = normalize_and_classify("96385074")
    assert code == "96385074"
    assert kind == BarcodeType.EAN8


def test_whitespace_and_dashes_are_stripped() -> None:
    code, kind = normalize_and_classify(" 880-123-4567890 ")
    assert code == "8801234567890"
    assert kind == BarcodeType.EAN13


@pytest.mark.parametrize("prefix", ["20", "25", "29", "04"])
def test_rcn_prefixes_are_classified_as_rcn(prefix: str) -> None:
    code, kind = normalize_and_classify(f"{prefix}00001000005")
    assert kind == BarcodeType.RCN
    assert code.startswith(prefix)


def test_upca_rcn_prefix_is_also_classified_as_rcn() -> None:
    """미국 매장 내부용(무게 표시) UPC-A 도 0 을 채운 뒤엔 EAN-13 RCN 범위와 겹친다."""
    code, kind = normalize_and_classify("200001000009")
    assert code == "0200001000009"
    assert kind == BarcodeType.RCN


def test_non_digit_input_is_rejected() -> None:
    with pytest.raises(InvalidBarcodeError):
        normalize_and_classify("ABC1234567890")


@pytest.mark.parametrize("length", [1, 5, 9, 11, 14, 20])
def test_unsupported_lengths_are_rejected(length: int) -> None:
    with pytest.raises(InvalidBarcodeError):
        normalize_and_classify("1" * length)


def test_empty_string_is_rejected() -> None:
    with pytest.raises(InvalidBarcodeError):
        normalize_and_classify("")


def test_normalize_optional_passes_through_none() -> None:
    assert normalize_optional(None) == (None, None)
    assert normalize_optional("   ") == (None, None)


def test_normalize_optional_normalizes_present_value() -> None:
    code, kind = normalize_optional("96385074")
    assert code == "96385074"
    assert kind == BarcodeType.EAN8
