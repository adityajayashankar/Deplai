"""Isolated workspace, snapshots, diffs, file locks, and rollback."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time
import uuid
from difflib import unified_diff
from pathlib import Path
from typing import Any

from frontend_customization.models import IGNORED_DIRECTORY_NAMES, SECRET_FILENAMES, SECRET_SUFFIXES

_LOCK = threading.Lock()
_FILE_LOCKS: dict[str, dict[str, dict[str, Any]]] = {}

MAX_TEXT_FILE_BYTES = 1_500_000


def ignore_workspace_artifacts(_directory: str, contents: list[str]) -> list[str]:
    ignored: list[str] = []
    for name in contents:
        lowered = name.lower()
        if lowered in IGNORED_DIRECTORY_NAMES or name in SECRET_FILENAMES or Path(name).suffix.lower() in SECRET_SUFFIXES:
            ignored.append(name)
            continue
        if name.startswith(".env"):
            ignored.append(name)
    return ignored


def ensure_workspace(run_id: str, base_repo_path: str, runtime_root: Path) -> dict[str, str]:
    root = (runtime_root / run_id).resolve()
    original = root / "original"
    working = root / "working"
    checkpoints = root / "checkpoints"
    patches = root / "patches"
    artifacts = root / "artifacts"
    preview = root / "preview"
    metadata = root / "metadata"
    for folder in (checkpoints, patches, artifacts, preview, metadata):
        folder.mkdir(parents=True, exist_ok=True)

    source = Path(base_repo_path).resolve()
    if not source.exists() or not source.is_dir():
        raise FileNotFoundError(f"Base repository path is invalid: {source}")
    if is_within(source, root):
        raise ValueError(
            f"Cannot create a customization workspace inside the source repository: {source}"
        )

    if not original.exists():
        shutil.copytree(source, original, ignore=ignore_workspace_artifacts, dirs_exist_ok=False)
    if not working.exists():
        shutil.copytree(original, working, ignore=ignore_workspace_artifacts, dirs_exist_ok=False)

    return {
        "workspace_root": str(root),
        "original_root": str(original),
        "working_root": str(working),
        "checkpoints": str(checkpoints),
        "patches": str(patches),
        "artifacts": str(artifacts),
        "preview": str(preview),
        "metadata": str(metadata),
    }


def is_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def iter_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for current, directory_names, file_names in os.walk(root, followlinks=False):
        directory_names[:] = sorted(
            name for name in directory_names if name.lower() not in IGNORED_DIRECTORY_NAMES and not (Path(current) / name).is_symlink()
        )
        for file_name in sorted(file_names):
            path = Path(current) / file_name
            if path.is_symlink() or file_name in SECRET_FILENAMES or path.suffix.lower() in SECRET_SUFFIXES:
                continue
            files.append(path)
    return files


def relative_posix(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def read_text(path: Path) -> str | None:
    try:
        if not path.is_file() or path.stat().st_size > MAX_TEXT_FILE_BYTES:
            return None
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def file_sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def build_diff(before: str, after: str, relative: str) -> str:
    return "".join(
        unified_diff(
            before.splitlines(keepends=True),
            after.splitlines(keepends=True),
            fromfile=f"a/{relative}",
            tofile=f"b/{relative}",
            n=3,
        )
    )


def changed_files(original_root: Path, working_root: Path) -> list[dict[str, Any]]:
    original_map = {relative_posix(original_root, path): path for path in iter_files(original_root)}
    working_map = {relative_posix(working_root, path): path for path in iter_files(working_root)}
    names = sorted(set(original_map) | set(working_map))
    changes: list[dict[str, Any]] = []
    for relative in names:
        before_path = original_map.get(relative)
        after_path = working_map.get(relative)
        if before_path and not after_path:
            changes.append({"file": relative, "status": "deleted", "sha256": None, "base_sha256": file_sha256(before_path)})
            continue
        if after_path and not before_path:
            changes.append({"file": relative, "status": "added", "sha256": file_sha256(after_path), "base_sha256": None})
            continue
        if before_path and after_path:
            before_hash = file_sha256(before_path)
            after_hash = file_sha256(after_path)
            if before_hash != after_hash:
                changes.append({"file": relative, "status": "modified", "sha256": after_hash, "base_sha256": before_hash})
    return changes


def diff_entries(original_root: Path, working_root: Path, files: list[str] | None = None, limit: int = 40) -> list[dict[str, Any]]:
    selected = files or [item["file"] for item in changed_files(original_root, working_root)]
    entries: list[dict[str, Any]] = []
    for relative in selected[:limit]:
        before_path = (original_root / relative).resolve()
        after_path = (working_root / relative).resolve()
        if after_path.exists() and not is_within(working_root, after_path):
            continue
        before = read_text(before_path) if before_path.exists() and is_within(original_root, before_path) else ""
        after = read_text(after_path) if after_path.exists() else ""
        if before is None or after is None:
            entries.append({"file": relative, "diff": "[binary or unreadable]", "truncated": False})
            continue
        diff = build_diff(before, after, relative)
        entries.append({"file": relative, "diff": diff[:32000], "truncated": len(diff) > 32000})
    return entries


def create_checkpoint(workspace: dict[str, str], stage: str, summary: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    checkpoint_id = f"ckpt_{uuid.uuid4().hex[:12]}"
    folder = Path(workspace["checkpoints"]) / checkpoint_id
    folder.mkdir(parents=True, exist_ok=True)
    working = Path(workspace["working_root"])
    original = Path(workspace["original_root"])
    changes = changed_files(original, working)
    payload = {
        "checkpoint_id": checkpoint_id,
        "stage": stage,
        "summary": summary,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "files_changed": changes,
        **(extra or {}),
    }
    if changes:
        snapshot_dir = folder / "working"
        if snapshot_dir.exists():
            shutil.rmtree(snapshot_dir)
        shutil.copytree(working, snapshot_dir, ignore=ignore_workspace_artifacts)
    else:
        payload["uses_original"] = True
    (folder / "checkpoint.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def restore_checkpoint(workspace: dict[str, str], checkpoint_id: str) -> dict[str, Any]:
    folder = Path(workspace["checkpoints"]) / checkpoint_id
    meta_path = folder / "checkpoint.json"
    if not meta_path.exists():
        raise FileNotFoundError(f"Checkpoint {checkpoint_id} was not found.")
    payload = json.loads(meta_path.read_text(encoding="utf-8"))
    working = Path(workspace["working_root"])
    snapshot_dir = folder / "working"
    source = Path(workspace["original_root"]) if payload.get("uses_original") else snapshot_dir
    if not source.exists():
        raise FileNotFoundError(f"Checkpoint {checkpoint_id} was not found.")
    if working.exists():
        shutil.rmtree(working)
    shutil.copytree(source, working, ignore=ignore_workspace_artifacts)
    return payload


def acquire_files(run_id: str, agent_id: str, files: list[str], lock_type: str = "exclusive") -> list[str]:
    with _LOCK:
        held = _FILE_LOCKS.setdefault(run_id, {})
        conflicts = [path for path in files if path in held and held[path]["agent_id"] != agent_id]
        if conflicts:
            owners = ", ".join(f"{path} ({held[path]['agent_id']})" for path in conflicts[:6])
            raise RuntimeError(f"File lock conflict: {owners}")
        timestamp = time.time()
        for path in files:
            held[path] = {"agent_id": agent_id, "lock_type": lock_type, "timestamp": timestamp, "graph_run_id": run_id}
        return list(files)


def release_files(run_id: str, agent_id: str, files: list[str] | None = None) -> None:
    with _LOCK:
        held = _FILE_LOCKS.get(run_id) or {}
        targets = files if files is not None else [path for path, meta in held.items() if meta["agent_id"] == agent_id]
        for path in targets:
            meta = held.get(path)
            if meta and meta["agent_id"] == agent_id:
                held.pop(path, None)


def lock_snapshot(run_id: str) -> list[dict[str, Any]]:
    with _LOCK:
        held = _FILE_LOCKS.get(run_id) or {}
        return [{"file": path, **meta} for path, meta in held.items()]
