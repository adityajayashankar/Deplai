from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _section(title: str) -> str:
    return f"## {title}\n\n"


def _bullet_list(items: list[str]) -> str:
    if not items:
        return "- None\n"
    return "".join(f"- {item}\n" for item in items)


def _safe_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def build_plan_markdown(
    *,
    tenant_id: str,
    repo_path: str,
    manifest: dict[str, Any],
    repo_map: dict[str, Any],
    planned_changes: list[dict[str, Any]],
    modified_files: list[str],
    errors: list[str],
    use_llm_graph: bool,
) -> str:
    now = datetime.now(timezone.utc).isoformat()
    categories = _safe_dict(manifest.get("categories"))
    branding = _safe_dict(categories.get("branding"))
    theme = _safe_dict(categories.get("theme"))
    domains = _safe_dict(categories.get("domains"))

    lines: list[str] = []
    lines.append(f"# Tenant Customization Plan Report\n\n")
    lines.append(f"Generated at: {now}\n\n")
    lines.append(_section("Run Context"))
    lines.append(f"- Tenant: {tenant_id}\n")
    lines.append(f"- Repo: {repo_path}\n")
    lines.append(f"- LLM Graph Enabled: {str(use_llm_graph).lower()}\n")
    lines.append(f"- Planned Changes Count: {len(planned_changes)}\n")
    lines.append(f"- Modified Files Count: {len(modified_files)}\n")
    lines.append(f"- Error Count: {len(errors)}\n\n")

    lines.append(_section("Manifest Snapshot"))
    lines.append(f"- Company Name: {branding.get('company_name', '')}\n")
    lines.append(f"- Title: {branding.get('title', '')}\n")
    lines.append(f"- Theme Primary: {theme.get('primary', '')}\n")
    lines.append(f"- Theme Secondary: {theme.get('secondary', '')}\n")
    lines.append(f"- Domain Site URL: {domains.get('site_url', '')}\n\n")

    lines.append(_section("Repository Targets"))
    priority_targets = repo_map.get("priority_targets", [])
    lines.append(f"- Priority Targets: {len(priority_targets) if isinstance(priority_targets, list) else 0}\n")
    lines.append("\n")
    if isinstance(priority_targets, list):
        lines.append(_bullet_list([str(path) for path in priority_targets[:30]]))
        lines.append("\n")

    lines.append(_section("Planner Output"))
    if not planned_changes:
        lines.append("No planner changes were produced for this run.\n\n")
    else:
        for index, change in enumerate(planned_changes, start=1):
            file_path = str(change.get("file", ""))
            operation = str(change.get("operation", ""))
            target = str(change.get("target", ""))
            pattern = str(change.get("pattern", ""))
            replacement = str(change.get("replacement", ""))
            prop = str(change.get("property", ""))
            value = str(change.get("value", ""))

            lines.append(f"### Change {index}\n\n")
            lines.append(f"- File: {file_path}\n")
            lines.append(f"- Operation: {operation}\n")
            if target:
                lines.append(f"- Target: {target}\n")
            if pattern:
                lines.append(f"- Pattern: {pattern}\n")
            if replacement:
                lines.append(f"- Replacement: {replacement}\n")
            if prop:
                lines.append(f"- Property: {prop}\n")
            if value:
                lines.append(f"- Value: {value}\n")
            lines.append("\n")

    lines.append(_section("Files Modified"))
    lines.append(_bullet_list(modified_files))
    lines.append("\n")

    lines.append(_section("Errors"))
    lines.append(_bullet_list(errors))
    lines.append("\n")

    return "".join(lines)


def write_plan_markdown(
    *,
    backend_dir: Path,
    tenant_id: str,
    repo_path: str,
    manifest: dict[str, Any],
    repo_map: dict[str, Any],
    planned_changes: list[dict[str, Any]],
    modified_files: list[str],
    errors: list[str],
    use_llm_graph: bool,
) -> Path:
    tenant_dir = (backend_dir / "tenants" / tenant_id).resolve()
    tenant_dir.mkdir(parents=True, exist_ok=True)
    plan_path = tenant_dir / "plan.md"
    markdown = build_plan_markdown(
        tenant_id=tenant_id,
        repo_path=repo_path,
        manifest=manifest,
        repo_map=repo_map,
        planned_changes=planned_changes,
        modified_files=modified_files,
        errors=errors,
        use_llm_graph=use_llm_graph,
    )
    plan_path.write_text(markdown, encoding="utf-8")
    return plan_path