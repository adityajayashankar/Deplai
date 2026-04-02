from __future__ import annotations

from pathlib import Path
import re
import subprocess

from services.agent_logger import log_agent


def _log_message(message: str) -> None:
    log_agent("BackendModifier", message)


def _is_backend_file(repo_path: Path, file_path: Path) -> bool:
    backend_root = (repo_path / "backend").resolve()
    try:
        file_path.resolve().relative_to(backend_root)
        return True
    except ValueError:
        return False


def _apply_set_object_property(content: str, property_name: str, value: str) -> str:
    string_value = value.replace("\\", "\\\\").replace('"', '\\"')
    patterns = [
        rf'({property_name}\s*:\s*")([^"]*)(")',
        rf"({property_name}\s*:\s*')([^']*)(')",
    ]
    for pattern in patterns:
        updated, count = re.subn(pattern, rf"\g<1>{string_value}\g<3>", content, count=1)
        if count:
            return updated
    return content


def _apply_change(content: str, change: dict) -> str:
    operation = change["operation"]
    raw_count = change.get("count", 1)
    try:
        count = int(raw_count)
    except (TypeError, ValueError):
        count = 1
    if count < 0:
        count = 1

    if operation == "replace_text":
        replace_count = -1 if count == 0 else count
        return content.replace(change["target"], change["replacement"], replace_count)
    if operation == "replace_all_text":
        return content.replace(change["target"], change["replacement"])
    if operation == "insert_before":
        return content.replace(change["target"], change["replacement"], 1)
    if operation == "replace_regex":
        return re.sub(change["pattern"], change["replacement"], content, count=count)
    if operation == "set_object_property":
        return _apply_set_object_property(content, change["property"], str(change["value"]))
    return content


def _python_syntax_ok(file_path: Path) -> tuple[bool, str]:
    result = subprocess.run(
        ["python", "-m", "py_compile", str(file_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode == 0:
        return True, ""
    return False, (result.stderr.strip() or result.stdout.strip())


def apply_backend_changes(state: dict) -> dict:
    repo_path = Path(state["repo_path"]).resolve()
    modified_files = list(state.get("modified_files", []))
    errors = list(state.get("errors", []))

    planned_changes = state.get("planned_changes", [])
    backend_changes = [
        change
        for change in planned_changes
        if isinstance(change, dict)
        and isinstance(change.get("file"), str)
        and _is_backend_file(repo_path, (repo_path / change["file"]).resolve())
    ]

    if not backend_changes:
        _log_message("No backend changes to apply.")
        state["modified_files"] = modified_files
        state["errors"] = errors
        return state

    for change in backend_changes:
        relative_path = change["file"]
        file_path = (repo_path / relative_path).resolve()
        if not file_path.exists():
            errors.append(f"Planned backend file does not exist: {relative_path}")
            continue

        original = file_path.read_text(encoding="utf-8")
        updated = _apply_change(original, change)

        if updated == original:
            _log_message(f"No content change produced for {relative_path} using {change['operation']}")
            continue

        file_path.write_text(updated, encoding="utf-8")
        if file_path.suffix == ".py":
            ok, reason = _python_syntax_ok(file_path)
            if not ok:
                file_path.write_text(original, encoding="utf-8")
                errors.append(f"Backend modifier reverted invalid Python syntax in {relative_path}: {reason}")
                continue

        if relative_path not in modified_files:
            modified_files.append(relative_path)
        _log_message(f"Applied backend change to {relative_path} ({change['operation']})")

    state["modified_files"] = modified_files
    state["errors"] = errors
    return state
