from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any

from agents.planner_agent import plan_frontend_changes
from agents.repo_scanner_agent import scan_repo as scan_frontend_repo
from graph.customization_graph import CustomizationState, run_graph
from services.asset_copier import apply_tenant_assets
from services.deterministic_customizer import apply_deterministic_customizations
from services.manifest_validator import validate_manifest_for_implementation
from services.plan_report_service import write_plan_markdown
from services.preview_manager import start_preview
from services.quality_gate import run_quality_gates
from services.repo_index_service import build_and_store_repo_index
from services.repo_service import ensure_tenant_repo


ALLOWED_APP_TARGETS = {"frontend", "admin-frontend", "expert", "corporates"}
FRONTEND_TEXT_SUFFIXES = {".html", ".htm", ".js", ".jsx", ".ts", ".tsx", ".css", ".json"}
IGNORED_SCAN_DIRS = {"node_modules", ".git", ".next", "dist", "build", "coverage", "__pycache__"}
PIPELINE_MODES = {"hybrid", "llm_only", "deterministic_only", "diagnostic"}


def _normalize_pipeline_mode(raw_mode: str | None) -> str:
    candidate = (raw_mode or "").strip().lower().replace("-", "_")
    if not candidate:
        if os.getenv("ENABLE_LLM_CUSTOMIZATION_GRAPH", "true").lower() not in {"1", "true", "yes"}:
            return "deterministic_only"
        return "hybrid"
    if candidate not in PIPELINE_MODES:
        raise ValueError(f"pipeline_mode must be one of: {sorted(PIPELINE_MODES)}")
    return candidate


def _is_frontend_only_mode() -> bool:
        """
        Frontend-only mode skips backend scanner/modifier graph nodes to reduce LLM usage.
        Enabled when CUSTOMIZATION_SCOPE is one of:
            - frontend
            - frontend-only
            - frontend_only
        """
        scope = os.getenv("CUSTOMIZATION_SCOPE", "full").strip().lower()
        return scope in {"frontend", "frontend-only", "frontend_only"}


def _normalize_app_targets(raw_targets: object) -> list[str]:
    if not isinstance(raw_targets, list):
        return ["frontend", "admin-frontend", "expert", "corporates"]

    normalized: list[str] = []
    for target in raw_targets:
        if not isinstance(target, str):
            continue
        candidate = target.strip().lower()
        if candidate in ALLOWED_APP_TARGETS and candidate not in normalized:
            normalized.append(candidate)

    if not normalized:
        return ["frontend", "admin-frontend", "expert", "corporates"]
    return normalized


def _normalize_validator_issues(raw_issues: object) -> list[str]:
    if not isinstance(raw_issues, list):
        return []

    normalized: list[str] = []
    for issue in raw_issues:
        if not isinstance(issue, str):
            continue
        candidate = issue.strip()
        if not candidate or not candidate.startswith("Validator issue"):
            continue
        if candidate not in normalized:
            normalized.append(candidate)
    return normalized


def _iter_literal_replacements(manifest: dict[str, Any]) -> list[tuple[str, str]]:
    extensions = manifest.get("extensions")
    if not isinstance(extensions, list):
        return []

    replacements: list[tuple[str, str]] = []
    for entry in extensions:
        if not isinstance(entry, dict):
            continue
        if str(entry.get("type", "")).strip().lower() != "nl_key_value":
            continue
        target = str(entry.get("target_raw", "")).strip()
        value = entry.get("value")
        if not target or "." in target or not isinstance(value, str):
            continue
        replacement = value.strip()
        if target and replacement and target != replacement:
            replacements.append((target, replacement))
    return replacements


def _repo_contains_text(repo_path: Path, needle: str) -> bool:
    if not needle:
        return False

    for file_path in repo_path.rglob("*"):
        if not file_path.is_file():
            continue
        if file_path.suffix.lower() not in FRONTEND_TEXT_SUFFIXES:
            continue
        if any(part in IGNORED_SCAN_DIRS for part in file_path.parts):
            continue
        try:
            if needle in file_path.read_text(encoding="utf-8"):
                return True
        except (OSError, UnicodeDecodeError):
            continue
    return False


def _filter_resolved_validator_issues(errors: list[str], manifest: dict[str, Any], repo_path: str) -> list[str]:
    replacements = _iter_literal_replacements(manifest)
    if not replacements:
        return errors

    resolved_root = Path(repo_path).resolve()
    filtered: list[str] = []
    for error in errors:
        if not error.startswith("Validator issue"):
            filtered.append(error)
            continue

        resolved = False
        for find_text, replace_text in replacements:
            if find_text not in error or replace_text not in error:
                continue
            if _repo_contains_text(resolved_root, replace_text) and not _repo_contains_text(resolved_root, find_text):
                resolved = True
                break

        if not resolved:
            filtered.append(error)

    return filtered


def _filter_nonfatal_final_errors(errors: list[str], modified_files: list[str]) -> list[str]:
    if not modified_files:
        return errors

    nonfatal = {
        "Planner produced no modifications.",
        "No changes were applied.",
    }
    return [
        error for error in errors
        if error not in nonfatal
        and not error.startswith("LLM graph was disabled via ")
    ]


def _source_signature(source: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(source.get("file", "")),
        str(source.get("source", "")),
        str(source.get("operation", "")),
    )


def _add_change_source(
    sources: list[dict[str, Any]],
    *,
    file_path: str,
    source: str,
    operation: str = "",
) -> None:
    entry = {"file": file_path, "source": source}
    if operation:
        entry["operation"] = operation
    signature = _source_signature(entry)
    if signature not in {_source_signature(item) for item in sources}:
        sources.append(entry)


def _planned_change_sources(state: CustomizationState, source: str) -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    planned_changes = state.get("planned_changes", [])
    modified = set(state.get("modified_files", []))
    for change in planned_changes if isinstance(planned_changes, list) else []:
        if not isinstance(change, dict):
            continue
        file_path = str(change.get("file", ""))
        if not file_path or (modified and file_path not in modified):
            continue
        _add_change_source(
            sources,
            file_path=file_path,
            source=source,
            operation=str(change.get("operation", "")),
        )
    for file_path in modified:
        if not any(item.get("file") == file_path for item in sources):
            _add_change_source(sources, file_path=file_path, source=source)
    return sources


def _run_diagnostic_plans(initial_state: CustomizationState, repo_path: str, manifest: dict[str, Any], app_targets: list[str]) -> dict[str, Any]:
    diagnostic_state = scan_frontend_repo(dict(initial_state))
    diagnostic_state = plan_frontend_changes(diagnostic_state)

    deterministic_files: list[str] = []
    with tempfile.TemporaryDirectory(prefix="deplai-customization-diagnostic-") as temp_dir:
        temp_repo = Path(temp_dir) / Path(repo_path).name
        shutil.copytree(repo_path, temp_repo)
        deterministic_files = apply_deterministic_customizations(
            manifest=manifest,
            repo_path=str(temp_repo),
            app_targets=app_targets,
        )

    return {
        "llm_planned_changes": diagnostic_state.get("planned_changes", []),
        "deterministic_files": deterministic_files,
    }


def run_customization(
    manifest: dict[str, Any],
    base_repo_path: str,
    app_targets: list[str] | None = None,
    validator_issues: list[str] | None = None,
    pipeline_mode: str | None = None,
    run_quality_gates_enabled: bool = True,
    start_preview_enabled: bool = True,
) -> dict[str, Any]:
    tenant_id = str(manifest.get("tenant_id") or manifest.get("tenant_name") or "draft-tenant")
    backend_dir = Path(__file__).resolve().parent
    run_id = uuid.uuid4().hex
    normalized_pipeline_mode = _normalize_pipeline_mode(pipeline_mode)

    # Validate deterministic manifest fields before any repo mutation.
    validate_manifest_for_implementation(manifest=manifest, backend_dir=backend_dir)

    repo_path = ensure_tenant_repo(base_repo_path=base_repo_path, tenant_name=tenant_id)
    repo_index = build_and_store_repo_index(
        repo_path=repo_path,
        backend_dir=backend_dir,
        tenant_id=tenant_id,
    )
    resolved_app_targets = _normalize_app_targets(app_targets)
    normalized_validator_issues = _normalize_validator_issues(validator_issues)

    initial_state: CustomizationState = {
        "tenant_id": tenant_id,
        "repo_path": repo_path,
        "manifest": manifest,
        "app_targets": resolved_app_targets,
        "repo_map": repo_index,
        "backend_repo_map": {},
        "planned_changes": [],
        "planner_source": "",
        "modified_files": [],
        "errors": list(normalized_validator_issues),
    }

    # LLM graph is enabled by default. Explicit pipeline modes make attribution
    # and fallback behavior observable.
    use_llm_graph = normalized_pipeline_mode in {"hybrid", "llm_only", "diagnostic"}
    run_deterministic_phase = normalized_pipeline_mode in {"hybrid", "deterministic_only"}
    frontend_only_mode = _is_frontend_only_mode()
    change_sources: list[dict[str, Any]] = []
    diagnostic: dict[str, Any] | None = None

    if normalized_pipeline_mode == "diagnostic":
        diagnostic = _run_diagnostic_plans(initial_state, repo_path, manifest, resolved_app_targets)
        final_state = {
            **initial_state,
            "planned_changes": diagnostic.get("llm_planned_changes", []),
            "errors": [
                *list(initial_state.get("errors", [])),
                "Diagnostic mode: planned changes were generated without mutating the tenant repo.",
            ],
        }
    elif use_llm_graph:
        try:
            final_state = run_graph(initial_state, frontend_only=frontend_only_mode)
            planner_source = str(final_state.get("planner_source") or "llm_planner")
            if normalized_validator_issues:
                planner_source = "repair_pass"
            change_sources.extend(
                _planned_change_sources(
                    final_state,
                    planner_source,
                )
            )
        except Exception as exc:
            fallback_errors = list(initial_state.get("errors", []))
            if normalized_pipeline_mode == "llm_only":
                fallback_errors.append(f"LLM graph failed at runtime in llm_only mode: {exc}")
                final_state = {
                    **initial_state,
                    "errors": fallback_errors,
                }
            else:
                fallback_errors.append(f"LLM graph failed at runtime; switched to deterministic fallback: {exc}")
                final_state = {
                    **initial_state,
                    "errors": fallback_errors,
                }
    else:
        final_state = {
            **initial_state,
            "errors": [
                *list(initial_state.get("errors", [])),
                f"LLM graph skipped for pipeline_mode={normalized_pipeline_mode}.",
            ],
        }

    if frontend_only_mode:
        final_state["errors"] = [
            *list(final_state.get("errors", [])),
            "Customization scope is frontend-only (CUSTOMIZATION_SCOPE=frontend); backend scanner/modifier nodes were skipped.",
        ]

    deterministic_files: list[str] = []
    if run_deterministic_phase:
        deterministic_files = apply_deterministic_customizations(
            manifest=manifest,
            repo_path=repo_path,
            app_targets=resolved_app_targets,
        )
        for path in deterministic_files:
            _add_change_source(
                change_sources,
                file_path=path,
                source="deterministic_customizer",
                operation="safety_net",
            )

    # Apply branding assets (logo, favicon) declared in the manifest.
    # This runs after the code-change graph so it never interferes with the
    # existing agent pipeline.
    asset_files: list[str] = []
    if normalized_pipeline_mode in {"hybrid", "deterministic_only"}:
        asset_files = apply_tenant_assets(
            manifest=manifest,
            repo_path=repo_path,
            backend_dir=backend_dir,
            app_targets=resolved_app_targets,
        )
        for path in asset_files:
            _add_change_source(change_sources, file_path=path, source="asset_copier")
    combined_modified = list(final_state.get("modified_files", []))
    for path in deterministic_files:
        if path not in combined_modified:
            combined_modified.append(path)
    for path in asset_files:
        if path not in combined_modified:
            combined_modified.append(path)

    final_errors = _filter_resolved_validator_issues(
        errors=list(final_state.get("errors", [])),
        manifest=manifest,
        repo_path=final_state["repo_path"],
    )
    final_errors = _filter_nonfatal_final_errors(final_errors, combined_modified)

    quality_report: dict[str, Any] = {"status": "not_run", "checks": []}
    if run_quality_gates_enabled and normalized_pipeline_mode != "diagnostic":
        quality_report = run_quality_gates(
            repo_path=final_state["repo_path"],
            modified_files=combined_modified,
            app_targets=resolved_app_targets,
        )
        if quality_report.get("status") == "failed":
            final_errors.append("Quality gates failed; review quality_report for details.")

    preview: dict[str, Any] = {"kind": "static_file", "status": "unavailable", "detail": "Preview was not started."}
    if start_preview_enabled and normalized_pipeline_mode != "diagnostic":
        preview = start_preview(
            tenant_id=tenant_id,
            base_repo_path=base_repo_path,
            app_targets=resolved_app_targets,
        )
        quality_report.setdefault("checks", []).append({
            "name": "preview",
            "status": "passed" if preview.get("status") == "ready" else "warning",
            "detail": str(preview.get("detail", "")),
        })
        if quality_report.get("status") != "failed":
            quality_report["status"] = "warning" if preview.get("status") != "ready" else quality_report.get("status", "passed")

    plan_path = write_plan_markdown(
        backend_dir=backend_dir,
        tenant_id=tenant_id,
        repo_path=final_state["repo_path"],
        manifest=manifest,
        repo_map=final_state.get("repo_map", repo_index),
        planned_changes=final_state.get("planned_changes", []),
        modified_files=combined_modified,
        errors=final_errors,
        use_llm_graph=use_llm_graph,
        pipeline_mode=normalized_pipeline_mode,
        run_id=run_id,
        change_sources=change_sources,
        quality_report=quality_report,
        preview=preview,
    )

    return {
        "run_id": run_id,
        "pipeline_mode": normalized_pipeline_mode,
        "tenant_id": final_state["tenant_id"],
        "app_targets": list(final_state.get("app_targets", resolved_app_targets)),
        "repo_path": final_state["repo_path"],
        "repo_map": final_state.get("repo_map", repo_index),
        "planned_changes": final_state.get("planned_changes", []),
        "modified_files": combined_modified,
        "change_sources": change_sources,
        "quality_report": quality_report,
        "preview": preview,
        "diagnostic": diagnostic,
        "errors": final_errors,
        "plan_markdown_path": str(plan_path),
    }


def _load_manifest(manifest_path: str) -> dict[str, Any]:
    path = Path(manifest_path).resolve()
    return json.loads(path.read_text(encoding="utf-8"))


def load_manifest_for_tenant(base_dir: str, tenant_id: str) -> dict[str, Any]:
    tenant_path = Path(base_dir).resolve() / "tenants" / tenant_id / "manifest.json"
    return _load_manifest(str(tenant_path))


def main() -> None:
    parser = argparse.ArgumentParser(description="Run post-ingestion frontend customization graph.")
    parser.add_argument("manifest_path", help="Path to the ingested manifest JSON file")
    parser.add_argument(
        "--base-repo-path",
        default="/Users/safwanahmed/Desktop/PVL/DeplAI-Customisation/CulturePlace-main",
        help="Path to the base CulturePlace repository clone",
    )
    args = parser.parse_args()

    manifest = _load_manifest(args.manifest_path)
    result = run_customization(manifest=manifest, base_repo_path=args.base_repo_path)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
