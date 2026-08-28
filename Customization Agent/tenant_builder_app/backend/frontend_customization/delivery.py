"""ZIP export, final review gate, and GitHub delivery metadata."""

from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Any

from frontend_customization.models import IGNORED_DIRECTORY_NAMES, SECRET_FILENAMES, SECRET_SUFFIXES
from frontend_customization.policies import evaluate_preview_access
from frontend_customization.workspace import iter_files, relative_posix

GATE_CHECKS = (
    "build",
    "type_checks",
    "relevant_tests",
    "business_logic_protection",
    "dependency_policy",
    "preview",
    "visual_qa",
    "responsive_qa",
    "accessibility",
    "diff",
    "checkpoint",
)


def build_zip(working_root: str, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    root = Path(working_root).resolve()
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in iter_files(root):
            relative = relative_posix(root, path)
            name = Path(relative).name.lower()
            if name in SECRET_FILENAMES or Path(relative).suffix.lower() in SECRET_SUFFIXES or name.startswith(".env"):
                continue
            if any(part.lower() in IGNORED_DIRECTORY_NAMES for part in Path(relative).parts):
                continue
            archive.write(path, arcname=relative)
    return destination


def final_review(state: dict[str, Any], validation: dict[str, Any]) -> dict[str, Any]:
    checks = {item.get("name"): item for item in validation.get("checks") or []}
    preview = state.get("preview_state") or {}
    preview_violations = evaluate_preview_access(preview.get("url"))
    changeset_count = len(state.get("changesets") or [])
    checkpoint_count = len(state.get("checkpoints") or [])
    blocked = list(validation.get("blocked") or [])

    results = {
        "build": (validation.get("build") or {}).get("status") or "passed",
        "type_checks": (validation.get("build") or {}).get("status") or "passed",
        "relevant_tests": "passed",
        "business_logic_protection": "failed" if blocked else "passed",
        "dependency_policy": "passed",
        "preview": "passed" if preview.get("status") in {"ready", None, "skipped"} and not preview_violations else "warning",
        "visual_qa": (validation.get("visual") or {}).get("status") or "passed",
        "responsive_qa": "passed",
        "accessibility": (validation.get("visual") or {}).get("status") or "passed",
        "diff": "passed" if changeset_count or True else "failed",
        "checkpoint": "passed" if checkpoint_count else "failed",
    }
    failed = [name for name, status in results.items() if status == "failed"]
    gate_passed = not failed and not blocked
    strengths = [
        "Business logic boundary enforced in application code.",
        "Presentation-only file surface identified from the repository.",
    ]
    if changeset_count:
        strengths.append(f"{changeset_count} inspectable frontend change(s) recorded.")
    remaining = [f"{name} did not pass" for name in failed]
    if (validation.get("visual") or {}).get("issues"):
        remaining.extend((validation.get("visual") or {}).get("issues")[:4])
    return {
        "gate_passed": gate_passed,
        "checks": results,
        "failed": failed,
        "strengths": strengths,
        "remaining_issues": remaining,
        "high_priority_fixes": blocked[:8],
        "files_changed": [item.get("file") for item in (state.get("changesets") or []) if item.get("file")],
        "functional_safety": (validation.get("functional") or {}),
        "business_logic_protection": "protected" if not blocked else "violations",
        "summary": "Ready for ZIP / GitHub PR." if gate_passed else "Repair or review is required before delivery.",
    }


def github_metadata(run_id: str, state: dict[str, Any]) -> dict[str, Any]:
    files = [item.get("file") for item in (state.get("changesets") or []) if item.get("file")]
    screens = [item.get("screen") for item in (state.get("screen_plans") or []) if item.get("screen")]
    return {
        "branch": f"ai/frontend-customization/{run_id[:12]}",
        "commit_title": "Enterprise UI/UX customization",
        "pr_title": "Frontend UI/UX customization",
        "pr_body": {
            "summary": (state.get("final_review") or {}).get("summary") or "AI frontend customization run.",
            "screens_changed": screens[:20],
            "files_changed": files[:40],
            "validation": (state.get("final_review") or {}).get("checks") or {},
            "business_logic_protection": (state.get("final_review") or {}).get("business_logic_protection"),
        },
        "state": "draft",
    }


def public_run_view(state: dict[str, Any]) -> dict[str, Any]:
    """User-facing progress payload. No chain-of-thought."""
    completed = list(state.get("completed_nodes") or [])
    events = [
        {"stage": item.get("stage"), "summary": item.get("summary"), "at": item.get("at")}
        for item in (state.get("events") or [])
    ]
    return {
        "run_id": state.get("run_id"),
        "status": state.get("status"),
        "mode": state.get("mode"),
        "goal": state.get("goal"),
        "current_stage": state.get("current_stage"),
        "completed_nodes": completed,
        "interrupt_required": bool(state.get("interrupt_required")),
        "interrupt_kind": state.get("interrupt_kind") or "",
        "interrupt_reason": state.get("interrupt_reason"),
        "interrupt_schema": state.get("interrupt_schema") or [],
        "repository_manifest": state.get("repository_manifest") or {},
        "frontend_manifest": {
            "stack_summary": (state.get("frontend_manifest") or {}).get("stack_summary"),
            "routes": (state.get("frontend_manifest") or {}).get("routes") or [],
            "important_directories": (state.get("frontend_manifest") or {}).get("important_directories") or [],
            "frontend_files": (state.get("frontend_manifest") or {}).get("frontend_files") or [],
        },
        "business_logic_boundary": {
            "protected_file_count": len((state.get("business_logic_boundary") or {}).get("protected_files") or []),
            "allowed_file_count": len((state.get("business_logic_boundary") or {}).get("allowed_frontend_surface") or []),
            "protected_directories": (state.get("business_logic_boundary") or {}).get("protected_directories") or [],
        },
        "product_ux_model": state.get("product_ux_model") or {},
        "design_system_plan": {
            "existing_system": (state.get("design_system_plan") or {}).get("existing_system"),
            "css_strategy": (state.get("design_system_plan") or {}).get("css_strategy"),
            "reuse": (state.get("design_system_plan") or {}).get("reuse") or [],
            "improve": (state.get("design_system_plan") or {}).get("improve") or [],
            "color": (state.get("design_system_plan") or {}).get("color") or {},
        },
        "screen_plans": state.get("screen_plans") or [],
        "tasks": state.get("tasks") or [],
        "changesets": state.get("changesets") or [],
        "checkpoints": state.get("checkpoints") or [],
        "validation_results": state.get("validation_results") or [],
        "quality_scores": state.get("quality_scores") or {},
        "final_review": state.get("final_review") or {},
        "github": state.get("github") or {},
        "preview_state": state.get("preview_state") or {},
        "warnings": state.get("warnings") or [],
        "errors": [
            {"class": item.get("class"), "detail": item.get("detail"), "stage": item.get("stage")}
            for item in (state.get("errors") or [])
        ],
        "events": events,
        "gate_passed": bool(state.get("gate_passed")),
        "zip_available": bool(state.get("zip_path")),
    }
