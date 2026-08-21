from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
from typing import Any
import uuid

from services.repo_service import get_tenant_repo_path


IGNORED_DIRECTORY_NAMES = {
    ".git",
    "node_modules",
    ".next",
    "build",
    "dist",
    "cache",
    ".cache",
    "caches",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
}
METADATA_FILE_NAME = "snapshot.metadata.json"
SNAPSHOT_ID_PATTERN = re.compile(r"^\d{8}T\d{6}\d{6}Z-[a-f0-9]{8}$")
TENANT_ID_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


class SnapshotError(ValueError):
    """A client-actionable snapshot validation or integrity failure."""


def _is_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _validate_tenant_id(tenant_id: str) -> str:
    normalized = str(tenant_id or "").strip().lower()
    if not TENANT_ID_PATTERN.fullmatch(normalized):
        raise SnapshotError("tenant_id must be a normalized lowercase tenant slug.")
    return normalized


def manifest_hash(manifest: dict[str, Any]) -> str:
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _manifest_revision(manifest: dict[str, Any], digest: str) -> str:
    metadata = manifest.get("metadata")
    candidates = [
        manifest.get("revision"),
        metadata.get("revision") if isinstance(metadata, dict) else None,
    ]
    for candidate in candidates:
        if isinstance(candidate, (str, int)) and str(candidate).strip():
            return str(candidate).strip()
    return digest[:12]


def _hash_file(file_path: Path) -> str:
    hasher = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _iter_source_files(root: Path):
    for current_root, directory_names, file_names in os.walk(root, followlinks=False):
        current_path = Path(current_root)
        symlink_directories = sorted(
            name for name in directory_names if (current_path / name).is_symlink()
        )
        directory_names[:] = sorted(
            name
            for name in directory_names
            if name.lower() not in IGNORED_DIRECTORY_NAMES
            and name not in symlink_directories
        )
        for directory_name in symlink_directories:
            yield (current_path / directory_name).relative_to(root).as_posix(), current_path / directory_name
        for file_name in sorted(file_names):
            file_path = current_path / file_name
            relative_path = file_path.relative_to(root).as_posix()
            if relative_path == METADATA_FILE_NAME:
                continue
            yield relative_path, file_path


def hash_tree(
    root: Path,
    *,
    reject_external_symlinks: bool = True,
) -> tuple[dict[str, str], str]:
    resolved_root = root.resolve()
    if not resolved_root.exists() or not resolved_root.is_dir():
        raise SnapshotError(f"Repository path is missing: {resolved_root}")

    hashes: dict[str, str] = {}
    for relative_path, file_path in _iter_source_files(resolved_root):
        if file_path.is_symlink():
            link_target = os.readlink(file_path)
            target = file_path.resolve()
            if reject_external_symlinks and (
                Path(link_target).is_absolute() or not _is_within(resolved_root, target)
            ):
                raise SnapshotError(f"Source contains a symlink outside its root: {relative_path}")
            hashes[relative_path] = hashlib.sha256(
                f"symlink:{link_target}".encode("utf-8")
            ).hexdigest()
        elif file_path.is_file():
            hashes[relative_path] = _hash_file(file_path)

    tree_hasher = hashlib.sha256()
    for relative_path, digest in sorted(hashes.items()):
        tree_hasher.update(relative_path.encode("utf-8"))
        tree_hasher.update(b"\0")
        tree_hasher.update(digest.encode("ascii"))
        tree_hasher.update(b"\n")
    return hashes, tree_hasher.hexdigest()


def _changed_file_hashes(
    base_hashes: dict[str, str],
    source_hashes: dict[str, str],
) -> dict[str, dict[str, str | None]]:
    changed: dict[str, dict[str, str | None]] = {}
    for relative_path in sorted(set(base_hashes) | set(source_hashes)):
        base_digest = base_hashes.get(relative_path)
        source_digest = source_hashes.get(relative_path)
        if base_digest == source_digest:
            continue
        if base_digest is None:
            change_status = "added"
        elif source_digest is None:
            change_status = "deleted"
        else:
            change_status = "modified"
        changed[relative_path] = {
            "status": change_status,
            "sha256": source_digest,
            "base_sha256": base_digest,
        }
    return changed


def _copy_source(source_root: Path, destination_root: Path) -> None:
    def ignore(_directory: str, names: list[str]) -> set[str]:
        return {
            name
            for name in names
            if name.lower() in IGNORED_DIRECTORY_NAMES or name == METADATA_FILE_NAME
        }

    shutil.copytree(source_root, destination_root, symlinks=True, ignore=ignore)


def _git_metadata(base_repo_path: Path) -> dict[str, str] | None:
    if not (base_repo_path / ".git").exists():
        return None

    def run(*args: str) -> str:
        try:
            completed = subprocess.run(
                ["git", "-C", str(base_repo_path), *args],
                capture_output=True,
                text=True,
                check=False,
                timeout=3,
            )
        except (OSError, subprocess.TimeoutExpired):
            return ""
        return completed.stdout.strip() if completed.returncode == 0 else ""

    commit = run("rev-parse", "HEAD")
    branch = run("branch", "--show-current")
    remote = run("config", "--get", "remote.origin.url")
    payload = {
        key: value
        for key, value in {"commit": commit, "branch": branch, "remote": remote}.items()
        if value
    }
    return payload or None


def _make_read_only(root: Path) -> None:
    for current_root, directory_names, file_names in os.walk(root):
        current_path = Path(current_root)
        for file_name in file_names:
            try:
                (current_path / file_name).chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
            except OSError:
                pass
        for directory_name in directory_names:
            try:
                (current_path / directory_name).chmod(
                    stat.S_IRUSR
                    | stat.S_IXUSR
                    | stat.S_IRGRP
                    | stat.S_IXGRP
                    | stat.S_IROTH
                    | stat.S_IXOTH
                )
            except OSError:
                pass
    try:
        root.chmod(
            stat.S_IRUSR
            | stat.S_IXUSR
            | stat.S_IRGRP
            | stat.S_IXGRP
            | stat.S_IROTH
            | stat.S_IXOTH
        )
    except OSError:
        pass


def _resolve_snapshot_paths(
    tenant_id: str,
    base_repo_path: str,
    *,
    require_source: bool = True,
) -> tuple[str, Path, Path, Path]:
    normalized_tenant = _validate_tenant_id(tenant_id)
    base_path = Path(base_repo_path).expanduser().resolve()
    if not base_path.exists() or not base_path.is_dir():
        raise SnapshotError(f"Base repository path is missing: {base_path}")

    source_path = Path(
        get_tenant_repo_path(
            base_repo_path=str(base_path),
            tenant_name=normalized_tenant,
        )
    ).resolve()
    shared_parent = base_path.parent.resolve()
    if source_path.parent != shared_parent or not _is_within(shared_parent, source_path):
        raise SnapshotError("Tenant source path is outside shared repository storage.")
    if require_source and (not source_path.exists() or not source_path.is_dir()):
        raise SnapshotError(f"Tenant source repository is missing: {source_path}")

    snapshots_root = (shared_parent / ".deplai-snapshots").resolve()
    tenant_snapshots_root = (snapshots_root / normalized_tenant).resolve()
    if not _is_within(shared_parent, snapshots_root) or not _is_within(snapshots_root, tenant_snapshots_root):
        raise SnapshotError("Snapshot storage path is outside shared repository storage.")
    return normalized_tenant, base_path, source_path, tenant_snapshots_root


def create_snapshot(
    *,
    tenant_id: str,
    base_repo_path: str,
    manifest: dict[str, Any],
    quality_report: dict[str, Any] | None = None,
    expected_manifest_hash: str | None = None,
    expected_base_revision: str | None = None,
) -> dict[str, Any]:
    normalized_tenant, base_path, source_path, tenant_snapshots_root = _resolve_snapshot_paths(
        tenant_id,
        base_repo_path,
    )
    current_manifest_hash = manifest_hash(manifest)
    if expected_manifest_hash and current_manifest_hash != expected_manifest_hash:
        raise SnapshotError("Tenant source is stale for the currently confirmed manifest.")

    base_hashes, base_revision = hash_tree(base_path, reject_external_symlinks=False)
    if expected_base_revision and base_revision != expected_base_revision:
        raise SnapshotError("Tenant source is stale because the base repository changed after implementation.")
    source_hashes, source_tree_hash = hash_tree(source_path)
    changed_hashes = _changed_file_hashes(base_hashes, source_hashes)

    created_at = datetime.now(timezone.utc)
    snapshot_id = f"{created_at.strftime('%Y%m%dT%H%M%S%fZ')}-{uuid.uuid4().hex[:8]}"
    tenant_snapshots_root.mkdir(parents=True, exist_ok=True)
    final_path = (tenant_snapshots_root / snapshot_id).resolve()
    temporary_path = (tenant_snapshots_root / f".tmp-{snapshot_id}").resolve()
    if not _is_within(tenant_snapshots_root, final_path) or not _is_within(tenant_snapshots_root, temporary_path):
        raise SnapshotError("Generated snapshot path is outside tenant snapshot storage.")
    if final_path.exists() or temporary_path.exists():
        raise SnapshotError("Generated snapshot identifier already exists.")

    metadata: dict[str, Any] = {
        "snapshot_id": snapshot_id,
        "tenant_id": normalized_tenant,
        "base_repo_path": str(base_path),
        "source_repo_path": str(source_path),
        "snapshot_path": str(final_path),
        "manifest_revision": _manifest_revision(manifest, current_manifest_hash),
        "manifest_hash": current_manifest_hash,
        "base_revision": base_revision,
        "source_tree_hash": source_tree_hash,
        "changed_file_hashes": changed_hashes,
        "quality_report": quality_report or {"status": "not_run", "checks": []},
        "created_at": created_at.isoformat().replace("+00:00", "Z"),
        "status": "immutable",
    }
    git_metadata = _git_metadata(base_path)
    if git_metadata:
        metadata["git"] = git_metadata

    try:
        _copy_source(source_path, temporary_path)
        copied_hashes, copied_tree_hash = hash_tree(temporary_path)
        if copied_hashes != source_hashes or copied_tree_hash != source_tree_hash:
            raise SnapshotError(
                "Tenant source changed while the snapshot was being copied; retry snapshot creation."
            )
        (temporary_path / METADATA_FILE_NAME).write_text(
            json.dumps(metadata, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        temporary_path.replace(final_path)
        _make_read_only(final_path)
    except Exception:
        if temporary_path.exists():
            shutil.rmtree(temporary_path, ignore_errors=True)
        raise
    return metadata


def _load_snapshot_metadata(snapshot_path: Path) -> dict[str, Any]:
    metadata_path = snapshot_path / METADATA_FILE_NAME
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SnapshotError("Snapshot metadata is missing.") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise SnapshotError("Snapshot metadata is unreadable or invalid.") from exc
    if not isinstance(metadata, dict) or metadata.get("status") != "immutable":
        raise SnapshotError("Snapshot metadata does not declare immutable status.")
    _, actual_tree_hash = hash_tree(snapshot_path)
    if actual_tree_hash != metadata.get("source_tree_hash"):
        raise SnapshotError("Immutable snapshot contents failed integrity verification.")
    return metadata


def get_snapshot(
    *,
    tenant_id: str,
    base_repo_path: str,
    snapshot_id: str,
) -> dict[str, Any]:
    normalized_tenant, _base, _source, tenant_snapshots_root = _resolve_snapshot_paths(
        tenant_id,
        base_repo_path,
        require_source=False,
    )
    if not SNAPSHOT_ID_PATTERN.fullmatch(snapshot_id):
        raise SnapshotError("snapshot_id is invalid.")
    snapshot_path = (tenant_snapshots_root / snapshot_id).resolve()
    if not _is_within(tenant_snapshots_root, snapshot_path):
        raise SnapshotError("Snapshot path is outside tenant snapshot storage.")
    if not snapshot_path.exists() or not snapshot_path.is_dir():
        raise FileNotFoundError(f"Snapshot not found: {snapshot_id}")
    metadata = _load_snapshot_metadata(snapshot_path)
    if metadata.get("tenant_id") != normalized_tenant or metadata.get("snapshot_id") != snapshot_id:
        raise SnapshotError("Snapshot metadata identity does not match its storage path.")
    return metadata


def get_latest_snapshot(*, tenant_id: str, base_repo_path: str) -> dict[str, Any]:
    _tenant, _base, _source, tenant_snapshots_root = _resolve_snapshot_paths(
        tenant_id,
        base_repo_path,
        require_source=False,
    )
    if not tenant_snapshots_root.exists():
        raise FileNotFoundError("No snapshots exist for this tenant.")
    snapshot_ids = sorted(
        (
            path.name
            for path in tenant_snapshots_root.iterdir()
            if path.is_dir() and SNAPSHOT_ID_PATTERN.fullmatch(path.name)
        ),
        reverse=True,
    )
    if not snapshot_ids:
        raise FileNotFoundError("No snapshots exist for this tenant.")
    return get_snapshot(
        tenant_id=tenant_id,
        base_repo_path=base_repo_path,
        snapshot_id=snapshot_ids[0],
    )


def write_implementation_record(
    *,
    record_path: Path,
    tenant_id: str,
    base_repo_path: str,
    source_repo_path: str,
    manifest: dict[str, Any],
    quality_report: dict[str, Any],
    run_id: str,
) -> dict[str, Any]:
    base_path = Path(base_repo_path).resolve()
    source_path = Path(source_repo_path).resolve()
    expected_source = Path(
        get_tenant_repo_path(base_repo_path=str(base_path), tenant_name=_validate_tenant_id(tenant_id))
    ).resolve()
    if source_path != expected_source or source_path.parent != base_path.parent:
        raise SnapshotError("Implementation source path does not match the tenant repository path.")
    _base_hashes, base_revision = hash_tree(base_path, reject_external_symlinks=False)
    payload = {
        "tenant_id": tenant_id,
        "base_repo_path": str(base_path),
        "source_repo_path": str(source_path),
        "manifest_hash": manifest_hash(manifest),
        "base_revision": base_revision,
        "quality_report": quality_report,
        "run_id": run_id,
        "implemented_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    record_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = record_path.with_suffix(".tmp")
    temporary_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    temporary_path.replace(record_path)
    return payload


def load_implementation_record(record_path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(record_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SnapshotError(
            "Tenant source is stale or untracked; run customization implementation before snapshotting."
        ) from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise SnapshotError("Latest implementation record is invalid.") from exc
    if not isinstance(payload, dict):
        raise SnapshotError("Latest implementation record is invalid.")
    return payload
