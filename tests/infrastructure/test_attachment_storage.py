"""저장 root 밖의 파일·symlink·변경된 바이트를 이미지 조회로 노출하지 않는다."""

import os
from pathlib import Path
from typing import Any

import pytest

from sooljang.infrastructure.storage import (
    StoredImageUnavailableError,
    compute_sha256,
    read_stored_image,
)
from tests.api.test_attachments import _minimal_png


def read(root: Path, relative: str, **changes: object) -> bytes:
    values: dict[str, Any] = {
        "content_type": "image/png",
        "byte_size": len(_minimal_png()),
        "sha256": compute_sha256(_minimal_png()),
        "max_bytes": 1024,
        **changes,
    }
    return read_stored_image(str(root), relative, **values)


@pytest.mark.parametrize(
    "relative",
    [
        "",
        "/outside.png",
        "../outside.png",
        "nested/../image.png",
        "nested//image.png",
        "./image.png",
        "nested\\image.png",
    ],
)
def test_absolute_and_noncanonical_paths_are_unavailable(tmp_path: Path, relative: str) -> None:
    (tmp_path / "image.png").write_bytes(_minimal_png())
    with pytest.raises(StoredImageUnavailableError):
        read(tmp_path, relative)


@pytest.mark.parametrize("directory_link", [False, True])
def test_neither_file_nor_parent_symlink_can_escape_root(
    tmp_path: Path, directory_link: bool
) -> None:
    root = tmp_path / "uploads"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "image.png").write_bytes(_minimal_png())
    if directory_link:
        (root / "nested").symlink_to(outside, target_is_directory=True)
        relative = "nested/image.png"
    else:
        (root / "image.png").symlink_to(outside / "image.png")
        relative = "image.png"
    with pytest.raises(StoredImageUnavailableError):
        read(root, relative)


@pytest.mark.parametrize("kind", ["directory", "fifo"])
def test_nonregular_files_are_rejected_without_blocking(tmp_path: Path, kind: str) -> None:
    path = tmp_path / "image.png"
    if kind == "directory":
        path.mkdir()
    else:
        os.mkfifo(path)
    with pytest.raises(StoredImageUnavailableError):
        read(tmp_path, "image.png")


@pytest.mark.parametrize(
    "changes",
    [
        {"content_type": "text/html"},
        {"content_type": "image/jpeg"},
        {"byte_size": 0},
        {"byte_size": 2},
        {"max_bytes": 1},
        {"sha256": "0" * 64},
    ],
)
def test_metadata_mismatch_and_size_limit_prevent_serving(tmp_path: Path, changes: dict) -> None:
    (tmp_path / "image.png").write_bytes(_minimal_png())
    with pytest.raises(StoredImageUnavailableError):
        read(tmp_path, "image.png", **changes)


def test_valid_bounded_original_is_returned_without_modification(tmp_path: Path) -> None:
    (tmp_path / "owner").mkdir()
    (tmp_path / "owner" / "image.png").write_bytes(_minimal_png())
    assert read(tmp_path, "owner/image.png") == _minimal_png()


def test_valid_size_and_hash_cannot_turn_html_into_an_image(tmp_path: Path) -> None:
    data = b"<html>synthetic</html>"
    (tmp_path / "image.png").write_bytes(data)
    with pytest.raises(StoredImageUnavailableError):
        read(tmp_path, "image.png", byte_size=len(data), sha256=compute_sha256(data))
