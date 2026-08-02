"""첨부파일 디스크 저장.

DB 에는 메타데이터만 두고 바이너리는 파일시스템에 둔다(`models/tasting.py::Attachment`
문서 참조) — 바이너리를 DB 에 넣으면 `pg_dump` 크기가 폭증해 실용적이지 않다.
"""

import hashlib
import uuid
from pathlib import Path

#: 허용하는 콘텐츠 타입과 저장 확장자. 첨부는 지금(Task 17 시점) 라벨·시음·병 사진뿐이라
#: 이미지로 좁힌다 — 임의 파일 형식을 받으면 검증·바이러스 스캔 등 다른 문제가 늘어난다.
ALLOWED_IMAGE_EXTENSIONS: dict[str, str] = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
}


def compute_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def save_upload(
    base_dir: str, *, user_id: uuid.UUID, sha256: str, extension: str, data: bytes
) -> str:
    """파일을 저장하고 DB `storage_path` 에 넣을 상대 경로를 반환한다.

    같은 사용자가 같은 내용을 다시 올리면(같은 sha256) 이미 있는 파일을 그대로 두고
    다시 쓰지 않는다 — 재전송·재시도가 디스크 쓰기를 반복하지 않게 한다.
    """
    relative = f"{user_id}/{sha256}{extension}"
    path = Path(base_dir) / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_bytes(data)
    return relative
