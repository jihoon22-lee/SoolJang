"""완료된 DB·uploads 복구 묶음만 게시하고 빈 격리 대상에 복원한다.

CLI는 scripts/backup.sh. DB와 파일의 원자성을 주장하지 않으며 쓰기 중지를 필수로 한다.
키는 환경으로만 입력하고 manifest에는 암호화된 복구 확인 문장만 보관한다.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, BinaryIO

from cryptography.fernet import Fernet, InvalidToken

from sooljang import __version__

FORMAT_VERSION = 1
KEY_PROBE = b"sooljang-recovery-key-v1"
RESERVE_BYTES = 64 * 1024 * 1024
BUNDLE_PATTERN = re.compile(r"sooljang-\d{8}T\d{12}Z-[a-f0-9]{8}")


class RecoveryError(Exception):
    """안전하게 공개할 수 있는 복구 실패 사유."""


def digest(path: Path) -> str:
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def inventory(directory: Path) -> dict[str, dict[str, str | int]]:
    """상대 경로별 checksum. symlink·특수파일은 복구 묶음에 허용하지 않는다."""
    if directory.is_symlink() or not directory.is_dir():
        raise RecoveryError("uploads 디렉터리가 없거나 안전한 디렉터리가 아닙니다")
    result = {}
    for path in sorted(directory.rglob("*")):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise RecoveryError("uploads에 symlink 또는 특수파일이 있습니다")
        if path.is_file():
            result[path.relative_to(directory).as_posix()] = {
                "bytes": path.stat().st_size,
                "sha256": digest(path),
            }
    return result


def require_space(path: Path, required: int, reserve: int = RESERVE_BYTES) -> None:
    if reserve < 0 or shutil.disk_usage(path).free < required + reserve:
        raise RecoveryError("복구 작업용 여유 공간이 부족합니다")


def key_from_environment() -> Fernet:
    try:
        return Fernet(os.environ["SOOLJANG_SECRET_KEY"].encode())
    except (KeyError, ValueError) as exc:
        raise RecoveryError(
            "복구 마스터 키가 없거나 유효하지 않습니다; 설정을 초기화하지 않습니다"
        ) from exc


def check_key(fernet: Fernet, token: str) -> None:
    try:
        if fernet.decrypt(token.encode()) != KEY_PROBE:
            raise InvalidToken
    except (InvalidToken, ValueError) as exc:
        raise RecoveryError(
            "백업과 마스터 키가 일치하지 않습니다; 복구 키 확인이 필요합니다"
        ) from exc


def secure_tree(directory: Path) -> None:
    directory.chmod(0o700)
    for path in directory.rglob("*"):
        path.chmod(0o700 if path.is_dir() else 0o600)


def sync_tree(directory: Path) -> None:
    """완료 이름 게시 전에 파일과 디렉터리 엔트리를 영속화한다."""
    for path in [*directory.rglob("*"), directory]:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


@dataclass
class Database:
    """local은 libpq 환경(PGHOST/PGPORT/PGUSER/PGPASSFILE), 기본은 Compose DB."""

    name: str
    local: bool = False
    timeout: int = 600

    def __post_init__(self) -> None:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,62}", self.name):
            raise RecoveryError("DB 이름만 지정하세요; URL·접속 문자열은 인자로 받지 않습니다")

    @staticmethod
    def compose(arguments: list[str]) -> list[str]:
        command = ["docker", "compose", *arguments]
        if os.environ.get("SOOLJANG_DOCKER_SG"):
            return ["/usr/bin/sg", "docker", "-c", shlex.join(command)]
        return command

    def run(
        self,
        program: str,
        arguments: list[str],
        *,
        source: BinaryIO | None = None,
        destination: BinaryIO | None = None,
    ) -> bytes:
        if self.local:
            command = [str(Path(os.environ.get("SOOLJANG_PG_BIN", "")) / program), *arguments]
        else:
            if program in {"psql", "pg_dump", "pg_restore"} and "-d" in arguments:
                arguments = ["-U", os.environ.get("SOOLJANG_DB_USER", "sooljang"), *arguments]
            command = self.compose(["exec", "-T", "db", program, *arguments])
        try:
            completed = subprocess.run(
                command,
                stdin=source,
                stdout=destination or subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=self.timeout,
                check=True,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            # libpq/SQL 오류에는 URL, 데이터, 자격증명이 섞일 수 있다.
            raise RecoveryError(f"{program} 실행 실패; 완료되지 않았습니다") from exc
        return completed.stdout or b""

    def sql(self, statement: str) -> str:
        return (
            self.run(
                "psql", ["-X", "-v", "ON_ERROR_STOP=1", "-At", "-d", self.name, "-c", statement]
            )
            .decode()
            .strip()
        )

    def state(self, fernet: Fernet) -> dict[str, Any]:
        tables = json.loads(
            self.sql(
                "SELECT coalesce(json_agg(tablename ORDER BY tablename), '[]'::json) "
                "FROM pg_tables WHERE schemaname = 'public'"
            )
        )
        counts = {}
        for table in tables:
            quoted = '"' + table.replace('"', '""') + '"'
            counts[table] = int(self.sql(f"SELECT count(*) FROM public.{quoted}"))
        revisions = []
        if "alembic_version" in tables:
            revisions = json.loads(
                self.sql(
                    "SELECT coalesce(json_agg(version_num ORDER BY version_num), '[]'::json) "
                    "FROM alembic_version"
                )
            )
        attachments = []
        if "attachment" in tables:
            attachments = json.loads(
                self.sql(
                    "SELECT coalesce(json_agg(json_build_object('path', storage_path, "
                    "'sha256', sha256, 'bytes', byte_size) ORDER BY storage_path, id), "
                    "'[]'::json) FROM attachment"
                )
            )
        encrypted = json.loads(
            self.sql(
                "SELECT coalesce(json_agg(json_build_array(table_name, column_name)), '[]'::json) "
                "FROM information_schema.columns WHERE table_schema = 'public' "
                "AND data_type = 'bytea' AND column_name LIKE '%ciphertext'"
            )
        )
        for table, column in encrypted:
            quoted_table = '"' + table.replace('"', '""') + '"'
            quoted_column = '"' + column.replace('"', '""') + '"'
            tokens = json.loads(
                self.sql(
                    f"SELECT coalesce(json_agg(encode({quoted_column}, 'hex')), '[]'::json) "
                    f"FROM public.{quoted_table} WHERE {quoted_column} IS NOT NULL"
                )
            )
            for token in tokens:
                try:
                    fernet.decrypt(bytes.fromhex(token))
                except (InvalidToken, ValueError) as exc:
                    raise RecoveryError(
                        "DB 암호문을 복구 키로 열 수 없습니다; 원본은 보존됩니다"
                    ) from exc
        return {"row_counts": counts, "schema_revisions": revisions, "attachments": attachments}

    def require_empty(self) -> None:
        count = self.sql(
            "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') "
            "AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f')"
        )
        if count != "0":
            raise RecoveryError("복원 대상 DB가 비어 있지 않습니다; 활성 DB에 덮어쓰지 않습니다")

    def require_capacity(self, required: int, reserve: int) -> None:
        """덤프 압축 크기가 아닌 원본 DB 크기로 target DB 디스크도 사전 검사한다."""
        data_directory = self.sql("SHOW data_directory")
        if self.local:
            require_space(Path(data_directory), required, reserve)
            return
        try:
            output = subprocess.run(
                self.compose(["exec", "-T", "db", "df", "-Pk", data_directory]),
                check=True,
                capture_output=True,
                timeout=30,
            ).stdout.decode()
            available = int(output.splitlines()[-1].split()[3]) * 1024
        except (OSError, subprocess.SubprocessError, ValueError, IndexError) as exc:
            raise RecoveryError("복원 DB 디스크 여유 공간을 확인할 수 없습니다") from exc
        if available < required + reserve:
            raise RecoveryError("복원 DB 디스크 여유 공간이 부족합니다")

    def require_quiesced(self, confirmed: bool) -> None:
        if not confirmed:
            raise RecoveryError("모든 쓰기 경로를 중지한 뒤 --writes-stopped를 지정하세요")
        if not self.local:
            try:
                running = (
                    subprocess.run(
                        self.compose(["ps", "--status", "running", "--services"]),
                        capture_output=True,
                        check=True,
                        timeout=30,
                    )
                    .stdout.decode()
                    .splitlines()
                )
            except (OSError, subprocess.SubprocessError) as exc:
                raise RecoveryError("Compose 쓰기 중지 상태를 확인할 수 없습니다") from exc
            if "api" in running:
                raise RecoveryError("API 컨테이너가 실행 중입니다; 쓰기를 중지한 뒤 백업하세요")
        active = self.sql(
            "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() "
            "AND pid <> pg_backend_pid() AND backend_type='client backend'"
        )
        if active != "0":
            raise RecoveryError("대상 DB에 다른 세션이 있습니다; 쓰기 경로를 중지하세요")


def validate_attachments(state: dict[str, Any], files: dict[str, Any]) -> None:
    for attachment in state["attachments"]:
        if files.get(attachment["path"]) != {
            "sha256": attachment["sha256"],
            "bytes": attachment["bytes"],
        }:
            raise RecoveryError("DB 첨부 참조와 uploads의 크기/체크섬이 일치하지 않습니다")


def verify_bundle(bundle: Path, database: Database, *, check_secret: bool = True) -> dict[str, Any]:
    """체크섬과 TOC 검사. 실제 DB 복원 성공을 뜻하지 않는다."""
    if bundle.is_symlink() or not bundle.is_dir():
        raise RecoveryError("완료된 백업 디렉터리가 필요합니다; 기존 .dump는 DB 전용입니다")
    try:
        for name in ("manifest.json", "COMPLETE", "database.dump"):
            if (bundle / name).is_symlink() or not (bundle / name).is_file():
                raise RecoveryError("백업이 부분 생성되었거나 필수 파일이 없습니다")
        if (bundle / "COMPLETE").read_text().strip() != digest(bundle / "manifest.json"):
            raise RecoveryError("manifest 체크섬이 일치하지 않습니다")
        manifest = json.loads((bundle / "manifest.json").read_text())
        if manifest["format_version"] != FORMAT_VERSION:
            raise RecoveryError("지원하지 않는 백업 형식입니다")
        if manifest["database"]["sha256"] != digest(bundle / "database.dump"):
            raise RecoveryError("DB 덤프 체크섬이 일치하지 않습니다")
        if manifest["database"]["bytes"] != (bundle / "database.dump").stat().st_size:
            raise RecoveryError("DB 덤프 크기가 일치하지 않습니다")
        files = inventory(bundle / "uploads")
        if files != manifest["uploads"]:
            raise RecoveryError("uploads가 누락되거나 변경되었습니다")
        validate_attachments(manifest["state"], files)
        if check_secret:
            check_key(key_from_environment(), manifest["key_check"])
        with (bundle / "database.dump").open("rb") as dump:
            toc = database.run("pg_restore", ["--list"], source=dump)
        if b"TABLE DATA" not in toc:
            raise RecoveryError("덤프에 테이블 데이터가 없습니다")
        return manifest
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise RecoveryError("백업 manifest 또는 파일을 읽을 수 없습니다") from exc


def prune_backups(directory: Path, keep: int, database: Database) -> None:
    """정확한 이름·완료 표시·실제 검증을 통과한 묶음만 보존 개수에 포함한다."""
    if keep < 1:
        raise RecoveryError("백업 보존 개수는 1 이상이어야 합니다")
    valid = []
    for path in sorted(directory.iterdir(), reverse=True):
        if not BUNDLE_PATTERN.fullmatch(path.name) or path.is_symlink() or not path.is_dir():
            continue
        try:
            verify_bundle(path, database)
        except RecoveryError:
            continue
        valid.append(path)
    for path in valid[keep:]:
        shutil.rmtree(path)


def create_backup(
    database: Database,
    directory: Path,
    uploads: Path | None,
    *,
    writes_stopped: bool,
    keep: int = 14,
    reserve: int = RESERVE_BYTES,
    app_version: str | None = None,
) -> Path:
    if keep < 1:
        raise RecoveryError("백업 보존 개수는 1 이상이어야 합니다")
    if app_version is None:
        if not database.local:
            raise RecoveryError("중지 전 확인한 실제 배포 버전을 --app-version으로 지정하세요")
        app_version = __version__
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][\w.-]+)?", app_version):
        raise RecoveryError("앱 버전 형식이 유효하지 않습니다")
    database.require_quiesced(writes_stopped)
    fernet = key_from_environment()
    if directory.is_symlink():
        raise RecoveryError("백업 경로에 symlink를 사용할 수 없습니다")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    lock_descriptor = os.open(
        directory / ".backup.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600
    )
    with os.fdopen(lock_descriptor, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RecoveryError("다른 백업 작업이 실행 중입니다") from exc
        return _create_backup(
            database,
            directory,
            uploads,
            fernet,
            keep=keep,
            reserve=reserve,
            app_version=app_version,
        )


def _create_backup(
    database: Database,
    directory: Path,
    uploads: Path | None,
    fernet: Fernet,
    *,
    keep: int,
    reserve: int,
    app_version: str,
) -> Path:
    database_bytes = int(database.sql("SELECT pg_database_size(current_database())"))
    require_space(directory, database_bytes, reserve)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    name = f"sooljang-{stamp}-{uuid.uuid4().hex[:8]}"
    staging = Path(tempfile.mkdtemp(prefix=".partial-", dir=directory))
    try:
        started = datetime.now(UTC).isoformat()
        before = database.state(fernet)
        if not before["schema_revisions"]:
            raise RecoveryError("스키마 리비전이 없는 DB는 완전한 앱 백업으로 게시할 수 없습니다")
        if uploads is None:
            if database.local:
                raise RecoveryError("local 백업은 --uploads 경로가 필요합니다")
            try:
                subprocess.run(
                    database.compose(["cp", "api:/app/uploads/.", str(staging / "uploads")]),
                    check=True,
                    capture_output=True,
                    timeout=database.timeout,
                )
            except (OSError, subprocess.SubprocessError) as exc:
                raise RecoveryError("중지된 API에서 uploads를 복사하지 못했습니다") from exc
            files = inventory(staging / "uploads")
        else:
            if uploads.is_symlink():
                raise RecoveryError("원본 uploads 경로에 symlink를 사용할 수 없습니다")
            uploads = uploads.resolve(strict=True)
            if directory.resolve().is_relative_to(uploads):
                raise RecoveryError("백업 디렉터리를 uploads 내부에 둘 수 없습니다")
            files = inventory(uploads)
            require_space(
                directory,
                database_bytes + sum(int(row["bytes"]) for row in files.values()) * 2,
                reserve,
            )
            shutil.copytree(uploads, staging / "uploads", symlinks=True)
        validate_attachments(before, files)
        with (staging / "database.dump").open("xb") as dump:
            database.run(
                "pg_dump", ["-d", database.name, "-Fc", "--compress=gzip:6"], destination=dump
            )
            dump.flush()
            os.fsync(dump.fileno())
        after = database.state(fernet)
        if after != before or files != inventory(staging / "uploads"):
            raise RecoveryError("백업 중 DB 또는 uploads가 변경되었습니다")
        if uploads is not None and files != inventory(uploads):
            raise RecoveryError("백업 중 원본 uploads가 변경되었습니다")
        manifest = {
            "format_version": FORMAT_VERSION,
            "app_version": app_version,
            "backup_tool_version": __version__,
            "database_name": database.name,
            "started_at": started,
            "completed_at": datetime.now(UTC).isoformat(),
            "consistency": "all-writers-stopped; pg_dump snapshot and file copy are separate",
            "key_check": fernet.encrypt(KEY_PROBE).decode(),
            "state": before,
            "database": {
                "sha256": digest(staging / "database.dump"),
                "bytes": (staging / "database.dump").stat().st_size,
                "storage_bytes": database_bytes,
            },
            "uploads": files,
        }
        (staging / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
        (staging / "COMPLETE").write_text(digest(staging / "manifest.json") + "\n")
        secure_tree(staging)
        verify_bundle(staging, database)
        sync_tree(staging)
        # COMPLETE는 임시 폴더 안에서 검증되며 최종 이름은 검증 뒤 한 번에 게시한다.
        final = directory / name
        staging.rename(final)
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        prune_backups(directory, keep, database)
        return final
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def restore_backup(
    bundle: Path,
    database: Database,
    uploads: Path,
    *,
    reserve: int = RESERVE_BYTES,
) -> None:
    manifest = verify_bundle(bundle, database)
    if database.name == manifest["database_name"]:
        raise RecoveryError("원본과 다른 격리 DB 이름을 지정하세요")
    if uploads.exists() or uploads.is_symlink():
        raise RecoveryError("복원 uploads 경로는 존재하지 않는 새 경로여야 합니다")
    database.require_empty()
    database.require_capacity(
        max(manifest["database"]["storage_bytes"], manifest["database"]["bytes"] * 3), reserve
    )
    uploads.parent.mkdir(parents=True, exist_ok=True)
    size = sum(int(row["bytes"]) for row in manifest["uploads"].values())
    require_space(uploads.parent, size * 2 + manifest["database"]["bytes"] * 3, reserve)
    staging = Path(tempfile.mkdtemp(prefix=".restore-", dir=uploads.parent))
    try:
        shutil.copytree(bundle / "uploads", staging / "uploads", symlinks=True)
        if inventory(staging / "uploads") != manifest["uploads"]:
            raise RecoveryError("복구용 uploads 복사 검증에 실패했습니다")
        with (bundle / "database.dump").open("rb") as dump:
            database.run(
                "pg_restore",
                [
                    "-d",
                    database.name,
                    "--exit-on-error",
                    "--single-transaction",
                    "--no-owner",
                    "--no-privileges",
                ],
                source=dump,
            )
        state = database.state(key_from_environment())
        if state != manifest["state"]:
            raise RecoveryError(
                "격리 DB 복원 후 참조/행 수/스키마 대조에 실패했습니다; 전환하지 마세요"
            )
        validate_attachments(state, inventory(staging / "uploads"))
        secure_tree(staging / "uploads")
        sync_tree(staging / "uploads")
        (staging / "uploads").rename(uploads)
        # 실제 앱 로그인·조회 검증과 운영 전환은 별도다. 어떤 서비스도 자동 시작하지 않는다.
    finally:
        shutil.rmtree(staging)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--backup", action="store_true")
    group.add_argument("--list", action="store_true")
    group.add_argument("--verify", type=Path)
    group.add_argument("--restore", type=Path)
    parser.add_argument("--local", action="store_true")
    parser.add_argument("--database", default=os.environ.get("SOOLJANG_DB_NAME", "sooljang"))
    parser.add_argument("--target-db")
    parser.add_argument("--uploads", type=Path)
    parser.add_argument("--writes-stopped", action="store_true")
    parser.add_argument("--app-version", help="쓰기 중지 전에 확인한 실제 배포 앱 버전")
    parser.add_argument(
        "--directory",
        type=Path,
        default=Path(os.environ.get("SOOLJANG_BACKUP_DIR", Path.home() / "sooljang-backups")),
    )
    parser.add_argument("--keep", type=int, default=os.environ.get("SOOLJANG_BACKUP_KEEP", "14"))
    options = parser.parse_args()
    os.umask(0o077)
    try:
        database = Database(options.database, local=options.local)
        if options.list:
            if options.directory.exists():
                for path in sorted(options.directory.iterdir()):
                    if path.suffix == ".dump" and path.is_file() and not path.is_symlink():
                        print(f"{path.name} (기존 DB 전용 덤프; uploads·키 별도 복구 필요)")
                    if BUNDLE_PATTERN.fullmatch(path.name) and not path.is_symlink():
                        print(
                            f"{path.name} (완료 표시 있음; 재검증 필요)"
                            if (path / "COMPLETE").is_file()
                            else f"{path.name} (불완전)"
                        )
        elif options.verify:
            verify_bundle(options.verify, database)
            print("체크섬·첨부 참조·키·덤프 목차 검사 통과 (실제 복원 검증은 별도)")
        elif options.restore:
            if not options.target_db or not options.uploads:
                raise RecoveryError("--target-db와 새 --uploads 경로를 명시하세요")
            restore_backup(
                options.restore, Database(options.target_db, local=options.local), options.uploads
            )
            print("격리 DB·uploads 복원 및 대조 완료; 앱 조회 검증 후 명시적으로 전환하세요")
        else:
            result = create_backup(
                database,
                options.directory,
                options.uploads,
                writes_stopped=options.writes_stopped,
                keep=options.keep,
                app_version=options.app_version,
            )
            print(f"백업 완료: {result}")
    except (RecoveryError, OSError) as exc:
        message = (
            str(exc) if isinstance(exc, RecoveryError) else "파일 작업 실패; 완료되지 않았습니다"
        )
        print(f"error: {message}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
