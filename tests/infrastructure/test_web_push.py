"""실제 EC/ECE 암호화와 MockTransport로 개인정보·서명·전송 상태를 검증한다."""

import base64
import json
import uuid
from datetime import UTC, datetime

import http_ece
import httpx
import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from sooljang.infrastructure.web_push import (
    PushOutcome,
    build_push_request,
    send_push,
    validate_subscription,
    vapid_public_key,
)

PRIVATE = base64.urlsafe_b64encode((1).to_bytes(32, "big")).rstrip(b"=").decode()
NOW = datetime(2026, 9, 7, tzinfo=UTC)


def subscription() -> tuple[dict, ec.EllipticCurvePrivateKey, bytes]:
    key = ec.generate_private_key(ec.SECP256R1())
    raw = key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    auth = b"0123456789abcdef"

    def encode(value: bytes) -> str:
        return base64.urlsafe_b64encode(value).rstrip(b"=").decode()

    return (
        {
            "endpoint": "https://fcm.googleapis.com/fcm/send/synthetic-endpoint",
            "keys": {"p256dh": encode(raw), "auth": encode(auth)},
        },
        key,
        auth,
    )


def test_encrypted_payload_contains_only_stable_event_id_and_valid_vapid_signature() -> None:
    info, key, auth = subscription()
    event = uuid.uuid4()
    request = build_push_request(
        info, private_key=PRIVATE, subject="mailto:admin@example.com", event_id=event, now=NOW
    )
    assert json.loads(
        http_ece.decrypt(request.body, private_key=key, auth_secret=auth, version="aes128gcm")
    ) == {"event_id": str(event)}
    assert str(event).encode() not in request.body
    token = request.headers["Authorization"].split("t=")[1].split(",")[0]
    header, claims, signature = token.split(".")

    def decode(value: str) -> bytes:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))

    payload = json.loads(decode(claims))
    assert payload["aud"] == "https://fcm.googleapis.com"
    assert payload["exp"] == int(NOW.timestamp()) + 3600
    raw = decode(signature)
    public = ec.EllipticCurvePublicKey.from_encoded_point(
        ec.SECP256R1(), decode(vapid_public_key(PRIVATE))
    )
    public.verify(
        encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")),
        f"{header}.{claims}".encode(),
        ec.ECDSA(hashes.SHA256()),
    )
    assert "synthetic-endpoint" not in repr(request)


@pytest.mark.parametrize(
    "status,outcome",
    [
        (201, PushOutcome.ACCEPTED),
        (410, PushOutcome.EXPIRED),
        (404, PushOutcome.EXPIRED),
        (401, PushOutcome.REJECTED),
        (429, PushOutcome.RETRYABLE),
        (503, PushOutcome.RETRYABLE),
    ],
)
async def test_delivery_status_is_separate_from_notification_or_display(
    status: int, outcome: PushOutcome
) -> None:
    info, _, _ = subscription()
    request = build_push_request(
        info,
        private_key=PRIVATE,
        subject="mailto:admin@example.com",
        event_id=uuid.uuid4(),
        now=NOW,
    )
    seen = []

    def respond(outgoing: httpx.Request) -> httpx.Response:
        seen.append(outgoing)
        assert outgoing.headers["content-encoding"] == "aes128gcm"
        return httpx.Response(status, headers={"retry-after": "120"})

    result = await send_push(request, transport=httpx.MockTransport(respond))
    assert result.outcome == outcome and len(seen) == 1


async def test_response_loss_is_unknown_and_does_not_retry() -> None:
    info, _, _ = subscription()
    request = build_push_request(
        info,
        private_key=PRIVATE,
        subject="mailto:admin@example.com",
        event_id=uuid.uuid4(),
        now=NOW,
    )
    seen = []

    def respond(outgoing: httpx.Request) -> httpx.Response:
        seen.append(outgoing)
        raise httpx.ReadTimeout("synthetic response loss")

    assert (
        await send_push(request, transport=httpx.MockTransport(respond))
    ).outcome == PushOutcome.UNKNOWN
    assert len(seen) == 1


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://fcm.googleapis.com/a",
        "https://127.0.0.1/a",
        "https://attacker.example/a",
        "https://fcm.googleapis.com:444/a",
        "https://x@fcm.googleapis.com/a",
    ],
)
def test_subscription_cannot_choose_an_unrelated_or_private_target(endpoint: str) -> None:
    info, _, _ = subscription()
    with pytest.raises(ValueError, match="주소와 키"):
        validate_subscription(endpoint, info["keys"]["p256dh"], info["keys"]["auth"])
