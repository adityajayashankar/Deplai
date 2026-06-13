from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from typing import Any


QUALITY_TIMEOUT_SECONDS = 180
RUN_BUILD_GATES = os.getenv("CUSTOMIZATION_RUN_BUILD_QUALITY_GATES", "false").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
APP_ROOTS = ("frontend", "admin-frontend", "expert", "corporates")
IGNORED_PARTS = {"node_modules", ".git", ".next", "dist", "build", "coverage", "__pycache__"}


def _check(name: str, status: str, detail: str = "") -> dict[str, str]:
    payload = {"name": name, "status": status}
    if detail:
        payload["detail"] = detail[:1200]
    return payload


def _run(command: list[str], cwd: Path, timeout: int = QUALITY_TIMEOUT_SECONDS) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            command,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        return False, f"Command not found: {exc.filename}"
    except subprocess.TimeoutExpired:
        return False, f"Timed out after {timeout}s: {' '.join(command)}"

    output = "\n".join(part.strip() for part in [result.stdout, result.stderr] if part and part.strip())
    return result.returncode == 0, output or f"exit_code={result.returncode}"


def _contains_jsx_syntax(content: str) -> bool:
    return any(marker in content for marker in ["</", "<div", "<span", "<Link", "<Head", "<>", "className="])


def _should_node_check(file_path: Path, content: str) -> bool:
    if file_path.suffix.lower() in {".jsx", ".tsx"}:
        return False
    if file_path.suffix.lower() in {".js", ".ts"} and _contains_jsx_syntax(content):
        return False
    return file_path.suffix.lower() in {".js", ".ts", ".mjs", ".cjs"}


def _iter_text_files(repo_path: Path, modified_files: list[str]) -> list[Path]:
    files: list[Path] = []
    for relative_path in modified_files:
        file_path = (repo_path / relative_path).resolve()
        try:
            file_path.relative_to(repo_path.resolve())
        except ValueError:
            continue
        if not file_path.exists() or not file_path.is_file():
            continue
        if any(part in IGNORED_PARTS for part in file_path.parts):
            continue
        files.append(file_path)
    return files


def _syntax_checks(repo_path: Path, modified_files: list[str]) -> list[dict[str, str]]:
    checks: list[dict[str, str]] = []
    for file_path in _iter_text_files(repo_path, modified_files):
        suffix = file_path.suffix.lower()
        try:
            content = file_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue

        relative_path = file_path.relative_to(repo_path).as_posix()
        if suffix == ".json":
            try:
                json.loads(content)
                checks.append(_check(f"syntax:{relative_path}", "passed"))
            except json.JSONDecodeError as exc:
                checks.append(_check(f"syntax:{relative_path}", "failed", str(exc)))
            continue

        if _should_node_check(file_path, content):
            ok, detail = _run(["node", "--check", str(file_path)], cwd=repo_path, timeout=30)
            checks.append(_check(f"syntax:{relative_path}", "passed" if ok else "failed", "" if ok else detail))
            continue

        if suffix in {".jsx", ".tsx"} or (suffix in {".js", ".ts"} and _contains_jsx_syntax(content)):
            checks.append(_check(f"syntax:{relative_path}", "warning", "JSX-bearing file skipped by node --check; build gate covers this when available."))

    return checks


def _static_checks(repo_path: Path) -> list[dict[str, str]]:
    entries = [
        repo_path / "index.html",
        repo_path / "index.htm",
        repo_path / "index.html.html",
        repo_path / "public" / "index.html",
        repo_path / "dist" / "index.html",
        repo_path / "build" / "index.html",
    ]
    checks: list[dict[str, str]] = []
    if any(path.exists() and path.is_file() for path in entries):
        checks.append(_check("static:entrypoint", "passed"))
    else:
        checks.append(_check("static:entrypoint", "warning", "No static HTML entrypoint found; live-server preview may still be available for framework apps."))

    css_files = [
        path for path in repo_path.rglob("*.css")
        if path.is_file() and not any(part in IGNORED_PARTS for part in path.parts)
    ][:40]
    for file_path in css_files:
        try:
            content = file_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if content.count("{") != content.count("}"):
            checks.append(_check(f"css:{file_path.relative_to(repo_path).as_posix()}", "failed", "Unbalanced CSS braces."))
    if not any(check["name"].startswith("css:") for check in checks):
        checks.append(_check("css:basic-sanity", "passed"))
    return checks


def _package_roots(repo_path: Path, app_targets: list[str]) -> list[Path]:
    roots: list[Path] = []
    for app_root in app_targets:
        candidate = repo_path / app_root
        if (candidate / "package.json").exists():
            roots.append(candidate)
    if not roots and (repo_path / "package.json").exists():
        roots.append(repo_path)
    return roots


def _package_has_script(package_json: Path, script_name: str) -> bool:
    try:
        payload = json.loads(package_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    scripts = payload.get("scripts")
    return isinstance(scripts, dict) and isinstance(scripts.get(script_name), str) and bool(scripts[script_name].strip())


def _build_checks(repo_path: Path, app_targets: list[str]) -> list[dict[str, str]]:
    if not RUN_BUILD_GATES:
        return [_check("build", "warning", "Framework build/lint gate skipped by default for fast customization preview.")]

    roots = _package_roots(repo_path, app_targets)
    if not roots:
        return [_check("build", "warning", "No package.json found; skipped framework build gate.")]
    if shutil.which("npm") is None and shutil.which("npm.cmd") is None:
        return [_check("build", "warning", "npm was not found on PATH; skipped framework build/lint gate.")]

    checks: list[dict[str, str]] = []
    for root in roots:
        relative = root.relative_to(repo_path).as_posix() if root != repo_path else "."
        package_json = root / "package.json"
        if _package_has_script(package_json, "build"):
            ok, detail = _run(["npm", "run", "build"], cwd=root)
            checks.append(_check(f"build:{relative}", "passed" if ok else "failed", "" if ok else detail))
        elif _package_has_script(package_json, "lint"):
            ok, detail = _run(["npm", "run", "lint"], cwd=root, timeout=120)
            checks.append(_check(f"lint:{relative}", "passed" if ok else "failed", "" if ok else detail))
        else:
            checks.append(_check(f"build:{relative}", "warning", "package.json has no build or lint script."))
    return checks


def summarize_quality_status(checks: list[dict[str, str]]) -> str:
    if any(check.get("status") == "failed" for check in checks):
        return "failed"
    if any(check.get("status") == "warning" for check in checks):
        return "warning"
    return "passed"


def run_quality_gates(repo_path: str, modified_files: list[str], app_targets: list[str]) -> dict[str, Any]:
    repo_root = Path(repo_path).resolve()
    checks: list[dict[str, str]] = []
    checks.extend(_syntax_checks(repo_root, modified_files))
    checks.extend(_static_checks(repo_root))
    checks.extend(_build_checks(repo_root, app_targets))
    return {
        "status": summarize_quality_status(checks),
        "checks": checks,
    }
