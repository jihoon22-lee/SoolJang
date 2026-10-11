"""버전을 확인한 합성 시음만 삭제하는 테스트 도우미."""

import uuid

import httpx
from fastapi.testclient import TestClient


def remove_tasting_record(client: TestClient, prefix: str, tasting_id: str) -> httpx.Response:
    url = f"{prefix}/tastings/{tasting_id}"
    row = client.get(url).json()
    return client.request(
        "DELETE",
        url,
        json={"request_id": str(uuid.uuid4()), "expected_updated_at": row["updated_at"]},
    )
