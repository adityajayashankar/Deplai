from __future__ import annotations

import json
from pathlib import Path
import subprocess

from services.agent_logger import log_agent
from services.llm_client import ProjectLLMClient


def _manifest_summary(manifest: dict) -> dict:
    categories = manifest.get("categories", {})
    summary: dict = {}
    for section_name in ["branding", "theme", "domains"]:
        section = categories.get(section_name, {})
        if isinstance(section, dict):
            summary[section_name] = {key: value for key, value in section.items() if value not in [None, "", [], {}]}
    extensions = manifest.get("extensions", [])
    if isinstance(extensions, list):
        filtered_extensions = [item for item in extensions if item not in [None, "", [], {}]]
        if filtered_extensions:
            summary["extensions"] = filtered_extensions
    return summary


def _contains_jsx_syntax(content: str) -> bool:
    jsx_markers = ["</", "<div", "<span", "<Link", "<Head", "<>", "className="]
    return any(marker in content for marker in jsx_markers)


def _should_run_node_syntax_check(file_path: Path, content: str) -> bool:
    if file_path.suffix in {".jsx", ".tsx"}:
        return False
    if file_path.suffix in {".js", ".ts"} and _contains_jsx_syntax(content):
        return False
    return file_path.suffix in {".js", ".ts", ".mjs", ".cjs"}


def _is_backend_file(repo_path: Path, file_path: Path) -> bool:
    backend_root = (repo_path / "backend").resolve()
    try:
        file_path.resolve().relative_to(backend_root)
        return True
    except ValueError:
        return False


def _collect_files_by_domain(repo_path: Path, modified_files: list[str]) -> tuple[list[str], list[str], list[str]]:
    backend_files: list[str] = []
    frontend_files: list[str] = []
    unknown_files: list[str] = []

    for relative_path in modified_files:
        file_path = repo_path / relative_path
        if not file_path.exists():
            unknown_files.append(relative_path)
            continue
        if _is_backend_file(repo_path, file_path):
            backend_files.append(relative_path)
        else:
            frontend_files.append(relative_path)

    return backend_files, frontend_files, unknown_files


def _validate_backend_files(repo_path: Path, backend_files: list[str], errors: list[str]) -> None:
    for relative_path in backend_files:
        file_path = repo_path / relative_path
        if file_path.suffix == ".json":
            try:
                json.loads(file_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                errors.append(f"Invalid JSON in {relative_path}: {exc}")
            continue

        if file_path.suffix == ".py":
            result = subprocess.run(
                ["python", "-m", "py_compile", str(file_path)],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode != 0:
                stderr = result.stderr.strip() or result.stdout.strip()
                errors.append(f"Python syntax error in {relative_path}: {stderr}")
            continue

        file_content = file_path.read_text(encoding="utf-8")
        if _should_run_node_syntax_check(file_path, file_content):
            result = subprocess.run(
                ["node", "--check", str(file_path)],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode != 0:
                stderr = result.stderr.strip() or result.stdout.strip()
                errors.append(f"JavaScript syntax error in {relative_path}: {stderr}")


def _validate_frontend_files(repo_path: Path, frontend_files: list[str], errors: list[str]) -> None:
    for relative_path in frontend_files:
        file_path = repo_path / relative_path
        if file_path.suffix == ".json":
            try:
                json.loads(file_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                errors.append(f"Invalid JSON in {relative_path}: {exc}")
            continue

        file_content = file_path.read_text(encoding="utf-8")
        if _should_run_node_syntax_check(file_path, file_content):
            result = subprocess.run(
                ["node", "--check", str(file_path)],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode != 0:
                stderr = result.stderr.strip() or result.stdout.strip()
                errors.append(f"JavaScript syntax error in {relative_path}: {stderr}")
        else:
            log_agent("Validator", f"Skipped node syntax check for JSX-bearing file: {relative_path}")


def _validate_frontend_semantics_with_llm(state: dict, errors: list[str], client: ProjectLLMClient) -> None:
    manifest_summary = _manifest_summary(state.get("manifest", {}))
    repo_path = Path(state["repo_path"]).resolve()
    available_data_files = sorted(
        {
            path.relative_to(repo_path).as_posix()
            for path in repo_path.rglob("data.js")
            if path.is_file() and "node_modules" not in path.parts and ".git" not in path.parts
        }
    )
    for record in state.get("modification_records", []):
        if not isinstance(record, dict):
            continue
        relative_path = record.get("file")
        if not isinstance(relative_path, str):
            continue
        if relative_path.startswith("backend/"):
            continue
        try:
            result = client.complete_json(
                system_prompt=(
                    "You are a frontend customization validator. Review before/after snippets and decide whether the applied change looks consistent with the manifest. Return strict JSON only."
                ),
                user_prompt=(
                    "Manifest summary:\n"
                    f"{json.dumps(manifest_summary, indent=2)}\n\n"
                    "Detected data.js files in repo:\n"
                    f"{json.dumps(available_data_files, indent=2)}\n\n"
                    f"File: {relative_path}\n"
                    f"Applied change: {record.get('change')}\n\n"
                    "Before excerpt:\n"
                    f"{record.get('before_excerpt', '')}\n\n"
                    "After excerpt:\n"
                    f"{record.get('after_excerpt', '')}\n\n"
                    "Return a JSON object with this shape:\n"
                    "{\n"
                    '  "valid": true,\n'
                    '  "reasoning": ["short reasoning line"],\n'
                    '  "issues": ["issue if any"]\n'
                    "}\n\n"
                    "Rules:\n"
                    "- Validate against both typed manifest fields and extensions.\n"
                    "- nl_key_value extensions use target_raw like '<scope>.<key>'; prefer data.js set_object_property when suitable data.js exists for the target app root.\n"
                    "- If no suitable data.js exists (common in static HTML or component-driven repositories), direct text updates in HTML/JSX/TSX/JS files are valid fallback implementations for scope.key targets.\n"
                    "- For static repositories with index.html or index.html.html, updating the hero <h1> is valid for landing.hero_1.\n"
                    "- For React/Next repositories, updating visible hero text in src/App.tsx, src/main.tsx, app/page.tsx, or pages/index.* is valid for landing.hero_1 when data.js is absent.\n"
                    "- Generic literal replacement extensions (target_raw without scope.key, e.g. 'Culture Place') may validly apply to JSX text, page titles, and quoted UI strings across pages/components/data.js.\n"
                    "- Style-related extensions (target_raw containing 'color', 'font', 'size') should have been applied to JSX component files, not data.js.\n"
                    "- If extensions request visible UI copy changes such as homepage headlines, those changes are allowed even when they differ from branding.title or branding.company_name.\n"
                    "- Only report an issue when the applied change conflicts with both the typed manifest fields and the extensions.\n"
                ),
                max_tokens=900,
            )
            reasoning = result.get("reasoning", []) if isinstance(result, dict) else []
            for line in reasoning if isinstance(reasoning, list) else []:
                if isinstance(line, str) and line.strip():
                    log_agent("Validator", line.strip())
            issues = result.get("issues", []) if isinstance(result, dict) else []
            for issue in issues if isinstance(issues, list) else []:
                if isinstance(issue, str) and issue.strip():
                    errors.append(f"Validator issue in {relative_path}: {issue.strip()}")
            if isinstance(result, dict) and result.get("valid") is False and not issues:
                errors.append(f"Validator marked {relative_path} as suspicious without details")
        except Exception as exc:
            log_agent("Validator", f"LLM validation failed for {relative_path}: {exc}")


def validate_repo(state: dict) -> dict:
    repo_path = Path(state["repo_path"])
    errors = list(state.get("errors", []))
    client = ProjectLLMClient()

    backend_files, frontend_files, missing_files = _collect_files_by_domain(
        repo_path,
        list(state.get("modified_files", [])),
    )
    for relative_path in missing_files:
        errors.append(f"Modified file missing: {relative_path}")

    _validate_backend_files(repo_path, backend_files, errors)
    _validate_frontend_files(repo_path, frontend_files, errors)

    if client.is_configured():
        _validate_frontend_semantics_with_llm(state, errors, client)
    else:
        log_agent("Validator", "LLM client is not configured; only syntax validation ran.")

    state["errors"] = errors
    return state
