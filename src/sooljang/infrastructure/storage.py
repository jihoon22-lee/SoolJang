"""첨부파일 디스크 저장.

DB 에는 메타데이터만 두고 바이너리는 파일시스템에 둔다(`models/tasting.py::Attachment`
문서 참조) — 바이너리를 DB 에 넣으면 `pg_dump` 크기가 폭증해 실용적이지 않다.
"""

import hashlib
import uuid
from pathlib import Path
from typing import Protocol

#: 허용하는 콘텐츠 타입과 저장 확장자. 첨부는 지금(Task 17 시점) 라벨·시음·병 사진뿐이라
#: 이미지로 좁힌다 — 임의 파일 형식을 받으면 검증·바이러스 스캔 등 다른 문제가 늘어난다.
ALLOWED_IMAGE_EXTENSIONS: dict[str, str] = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
}

#: 업로드를 한 번에 읽는 조각 크기. 상한 초과를 감지하는 데 전체를 메모리에 올릴 필요가
#: 없다.
_READ_CHUNK_BYTES = 1024 * 1024


class UploadTooLargeError(Exception):
    """업로드가 상한을 넘었다. 라우터가 잡아 사용자에게 보여줄 HTTP 오류로 바꾼다.

    인프라 계층은 API 계층(`ValidationFailedError`)을 몰라야 하므로, 여기서는 평범한
    예외만 던지고 변환은 호출자가 한다(`legacy/blocks.py::LegacySheetError` 와 같은 패턴).
    """


class _SupportsChunkedRead(Protocol):
    async def read(self, size: int = ...) -> bytes: ...


async def read_upload_within_limit(file: _SupportsChunkedRead, *, max_bytes: int) -> bytes:
    """업로드를 상한까지만 읽는다.

    `await file.read()` 로 전체를 한 번에 읽은 뒤 길이를 검사하면, 사용자가 실수로 수백MB
    짜리 파일(예: 폰에서 사진 대신 4K 영상)을 고른 경우 상한을 넘는지 알기도 전에 그
    전량을 메모리에 올려 버린다. 여기서는 상한을 넘는 순간 곧바로 멈춘다.
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(_READ_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise UploadTooLargeError(f"업로드가 상한({max_bytes:,} bytes)을 넘었습니다")
        chunks.append(chunk)
    return b"".join(chunks)


#: HEIC/HEIF 는 ISO 기반 미디어 컨테이너(ftyp 박스)를 쓰는데, MP4/MOV 동영상도 같은
#: 컨테이너 구조를 쓴다 — 그래서 브랜드까지 확인해야 "사진 대신 영상을 잘못 골랐다" 를
#: 실제로 구분할 수 있다. 아이폰이 실제로 쓰는 값 위주로 좁혔다.
_HEIC_BRANDS = frozenset(
    {b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevm", b"hevs", b"mif1", b"msf1"}
)


def sniff_image_extension(data: bytes) -> str | None:
    """매직 바이트로 실제 이미지 형식을 판별한다.

    `content_type` 은 클라이언트가 보낸 값이라 신뢰할 수 없다 — 브라우저가 확장자만
    보고 잘못 채우거나, 요청을 직접 조작해 임의 파일을 이미지인 척 올릴 수 있다.
    """
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    if data[4:8] == b"ftyp" and data[8:12] in _HEIC_BRANDS:
        return ".heic"
    return None


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
