from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from graph.customization_graph import CustomizationState, run_graph
from services.asset_copier import apply_tenant_assets
from services.deterministic_customizer import apply_deterministic_customizations
from services.manifest_validator import validate_manifest_for_implementation
from services.plan_report_service import write_plan_markdown
from services.repo_index_service import build_and_store_repo_index
from services.repo_service import ensure_tenant_repo


ALLOWED_APP_TARGETS = {"frontend", "admin-frontend", "expert", "corporates"}


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


def run_customization(
    manifest: dict[str, Any],
    base_repo_path: str,
    app_targets: list[str] | None = None,
    validator_issues: list[str] | None = None,
) -> dict[str, Any]:
    tenant_id = str(manifest.get("tenant_id") or manifest.get("tenant_name") or "draft-tenant")
    backend_dir = Path(__file__).resolve().parent

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
        "modified_files": [],
        "errors": list(normalized_validator_issues),
    }

    # LLM graph is enabled by default. Deterministic-only mode should be explicit.
    use_llm_graph = os.getenv("ENABLE_LLM_CUSTOMIZATION_GRAPH", "true").lower() in {"1", "true", "yes"}
    frontend_only_mode = _is_frontend_only_mode()

    if use_llm_graph:
        try:
            final_state = run_graph(initial_state, frontend_only=frontend_only_mode)
        except Exception as exc:
            fallback_errors = list(initial_state.get("errors", []))
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
                "LLM graph was disabled via ENABLE_LLM_CUSTOMIZATION_GRAPH=false; running deterministic flow only.",
            ],
        }

    if frontend_only_mode:
        final_state["errors"] = [
            *list(final_state.get("errors", [])),
            "Customization scope is frontend-only (CUSTOMIZATION_SCOPE=frontend); backend scanner/modifier nodes were skipped.",
        ]

    deterministic_files = apply_deterministic_customizations(
        manifest=manifest,
        repo_path=repo_path,
        app_targets=resolved_app_targets,
    )

    # Apply branding assets (logo, favicon) declared in the manifest.
    # This runs after the code-change graph so it never interferes with the
    # existing agent pipeline.
    asset_files = apply_tenant_assets(
        manifest=manifest,
        repo_path=repo_path,
        backend_dir=backend_dir,
        app_targets=resolved_app_targets,
    )
    combined_modified = list(final_state.get("modified_files", []))
    for path in deterministic_files:
        if path not in combined_modified:
            combined_modified.append(path)
    for path in asset_files:
        if path not in combined_modified:
            combined_modified.append(path)

    plan_path = write_plan_markdown(
        backend_dir=backend_dir,
        tenant_id=tenant_id,
        repo_path=final_state["repo_path"],
        manifest=manifest,
        repo_map=final_state.get("repo_map", repo_index),
        planned_changes=final_state.get("planned_changes", []),
        modified_files=combined_modified,
        errors=final_state.get("errors", []),
        use_llm_graph=use_llm_graph,
    )

    return {
        "tenant_id": final_state["tenant_id"],
        "app_targets": list(final_state.get("app_targets", resolved_app_targets)),
        "repo_path": final_state["repo_path"],
        "repo_map": final_state.get("repo_map", repo_index),
        "planned_changes": final_state.get("planned_changes", []),
        "modified_files": combined_modified,
        "errors": final_state.get("errors", []),
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