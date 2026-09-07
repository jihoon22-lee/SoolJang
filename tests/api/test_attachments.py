"""첨부파일 업로드 API 테스트."""

import struct
import zlib
from typing import Any

from fastapi.testclient import TestClient


def _minimal_png() -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    signature = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    idat = zlib.compress(b"\x00" + b"\xff\x00\x00")
    return signature + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def _seed_product(client: TestClient, prefix: str, *, name: str = "가상 위스키") -> dict[str, Any]:
    response = client.post(f"{prefix}/products", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def _seed_sku(client: TestClient, prefix: str, *, name: str) -> str:
    product = _seed_product(client, prefix, name=name)
    sku = client.post(f"{prefix}/products/{product['id']}/skus", json={"volume_ml": 700})
    assert sku.status_code == 201, sku.text
    return sku.json()["id"]


def _seed_bottle(client: TestClient, prefix: str) -> str:
    sku_id = _seed_sku(client, prefix, name="병 첨부용 위스키")

    purchase = client.post(
        f"{prefix}/purchases", json={"sku_id": sku_id, "quantity": 1, "unit_list_price": "10000"}
    )
    assert purchase.status_code == 201, purchase.text

    bottles = client.get(f"{prefix}/purchases/{purchase.json()['id']}/bottles")
    assert bottles.status_code == 200, bottles.text
    return bottles.json()[0]["id"]


def _seed_tasting_session(client: TestClient, prefix: str) -> str:
    sku_id = _seed_sku(client, prefix, name="시음 첨부용 위스키")

    tasting = client.post(f"{prefix}/tastings", json={"sku_id": sku_id, "tasted_on": "2026-08-01"})
    assert tasting.status_code == 201, tasting.text
    return tasting.json()["id"]


def test_제품에_라벨_사진을_붙인다(api_client: TestClient, prefix: str) -> None:
    product = _seed_product(api_client, prefix)

    response = api_client.post(
        f"{prefix}/attachments",
        files={"file": ("label.png", _minimal_png(), "image/png")},
        data={"kind": "label", "product_id": product["id"]},
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["kind"] == "label"
    assert body["product_id"] == product["id"]
    assert body["content_type"] == "image/png"
    assert body["byte_size"] > 0


def test_같은_파일을_다시_올리면_기존_첨부를_재사용한다(
    api_client: TestClient, prefix: str
) -> None:
    product = _seed_product(api_client, prefix)
    png = _minimal_png()

    first = api_client.post(
        f"{prefix}/attachments",
        files={"file": ("label.png", png, "image/png")},
        data={"kind": "label", "product_id": product["id"]},
    )
    second = api_client.post(
        f"{prefix}/attachments",
        files={"file": ("label-again.png", png, "image/png")},
        data={"kind": "label", "product_id": product["id"]},
    )

    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    assert first.json()["id"] == second.json()["id"]


def test_같은_파일이어도_다른_제품에_붙이면_각자_새_첨부가_된다(
    api_client: TestClient, prefix: str
) -> None:
    """중복 제거를 `(user_id, sha256, kind)` 로만 판단하면 소유 대상(product_id)을
    무시해, 같은 라벨 사진을 다른 제품에 붙일 때 앞서 만든 첨부가 그대로 반환되고
    새 제품엔 아무것도 안 붙는다 — 요청은 201 로 성공하는데 실제로는 조용히 실패하는
    셈이었다."""
    product_a = _seed_product(api_client, prefix, name="첫 번째 위스키")
    product_b = _seed_product(api_client, prefix, name="두 번째 위스키")
    png = _minimal_png()

    first = api_client.post(
        f"{prefix}/attachments",
        files={"file": ("label.png", png, "image/png")},
        data={"kind": "label", "product_id": product_a["id"]},
    )
    second = api_client.post(
        f"{prefix}/attachments",
        files={"file": ("label.png", png, "image/png")},
        data={"kind": "label", "product_id": product_b["id"]},
    )

    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    assert first.json()["id"] != second.json()["id"]
    assert first.json()["product_id"] == product_a["id"]
    assert second.json()["product_id"] == product_b["id"]


def test_소유자를_지정하지_않으면_422(api_client: TestClient, prefix: str) -> None:
    response = api_client.post(
        f"{prefix}/attachments",
        files={"file": ("label.png", _minimal_png(), "image/png")},
        data={"kind": "label"},
    )

    assert response.status_code == 422, response.text


def test_소유자를_둘_이상_지정하면_422(api_client: TestClient, prefix: str) -> None:
    product = _seed_product(api_client, prefix)

    response = api_client.post(
        f"{prefix}/attachments",
        files={"file": ("label.png", _minimal_png(), "image/png")},
        data={"kind": "label", "product_id": product["id"], "bottle_id": product["id"]},
    )

    assert response.status_code == 422, response.text


def test_존재하지_않는_제품이면_404(api_client: TestClient, prefix: str) -> None:
    response = api_client.post(
        f"{prefix}/attachments",
        files={"file": ("label.png", _minimal_png(), "image/png")},
        data={"kind": "label", "product_id": "00000000-0000-0000-0000-000000000000"},
    )

    assert response.status_code == 404, response.text


def test_병에_사진을_붙인다(api_client: TestClient, prefix: str) -> None:
    bottle_id = _seed_bottle(api_client, prefix)

    response = api_client.post(
        f"{prefix}/attachments",
        files={"file": ("bottle.png", _minimal_png(), "image/png")},
        data={"kind": "bottle", "bottle_id": bottle_id},
    )

    assert response.status_code == 201, response.text
    assert response.json()["bottle_id"] == bottle_id


def test_존재하지_않는_병이면_404(api_client: TestClient, prefix: str) -> None:
    response = api_client.post(
        f"{prefix}/attachments",
        files={"file": ("bottle.png", _minimal_png(), "image/png")},
        data={"kind": "bottle", "bottle_id": "00000000-0000-0000-0000-000000000000"},
    )

    assert response.status_code == 404, response.text


def test_시음_기록에_사진을_붙인다(api_client: TestClient, prefix: str) -> None:
    tasting_id = _seed_tasting_session(api_client, prefix)

    response = api_client.post(
        f"{prefix}/attachments",
        files={"file": ("tasting.png", _minimal_png(), "image/png")},
        data={"kind": "tasting", "tasting_session_id": tasting_id},
    )

    assert response.status_code == 201, response.text
    assert response.json()["tasting_session_id"] == tasting_id


def test_존재하지_않는_시음_기록이면_404(api_client: TestClient, prefix: str) -> None:
    response = api_client.post(
        f"{prefix}/attachments",
        files={"file": ("tasting.png", _minimal_png(), "image/png")},
        data={"kind": "tasting", "tasting_session_id": "00000000-0000-0000-0000-000000000000"},
    )

    assert response.status_code == 404, response.text


def test_지원하지_않는_파일_형식은_422(api_client: TestClient, prefix: str) -> None:
    product = _seed_product(api_client, prefix)

    response = api_client.post(
        f"{prefix}/attachments",
        files={"file": ("note.txt", b"hello", "text/plain")},
        data={"kind": "label", "product_id": product["id"]},
    )

    assert response.status_code == 422, response.text


def test_빈_파일은_422(api_client: TestClient, prefix: str) -> None:
    product = _seed_product(api_client, prefix)

    response = api_client.post(
        f"{prefix}/attachments",
        files={"file": ("label.png", b"", "image/png")},
        data={"kind": "label", "product_id": product["id"]},
    )

    assert response.status_code == 422, response.text


def test_내용이_선언한_형식과_다르면_422(api_client: TestClient, prefix: str) -> None:
    # content_type 은 클라이언트가 보낸 값이라 신뢰할 수 없다(B11) — PNG 라고 주장하는
    # 파일의 실제 바이트가 PNG 서명과 다르면 거부해야 한다.
    product = _seed_product(api_client, prefix)

    response = api_client.post(
        f"{prefix}/attachments",
        files={"file": ("label.png", b"this is not actually a png", "image/png")},
        data={"kind": "label", "product_id": product["id"]},
    )

    assert response.status_code == 422, response.text


def _upload(client: TestClient, prefix: str, **owner: str) -> dict[str, Any]:
    response = client.post(
        f"{prefix}/attachments",
        files={"file": ("합성 라벨.png", _minimal_png(), "image/png")},
        data={"kind": "label", "caption": "합성 복구 라벨", **owner},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_owner_reads_original_image_and_product_metadata_without_storage_paths(
    api_client: TestClient, prefix: str
) -> None:
    product = _seed_product(api_client, prefix)
    image = _upload(api_client, prefix, product_id=product["id"])
    response = api_client.get(f"{prefix}/attachments/{image['id']}/content")
    assert response.status_code == 200
    assert response.content == _minimal_png()
    assert response.headers["content-type"] == "image/png"
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in response.headers["content-security-policy"]
    assert response.headers["content-disposition"] == f'inline; filename="{image["id"]}.png"'
    listed = api_client.get(f"{prefix}/attachments", params={"product_id": product["id"]})
    assert listed.json() == [image]
    assert "storage_path" not in listed.text and "sha256" not in listed.text
    assert listed.headers["cache-control"] == "private, no-store"


def test_attachment_read_requires_authentication_and_rejects_another_logged_in_user(
    api_client: TestClient, prefix: str
) -> None:
    from sooljang.application.auth import hash_password
    from sooljang.infrastructure.database.models import User
    from sooljang.infrastructure.database.session import get_session_factory

    product = _seed_product(api_client, prefix)
    image = _upload(api_client, prefix, product_id=product["id"])

    async def second_user() -> None:
        async with get_session_factory().begin() as session:
            session.add(
                User(
                    email="attachment-other@example.com",
                    display_name="합성 다른 사용자",
                    password_hash=hash_password("attachment-other-password"),
                )
            )

    assert api_client.portal is not None
    api_client.portal.call(second_user)
    api_client.cookies.clear()
    path = f"{prefix}/attachments/{image['id']}/content"
    assert api_client.get(path).status_code == 401
    assert (
        api_client.get(f"{prefix}/attachments", params={"product_id": product["id"]}).status_code
        == 401
    )
    login = api_client.post(
        f"{prefix}/auth/login",
        json={"email": "attachment-other@example.com", "password": "attachment-other-password"},
    )
    assert login.status_code == 200
    assert api_client.get(path).status_code == 404
    assert (
        api_client.get(f"{prefix}/attachments", params={"product_id": product["id"]}).status_code
        == 404
    )


def test_deleted_or_missing_attachment_is_not_served(api_client: TestClient, prefix: str) -> None:
    import uuid
    from datetime import UTC, datetime

    from sooljang.infrastructure.database.models import Attachment
    from sooljang.infrastructure.database.session import get_session_factory

    product = _seed_product(api_client, prefix)
    image = _upload(api_client, prefix, product_id=product["id"])

    async def remove() -> None:
        async with get_session_factory().begin() as session:
            attachment = await session.get(Attachment, uuid.UUID(image["id"]))
            assert attachment is not None
            attachment.deleted_at = datetime.now(UTC)

    assert api_client.portal is not None
    api_client.portal.call(remove)
    for attachment_id in (image["id"], str(uuid.uuid4())):
        assert api_client.get(f"{prefix}/attachments/{attachment_id}/content").status_code == 404
    assert (
        api_client.get(f"{prefix}/attachments", params={"product_id": product["id"]}).json() == []
    )


def test_deleted_product_prevents_reading_its_attachment(
    api_client: TestClient, prefix: str
) -> None:
    product = _seed_product(api_client, prefix)
    image = _upload(api_client, prefix, product_id=product["id"])
    assert api_client.delete(f"{prefix}/products/{product['id']}").status_code == 204
    assert api_client.get(f"{prefix}/attachments/{image['id']}/content").status_code == 404
    assert (
        api_client.get(f"{prefix}/attachments", params={"product_id": product["id"]}).status_code
        == 404
    )


def test_bottle_and_tasting_owners_can_read_their_attachments(
    api_client: TestClient, prefix: str
) -> None:
    owners = [
        {"bottle_id": _seed_bottle(api_client, prefix)},
        {"tasting_session_id": _seed_tasting_session(api_client, prefix)},
    ]
    for owner in owners:
        image = _upload(api_client, prefix, **owner)
        response = api_client.get(f"{prefix}/attachments/{image['id']}/content")
        assert response.status_code == 200 and response.content == _minimal_png()


def test_missing_or_changed_disk_file_returns_generic_not_found(
    api_client: TestClient, prefix: str
) -> None:
    from pathlib import Path

    from sooljang.config import get_settings

    product = _seed_product(api_client, prefix)
    image = _upload(api_client, prefix, product_id=product["id"])
    stored = next(Path(get_settings().upload_dir).rglob("*.png"))
    stored.write_bytes(b"<html>not an image</html>")
    path = f"{prefix}/attachments/{image['id']}/content"
    for _ in range(2):
        response = api_client.get(path)
        assert response.status_code == 404
        assert str(stored) not in response.text and "not an image" not in response.text
        stored.unlink(missing_ok=True)
