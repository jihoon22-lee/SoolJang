"""Web Push 암호화와 제한된 전송. payload는 개인정보 없는 알림 ID만 담는다.

RFC 8291/8188의 aes128gcm은 http-ece로 처리하고 RFC 8292 VAPID ES256을 사용한다.
네트워크는 기존 SafeHttpClient에 한정한다. 전송 실패의 원문 endpoint/응답은 반환하지 않는다.
"""

import base64
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Any

import http_ece
import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

from sooljang.infrastructure.external.safe_http import (
    HttpLimits,
    SafeHttpClient,
    UnsafeRequest,
    validate_url,
)

DEFAULT_PUSH_HOSTS = (
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "web.push.apple.com",
)


class PushOutcome(StrEnum):
    ACCEPTED = "accepted"
    EXPIRED = "expired"
    REJECTED = "rejected"
    RETRYABLE = "retryable"
    UNKNOWN = "unknown"
    BLOCKED = "blocked"


@dataclass(frozen=True, repr=False)
class PushRequest:
    endpoint: str
    headers: dict[str, str]
    body: bytes


@dataclass(frozen=True, slots=True)
class PushResult:
    outcome: PushOutcome
    retry_after_seconds: int | None = None


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def decode_key(value: str, expected_size: int) -> bytes:
    if not value or len(value) > 256:
        raise ValueError("푸시 키 형식이 올바르지 않습니다")
    try:
        raw = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    except ValueError:
        raise ValueError("푸시 키 형식이 올바르지 않습니다") from None
    if len(raw) != expected_size:
        raise ValueError("푸시 키 길이가 올바르지 않습니다")
    return raw


def _private_key(value: str) -> ec.EllipticCurvePrivateKey:
    try:
        return ec.derive_private_key(int.from_bytes(decode_key(value, 32), "big"), ec.SECP256R1())
    except ValueError:
        raise ValueError("서버의 VAPID 키 구성을 확인하세요") from None


def vapid_public_key(private_key: str) -> str:
    return _b64(
        _private_key(private_key)
        .public_key()
        .public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    )


def validate_subscription(
    endpoint: str, p256dh: str, auth: str, *, allowed_hosts: tuple[str, ...] = DEFAULT_PUSH_HOSTS
) -> dict[str, Any]:
    if len(endpoint) > 4096:
        raise ValueError("푸시 구독 주소가 너무 깁니다")
    try:
        parsed = validate_url(endpoint, frozenset(allowed_hosts))
        if parsed.scheme != "https" or not parsed.path or parsed.path == "/":
            raise ValueError("허용된 HTTPS 푸시 구독 주소가 필요합니다")
        receiver = decode_key(p256dh, 65)
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), receiver)
        decode_key(auth, 16)
    except UnsafeRequest, ValueError:
        raise ValueError("푸시 구독 주소와 키를 확인하세요") from None
    return {"endpoint": str(parsed), "keys": {"p256dh": p256dh, "auth": auth}}


def build_push_request(
    subscription: dict[str, Any],
    *,
    private_key: str,
    subject: str,
    event_id: uuid.UUID,
    now: datetime,
    allowed_hosts: tuple[str, ...] = DEFAULT_PUSH_HOSTS,
) -> PushRequest:
    if now.tzinfo is None:
        raise ValueError("푸시 시각에는 시간대가 필요합니다")
    if not subject.startswith(("mailto:", "https://")) or len(subject) > 256:
        raise ValueError("VAPID 연락처를 확인하세요")
    checked = validate_subscription(
        subscription["endpoint"],
        subscription["keys"]["p256dh"],
        subscription["keys"]["auth"],
        allowed_hosts=allowed_hosts,
    )
    endpoint = httpx.URL(checked["endpoint"])
    signing = _private_key(private_key)
    claims = {
        "aud": f"{endpoint.scheme}://{endpoint.host}",
        "exp": int((now + timedelta(hours=1)).timestamp()),
        "sub": subject,
    }
    signed = (
        _b64(b'{"typ":"JWT","alg":"ES256"}')
        + "."
        + _b64(json.dumps(claims, separators=(",", ":")).encode())
    ).encode()
    der = signing.sign(signed, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    token = signed.decode() + "." + _b64(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    # 고정된 앱 제목·문구는 SW에서 표시한다. 제품명·가격·구매/소비 기록은 보내지 않는다.
    payload = json.dumps({"event_id": str(event_id)}, separators=(",", ":")).encode()
    body = http_ece.encrypt(
        payload,
        private_key=ec.generate_private_key(ec.SECP256R1()),
        dh=decode_key(checked["keys"]["p256dh"], 65),
        auth_secret=decode_key(checked["keys"]["auth"], 16),
        version="aes128gcm",
    )
    return PushRequest(
        str(endpoint),
        {
            "Authorization": f"vapid t={token}, k={vapid_public_key(private_key)}",
            "TTL": "300",
            "Content-Encoding": "aes128gcm",
        },
        body,
    )


async def send_push(
    request: PushRequest, *, transport: httpx.AsyncBaseTransport | None = None
) -> PushResult:
    """2xx는 push 서비스 접수이며 사용자 표시 성공이 아니다. timeout은 자동 재전송하지 않는다."""
    endpoint = httpx.URL(request.endpoint)
    try:
        async with SafeHttpClient(
            [endpoint.host],
            credential_host=endpoint.host,
            credential_headers=request.headers,
            transport=transport,
            limits=HttpLimits(
                deadline_seconds=10,
                io_timeout_seconds=5,
                max_response_bytes=4096,
                max_request_bytes=4096,
                max_redirects=0,
                max_retries=0,
            ),
        ) as client:
            response = await client.post(
                request.endpoint,
                content=request.body,
                headers={"content-type": "application/octet-stream"},
            )
        if 200 <= response.status_code < 300:
            return PushResult(PushOutcome.ACCEPTED)
        if response.status_code in {404, 410}:
            return PushResult(PushOutcome.EXPIRED)
        if response.status_code in {429, 503}:
            retry_after = response.headers.get("retry-after", "60")
            if retry_after.isascii() and retry_after.isdigit() and 1 <= int(retry_after) <= 3600:
                return PushResult(PushOutcome.RETRYABLE, max(60, int(retry_after)))
            return PushResult(PushOutcome.REJECTED)
        return PushResult(PushOutcome.REJECTED)
    except UnsafeRequest:
        return PushResult(PushOutcome.BLOCKED)
    except httpx.HTTPError, TimeoutError:
        return PushResult(PushOutcome.UNKNOWN)
