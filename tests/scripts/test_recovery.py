"""복구 묶음 실패가 성공으로 표시되거나 마지막 유효 백업을 지우지 않는다."""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, BinaryIO

import pytest
from cryptography.fernet import Fernet

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "recovery.py"
spec = importlib.util.spec_from_file_location("sooljang_recovery_script", SCRIPT)
assert spec is not None and spec.loader is not None
recovery = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = recovery
spec.loader.exec_module(recovery)


class FakeDatabase(recovery.Database):
    def __init__(self, name: str = "source") -> None:
        super().__init__(name, local=True)
        self.restored = False
        self.empty = True
        self.fail_dump = False
        self.fail_restore = False
        self.fail_toc = False
        self.state_value = {
            "row_counts": {"product": 1},
            "schema_revisions": ["test_head"],
            "attachments": [],
        }

    def require_quiesced(self, confirmed: bool) -> None:
        if not confirmed:
            raise recovery.RecoveryError("쓰기를 중지하세요")

    def require_empty(self) -> None:
        if not self.empty:
            raise recovery.RecoveryError("비어 있지 않습니다")

    def require_capacity(self, required: int, reserve: int) -> None:
        return None

    def state(self, _fernet: Fernet) -> dict[str, Any]:
        return self.state_value

    def sql(self, _statement: str) -> str:
        return "1024"

    def run(
        self,
        program: str,
        arguments: list[str],
        *,
        source: BinaryIO | None = None,
        destination: BinaryIO | None = None,
    ) -> bytes:
        if program == "pg_dump":
            assert destination is not None
            destination.write(b"synthetic database dump")
            if self.fail_dump:
                raise recovery.RecoveryError("pg_dump 실패")
        elif "--list" in arguments:
            if self.fail_toc:
                raise recovery.RecoveryError("pg_restore 실패")
            return b"123; 0 321 TABLE DATA public product owner"
        else:
            assert "--single-transaction" in arguments
            assert "--exit-on-error" in arguments
            assert "--clean" not in arguments
            if self.fail_restore:
                raise recovery.RecoveryError("pg_restore 실패")
            self.restored = True
        return b""


@pytest.fixture
def source_uploads(tmp_path: Path) -> Path:
    path = tmp_path / "source-uploads"
    path.mkdir()
    (path / "photo.png").write_bytes(b"\x89PNG\r\n\x1a\nsynthetic image")
    return path


@pytest.fixture
def bundle(tmp_path: Path, source_uploads: Path) -> Path:
    return recovery.create_backup(
        FakeDatabase(), tmp_path / "backups", source_uploads, writes_stopped=True, reserve=0
    )


def reseal(bundle: Path) -> None:
    (bundle / "COMPLETE").write_text(recovery.digest(bundle / "manifest.json"))


def test_complete_bundle_restores_to_new_location_and_preserves_source(
    bundle: Path, source_uploads: Path, tmp_path: Path
) -> None:
    target = FakeDatabase("target")
    destination = tmp_path / "restored-uploads"
    recovery.restore_backup(bundle, target, destination, reserve=0)
    assert target.restored
    assert recovery.inventory(destination) == recovery.inventory(source_uploads)
    assert bundle.exists()
    assert (bundle.stat().st_mode & 0o777) == 0o700
    for path in bundle.rglob("*"):
        assert path.stat().st_mode & 0o777 == (0o700 if path.is_dir() else 0o600)
    manifest = (bundle / "manifest.json").read_text()
    assert os.environ["SOOLJANG_SECRET_KEY"] not in manifest


@pytest.mark.parametrize("changed", ["database.dump", "manifest.json", "uploads/photo.png"])
def test_tampered_files_prevent_restore(bundle: Path, tmp_path: Path, changed: str) -> None:
    (bundle / changed).write_bytes(b"tampered")
    database = FakeDatabase("target")
    with pytest.raises(recovery.RecoveryError):
        recovery.restore_backup(bundle, database, tmp_path / "new", reserve=0)
    assert not database.restored
    assert not (tmp_path / "new").exists()


@pytest.mark.parametrize("missing", ["COMPLETE", "database.dump", "uploads/photo.png"])
def test_missing_files_prevent_restore(bundle: Path, missing: str) -> None:
    (bundle / missing).unlink()
    with pytest.raises(recovery.RecoveryError):
        recovery.verify_bundle(bundle, FakeDatabase())


def test_wrong_key_does_not_start_restore(
    bundle: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SOOLJANG_SECRET_KEY", Fernet.generate_key().decode())
    database = FakeDatabase("target")
    with pytest.raises(recovery.RecoveryError, match="마스터 키"):
        recovery.restore_backup(bundle, database, tmp_path / "new")
    assert not database.restored


def test_missing_key_does_not_delete_existing_backup(
    bundle: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("SOOLJANG_SECRET_KEY")
    with pytest.raises(recovery.RecoveryError, match="복구 마스터 키"):
        recovery.verify_bundle(bundle, FakeDatabase())
    assert (bundle / "COMPLETE").is_file()


def test_invalid_dump_toc_failure_is_not_swallowed(bundle: Path) -> None:
    database = FakeDatabase()
    database.fail_toc = True
    with pytest.raises(recovery.RecoveryError, match="pg_restore"):
        recovery.verify_bundle(bundle, database)


def test_restore_error_keeps_active_uploads_and_never_publishes_target(
    bundle: Path, tmp_path: Path
) -> None:
    database = FakeDatabase("target")
    database.fail_restore = True
    with pytest.raises(recovery.RecoveryError, match="pg_restore"):
        recovery.restore_backup(bundle, database, tmp_path / "new", reserve=0)
    assert not (tmp_path / "new").exists()
    assert not list(tmp_path.glob(".restore-*"))
    assert (bundle / "uploads/photo.png").exists()


def test_restore_refuses_existing_database_or_upload_location(bundle: Path, tmp_path: Path) -> None:
    database = FakeDatabase("target")
    database.empty = False
    with pytest.raises(recovery.RecoveryError, match="비어"):
        recovery.restore_backup(bundle, database, tmp_path / "new", reserve=0)
    database.empty = True
    with pytest.raises(recovery.RecoveryError, match="새 경로"):
        recovery.restore_backup(bundle, database, tmp_path, reserve=0)
    with pytest.raises(recovery.RecoveryError, match="다른 격리"):
        recovery.restore_backup(bundle, FakeDatabase("source"), tmp_path / "new", reserve=0)
    assert not database.restored


def test_dump_failure_never_publishes_complete_backup(tmp_path: Path, source_uploads: Path) -> None:
    database = FakeDatabase()
    database.fail_dump = True
    with pytest.raises(recovery.RecoveryError, match="pg_dump"):
        recovery.create_backup(database, tmp_path / "backups", source_uploads, writes_stopped=True)
    assert not list((tmp_path / "backups").glob("sooljang-*"))
    assert not list((tmp_path / "backups").glob(".partial-*"))


def test_backup_requires_stopped_writers(tmp_path: Path, source_uploads: Path) -> None:
    with pytest.raises(recovery.RecoveryError, match="중지"):
        recovery.create_backup(
            FakeDatabase(), tmp_path / "backups", source_uploads, writes_stopped=False
        )


def test_low_disk_space_does_not_touch_source(
    tmp_path: Path, source_uploads: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    usage = shutil.disk_usage(tmp_path)
    monkeypatch.setattr(recovery.shutil, "disk_usage", lambda _: type(usage)(100, 99, 1))
    with pytest.raises(recovery.RecoveryError, match="여유 공간"):
        recovery.create_backup(
            FakeDatabase(), tmp_path / "backups", source_uploads, writes_stopped=True
        )
    assert (source_uploads / "photo.png").exists()
    assert not list((tmp_path / "backups").glob("sooljang-*"))


def test_missing_attachment_reference_fails_before_dump(
    tmp_path: Path, source_uploads: Path
) -> None:
    database = FakeDatabase()
    database.state_value["attachments"] = [{"path": "missing.png", "sha256": "0" * 64, "bytes": 42}]
    with pytest.raises(recovery.RecoveryError, match="첨부 참조"):
        recovery.create_backup(database, tmp_path / "backups", source_uploads, writes_stopped=True)


def test_symlinks_are_not_archived(source_uploads: Path, tmp_path: Path) -> None:
    (source_uploads / "outside").symlink_to(tmp_path / "unreadable")
    with pytest.raises(recovery.RecoveryError, match="symlink"):
        recovery.inventory(source_uploads)


def test_pruning_preserves_last_valid_backup_and_legacy_or_partial_files(bundle: Path) -> None:
    directory = bundle.parent
    legacy = directory / "sooljang-old.dump"
    legacy.write_bytes(b"legacy")
    partial = directory / ".partial-interrupted"
    partial.mkdir()
    corrupt = directory / "sooljang-20260907T010101000000Z-ffffffff"
    shutil.copytree(bundle, corrupt)
    (corrupt / "uploads/photo.png").unlink()
    recovery.prune_backups(directory, 1, FakeDatabase())
    assert bundle.exists() and legacy.exists() and partial.exists() and corrupt.exists()
    with pytest.raises(recovery.RecoveryError, match="1 이상"):
        recovery.prune_backups(directory, 0, FakeDatabase())


def test_pruning_removes_only_old_verified_bundles(bundle: Path) -> None:
    old = bundle.parent / "sooljang-20000101T010101000000Z-aaaaaaaa"
    shutil.copytree(bundle, old)
    recovery.prune_backups(bundle.parent, 1, FakeDatabase())
    assert not old.exists()
    assert bundle.exists()


def test_plain_dump_is_not_mistaken_for_full_recovery_bundle(tmp_path: Path) -> None:
    dump = tmp_path / "legacy.dump"
    dump.write_bytes(b"legacy")
    with pytest.raises(recovery.RecoveryError, match="DB 전용"):
        recovery.verify_bundle(dump, FakeDatabase())


def test_cli_failure_returns_nonzero_without_success_message(tmp_path: Path) -> None:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--local", "--verify", str(tmp_path / "missing")],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert "error:" in result.stderr
    assert "완료" not in result.stdout
    assert "Traceback" not in result.stderr


def test_restore_detects_mismatched_row_counts(bundle: Path, tmp_path: Path) -> None:
    database = FakeDatabase("target")
    database.state_value["row_counts"]["product"] = 999
    with pytest.raises(recovery.RecoveryError, match="대조"):
        recovery.restore_backup(bundle, database, tmp_path / "new", reserve=0)
    assert not (tmp_path / "new").exists()


def test_unsupported_manifest_is_rejected(bundle: Path) -> None:
    manifest = json.loads((bundle / "manifest.json").read_text())
    manifest["format_version"] = 999
    (bundle / "manifest.json").write_text(json.dumps(manifest))
    reseal(bundle)
    with pytest.raises(recovery.RecoveryError, match="지원하지"):
        recovery.verify_bundle(bundle, FakeDatabase())


def test_database_connection_string_cannot_leak_into_manifest() -> None:
    with pytest.raises(recovery.RecoveryError, match="DB 이름"):
        recovery.Database("postgresql://someone:private-value@host/database")


def test_compose_backup_requires_actual_deployment_version(tmp_path: Path) -> None:
    with pytest.raises(recovery.RecoveryError, match="실제 배포 버전"):
        recovery.create_backup(recovery.Database("source"), tmp_path, None, writes_stopped=True)


def test_backup_records_deployed_version_separately_from_tool(
    tmp_path: Path, source_uploads: Path
) -> None:
    bundle = recovery.create_backup(
        FakeDatabase(),
        tmp_path / "backups",
        source_uploads,
        writes_stopped=True,
        reserve=0,
        app_version="1.0.0",
    )
    manifest = recovery.verify_bundle(bundle, FakeDatabase())
    assert manifest["app_version"] == "1.0.0"
    assert manifest["backup_tool_version"] == recovery.__version__


def test_client_errors_do_not_disclose_password_or_sql(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail(*_args: Any, **_kwargs: Any) -> Any:
        raise subprocess.CalledProcessError(1, "psql", stderr=b"password=synthetic-sensitive-value")

    monkeypatch.setattr(recovery.subprocess, "run", fail)
    with pytest.raises(recovery.RecoveryError) as error:
        recovery.Database("source", local=True).sql("SELECT 1")
    assert "sensitive" not in str(error.value)
    assert "psql" in str(error.value)


def test_running_api_is_not_backed_up(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        recovery.subprocess,
        "run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0, stdout=b"db\napi\nweb\n"),
    )
    with pytest.raises(recovery.RecoveryError, match="API 컨테이너"):
        recovery.Database("source").require_quiesced(True)


def test_restore_checks_database_disk_before_creating_files(bundle: Path, tmp_path: Path) -> None:
    class FullDatabase(FakeDatabase):
        def require_capacity(self, required: int, reserve: int) -> None:
            raise recovery.RecoveryError("DB 디스크 여유 공간이 부족합니다")

    database = FullDatabase("target")
    with pytest.raises(recovery.RecoveryError, match="DB 디스크"):
        recovery.restore_backup(bundle, database, tmp_path / "new", reserve=0)
    assert not database.restored
    assert not (tmp_path / "new").exists()


def test_interrupted_backup_does_not_publish_partial_files(
    tmp_path: Path, source_uploads: Path
) -> None:
    class InterruptedDatabase(FakeDatabase):
        def run(self, *args: Any, **kwargs: Any) -> bytes:
            super().run(*args, **kwargs)
            raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        recovery.create_backup(
            InterruptedDatabase(), tmp_path / "backups", source_uploads, writes_stopped=True
        )
    assert not list((tmp_path / "backups").glob("sooljang-*"))
    assert not list((tmp_path / "backups").glob(".partial-*"))
