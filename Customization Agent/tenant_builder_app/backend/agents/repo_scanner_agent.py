from __future__ import annotations

import json
from pathlib import Path
import re
from typing import Any, TypedDict

from services.agent_logger import log_agent
from services.llm_client import ProjectLLMClient


class RepoMap(TypedDict):
    branding_targets: list[str]
    theme_targets: list[str]
    api_targets: list[str]
    priority_targets: list[str]
    all_frontend_files: list[str]

IGNORED_SCAN_DIRECTORIES = {
    "node_modules",
    ".next",
    "dist",
    "build",
    "coverage",
    ".git",
    ".cache",
}


IMPORT_PATTERN = re.compile(r"from\s+[\"']([^\"']+)[\"']")

ALLOWED_APP_TARGETS = {"frontend", "admin-frontend", "expert", "corporates"}


def _normalize_app_targets(raw_targets: object) -> list[str]:
    if not isinstance(raw_targets, list):
        return ["frontend", "admin-frontend", "expert", "corporates"]

    normalized: list[str] = []
    for item in raw_targets:
        if not isinstance(item, str):
            continue
        candidate = item.strip().lower()
        if candidate in ALLOWED_APP_TARGETS and candidate not in normalized:
            normalized.append(candidate)

    if not normalized:
        return ["frontend", "admin-frontend", "expert", "corporates"]
    return normalized


def _get_app_root_from_relative_path(relative_path: str) -> str:
    if "/" not in relative_path:
        # Root-level entry files (index.html, index.js) are common in static repos.
        return ""
    first_segment = relative_path.split("/", 1)[0]
    if first_segment:
        return first_segment
    for app_root in ALLOWED_APP_TARGETS:
        if relative_path.startswith(f"{app_root}/"):
            return app_root
    return "frontend"

FOCUS_SCOPE_TO_PATH_HINTS: dict[str, list[str]] = {
    "landing": [
        "frontend/components/landing/index.jsx",
        "frontend/pages/index.js",
        "frontend/pages/home/index.jsx",
    ],
    "topbar": ["frontend/components/topbar/Topbar.jsx"],
    "footer": ["frontend/components/footer/index.jsx"],
    "auth": ["frontend/pages/onBoard/index.jsx"],
    "home": ["frontend/pages/home/index.jsx"],
    "search": ["frontend/pages/search/index.jsx"],
    "contact": ["frontend/pages/contact.jsx"],
    "my_schedule": ["frontend/pages/mySchedule/index.jsx"],
    "my_communities": ["frontend/pages/myCommunities/index.jsx"],
    "browse_classes": ["frontend/pages/browseClasses/index.jsx"],
    "cart_checkout": ["frontend/pages/cart.jsx"],
    "course_details": ["frontend/pages/classDetails/[id].jsx"],
    "community_details": ["frontend/pages/communityDetails/[id].jsx"],
    "community_home": ["frontend/pages/comHome/[id].jsx"],
    "community_threads": ["frontend/pages/comThreads/[id].jsx"],
    "community_subscription": ["frontend/pages/communitySub/[id].jsx"],
    "community_commerce": ["frontend/pages/commerce/[id].jsx"],
    "media_player": ["frontend/pages/playVideo/[id].jsx"],
    "category_sessions": ["frontend/pages/catSessions/[id].jsx"],
    "trainer_bio": ["frontend/pages/trainorBio/[id].jsx"],
    "user_portal": ["frontend/pages/user/index.js"],
    "session_management": ["frontend/pages/session/index.js", "frontend/pages/session/create/index.js"],
    "all_sessions": ["frontend/pages/allSessions/index.jsx"],
    "all_sessions_live": ["frontend/pages/allSessions/liveClasses.jsx"],
    "all_sessions_videos": ["frontend/pages/allSessions/videos.jsx"],
    "student_registration": ["frontend/pages/studentRegistration/index.jsx"],
    "user_settings": ["frontend/pages/settings/[id].jsx"],
    "live_room": ["frontend/pages/room/[id].js"],
    "catchup_room": ["frontend/pages/catchup/[id].jsx"],
    "privacy_policy_page": ["frontend/pages/privacyPolicy/index.jsx"],
    "terms_of_service_page": ["frontend/pages/termsOfService/index.jsx"],
    "terms_and_conditions_page": ["frontend/pages/termsAndConditions/index.jsx"],
}


def _list_frontend_files(repo_path: Path, frontend_path: Path) -> list[str]:
    file_paths: list[str] = []
    for file_path in sorted(frontend_path.rglob("*")):
        if any(part in IGNORED_SCAN_DIRECTORIES for part in file_path.parts):
            continue
        if not file_path.is_file():
            continue
        if file_path.suffix.lower() not in {".js", ".jsx", ".ts", ".tsx", ".css", ".scss", ".json", ".html", ".htm"}:
            continue
        file_paths.append(file_path.relative_to(repo_path).as_posix())
    return file_paths


def _resolve_import(repo_path: Path, current_file: str, import_path: str) -> str | None:
    candidates: list[Path] = []
    current_app_root = _get_app_root_from_relative_path(current_file)
    if import_path.startswith("@/"):
        if current_app_root:
            base = repo_path / current_app_root / import_path[2:]
            candidates.extend([base, *(base.with_suffix(ext) for ext in [".js", ".jsx", ".ts", ".tsx"]), *(base / f"index{ext}" for ext in [".js", ".jsx", ".ts", ".tsx"])] )

        # Generic alias fallbacks for app/src rooted projects.
        for alias_root in ["src", "app", "frontend", "pages", ""]:
            alias_base = repo_path / alias_root / import_path[2:] if alias_root else repo_path / import_path[2:]
            candidates.extend([
                alias_base,
                *(alias_base.with_suffix(ext) for ext in [".js", ".jsx", ".ts", ".tsx"]),
                *(alias_base / f"index{ext}" for ext in [".js", ".jsx", ".ts", ".tsx"]),
            ])
    elif import_path.startswith("."):
        base = (repo_path / current_file).parent / import_path
        candidates.extend([base, *(base.with_suffix(ext) for ext in [".js", ".jsx", ".ts", ".tsx"]), *(base / f"index{ext}" for ext in [".js", ".jsx", ".ts", ".tsx"])])
    else:
        return None

    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            return candidate.relative_to(repo_path).as_posix()
    return None


def _extract_import_targets(repo_path: Path, relative_path: str) -> list[str]:
    file_path = repo_path / relative_path
    try:
        content = file_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return []
    resolved: list[str] = []
    for match in IMPORT_PATTERN.findall(content):
        target = _resolve_import(repo_path, relative_path, match)
        if target and target not in resolved:
            resolved.append(target)
    return resolved


def _collect_priority_targets(repo_path: Path, all_frontend_files: list[str], app_targets: list[str], depth: int = 2) -> list[str]:
    priority: list[str] = []
    # Always include root-level HTML/JS/CSS entry files for static repositories.
    for root_candidate in [
        "index.html", "index.htm", "index.html.html", "styles.css", "style.css", "script.js", "main.js",
        "index.js", "index.jsx", "index.ts", "index.tsx",
        "src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx",
        "src/index.js", "src/index.jsx", "src/index.ts", "src/index.tsx",
        "src/App.js", "src/App.jsx", "src/App.ts", "src/App.tsx",
        "app/page.js", "app/page.jsx", "app/page.ts", "app/page.tsx",
    ]:
        if root_candidate in all_frontend_files and root_candidate not in priority:
            priority.append(root_candidate)

    seed_suffixes: list[str] = []
    for app_root in app_targets:
        seed_suffixes.extend([
            f"{app_root}/pages/index.js",
            f"{app_root}/pages/index.jsx",
            f"{app_root}/public/index.html",
            f"{app_root}/public/index.htm",
            f"{app_root}/pages/home/index.jsx",
            f"{app_root}/pages/home/index.js",
            f"{app_root}/components/landing/index.jsx",
            f"{app_root}/components/landing/index.js",
        ])

    seed_paths = [
        path for path in all_frontend_files
        if any(
            path.endswith(suffix) for suffix in seed_suffixes
        )
    ]

    queue = list(seed_paths)
    seen = set()
    current_depth = 0
    while queue and current_depth <= depth:
        next_queue: list[str] = []
        for relative_path in queue:
            if relative_path in seen:
                continue
            seen.add(relative_path)
            if relative_path not in priority:
                priority.append(relative_path)
            for imported in _extract_import_targets(repo_path, relative_path):
                if (
                    any(imported.startswith(f"{app_root}/") for app_root in app_targets)
                    or "/" not in imported
                ) and imported not in seen:
                    next_queue.append(imported)
        queue = next_queue
        current_depth += 1
    return priority


def _extract_focus_scopes(manifest: dict[str, Any]) -> list[str]:
    extensions = manifest.get("extensions", [])
    if not isinstance(extensions, list):
        return []

    scopes: list[str] = []
    for item in extensions:
        if not isinstance(item, dict):
            continue
        if str(item.get("type", "")).strip().lower() != "nl_key_value":
            continue
        target_raw = str(item.get("target_raw", "")).strip().lower()
        if not target_raw or "." not in target_raw:
            continue
        scope = target_raw.split(".", 1)[0].strip()
        if scope and scope not in scopes:
            scopes.append(scope)
    return scopes


def _collect_focus_seed_paths(manifest: dict[str, Any], all_frontend_files: list[str], app_targets: list[str]) -> list[str]:
    scopes = _extract_focus_scopes(manifest)
    seed_paths: list[str] = []
    available = set(all_frontend_files)

    for scope in scopes:
        for hinted_path in FOCUS_SCOPE_TO_PATH_HINTS.get(scope, []):
            for app_root in app_targets:
                root_hinted_path = hinted_path.replace("frontend/", f"{app_root}/", 1)
                if root_hinted_path in available and root_hinted_path not in seed_paths:
                    seed_paths.append(root_hinted_path)

    # data.js is relevant for most nl_key_value text/visibility requests.
    if scopes:
        for app_root in app_targets:
            data_path = f"{app_root}/utils/data.js"
            if data_path in available and data_path not in seed_paths:
                seed_paths.append(data_path)

    return seed_paths


def _expand_from_seeds(repo_path: Path, seed_paths: list[str], app_targets: list[str], max_depth: int = 2, max_nodes: int = 30) -> list[str]:
    if not seed_paths:
        return []

    ordered: list[str] = []
    seen: set[str] = set()
    queue: list[tuple[str, int]] = [(path, 0) for path in seed_paths]

    while queue and len(ordered) < max_nodes:
        current_path, depth = queue.pop(0)
        if current_path in seen:
            continue
        seen.add(current_path)
        ordered.append(current_path)

        if depth >= max_depth:
            continue
        for imported in _extract_import_targets(repo_path, current_path):
            if not (
                any(imported.startswith(f"{app_root}/") for app_root in app_targets)
                or "/" not in imported
            ):
                continue
            if imported in seen:
                continue
            queue.append((imported, depth + 1))

    return ordered


def _collect_candidate_summaries(
    repo_path: Path,
    *,
    all_frontend_files: list[str],
    priority_targets: list[str],
    focus_paths: list[str],
    limit: int = 60,
) -> list[dict[str, str]]:
    ordered_paths: list[str] = []
    for path in focus_paths:
        if path not in ordered_paths:
            ordered_paths.append(path)
    for path in priority_targets:
        if path not in ordered_paths:
            ordered_paths.append(path)
    for path in all_frontend_files:
        if path not in ordered_paths:
            ordered_paths.append(path)

    candidates: list[dict[str, str]] = []
    for relative_path in ordered_paths:
        file_path = repo_path / relative_path
        try:
            content = file_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue

        lines = [line.strip() for line in content.splitlines() if line.strip()][:12]
        excerpt = "\n".join(lines)[:700]
        candidates.append({
            "path": relative_path,
            "excerpt": excerpt,
        })
        if len(candidates) >= limit:
            break
    return candidates


def _manifest_summary(manifest: dict) -> dict:
    categories = manifest.get("categories", {})
    branding = categories.get("branding", {})
    theme = categories.get("theme", {})
    domains = categories.get("domains", {})
    return {
        "branding": {key: value for key, value in branding.items() if value not in [None, "", []]},
        "theme": {key: value for key, value in theme.items() if value not in [None, "", []]},
        "domains": {key: value for key, value in domains.items() if value not in [None, "", []]},
        "extensions": manifest.get("extensions", []),
    }


def _normalize_paths(paths: object, allowed_paths: set[str]) -> list[str]:
    normalized: list[str] = []
    if not isinstance(paths, list):
        return normalized
    for path in paths:
        if isinstance(path, str) and path in allowed_paths and path not in normalized:
            normalized.append(path)
    return normalized


def scan_repo(state: dict) -> dict:
    repo_path = Path(state["repo_path"])
    app_targets = _normalize_app_targets(state.get("app_targets", ["frontend", "admin-frontend", "expert", "corporates"]))
    errors = list(state.get("errors", []))

    repo_map: RepoMap = {
        "branding_targets": [],
        "theme_targets": [],
        "api_targets": [],
        "priority_targets": [],
        "all_frontend_files": [],
    }

    selected_roots = [repo_path / app_root for app_root in app_targets if (repo_path / app_root).exists()]
    effective_app_targets = [app_root for app_root in app_targets if (repo_path / app_root).exists()]

    if not selected_roots:
        # Fallback mode for arbitrary repositories that do not use the
        # CulturePlace app-root naming convention.
        selected_roots = [repo_path]
        effective_app_targets = [
            child.name
            for child in sorted(repo_path.iterdir())
            if child.is_dir() and child.name not in IGNORED_SCAN_DIRECTORIES and not child.name.startswith('.')
        ]
        if not effective_app_targets:
            effective_app_targets = ["src", "app", "pages", "root"]
        log_agent(
            "Scanner",
            f"No canonical app roots detected for {app_targets}; using repository-wide fallback scan with roots: {effective_app_targets}",
        )

    client = ProjectLLMClient()
    if not client.is_configured():
        errors.append("Scanner LLM client is not configured")
        log_agent("Scanner", "LLM client is not configured. Returning empty repo map.")
        state["repo_map"] = repo_map
        state["errors"] = errors
        return state

    all_frontend_files: list[str] = []
    for app_root in selected_roots:
        for relative_path in _list_frontend_files(repo_path, app_root):
            if relative_path not in all_frontend_files:
                all_frontend_files.append(relative_path)

    priority_targets = _collect_priority_targets(repo_path, all_frontend_files, effective_app_targets)
    focus_seed_paths = _collect_focus_seed_paths(state.get("manifest", {}), all_frontend_files, effective_app_targets)
    focus_paths = _expand_from_seeds(repo_path, focus_seed_paths, effective_app_targets, max_depth=2, max_nodes=30)

    candidate_limit = 60
    if focus_paths:
        candidate_limit = 28
        log_agent(
            "Scanner",
            f"Intent-focused scan enabled using {len(focus_seed_paths)} seed files and {len(focus_paths)} expanded paths",
        )

    candidates = _collect_candidate_summaries(
        repo_path,
        all_frontend_files=all_frontend_files,
        priority_targets=priority_targets,
        focus_paths=focus_paths,
        limit=candidate_limit,
    )
    allowed_paths = {candidate["path"] for candidate in candidates}
    repo_map["all_frontend_files"] = all_frontend_files
    repo_map["priority_targets"] = [path for path in priority_targets if path in allowed_paths or path in all_frontend_files]
    log_agent("Scanner", f"Submitting {len(candidates)} candidate frontend files to LLM for target discovery")

    frontend_inventory_for_prompt = all_frontend_files
    if focus_paths:
        # Keep focused-mode prompt compact to reduce truncated/invalid JSON responses.
        compact_inventory: list[str] = []
        for path in focus_paths + priority_targets:
            if path not in compact_inventory:
                compact_inventory.append(path)
        frontend_inventory_for_prompt = compact_inventory[:60]

    system_prompt = (
        "You analyze frontend repository summaries and classify which files are relevant for tenant customization. "
        "Return strict JSON only. Only choose file paths from the provided candidates."
    )
    user_prompt = (
        "Manifest summary:\n"
        f"{json.dumps(_manifest_summary(state.get('manifest', {})), indent=2)}\n\n"
        "Frontend file inventory (may be focused subset for intent-based scan):\n"
        f"{json.dumps(frontend_inventory_for_prompt, indent=2)}\n\n"
        "Priority homepage and entry-route files:\n"
        f"{json.dumps(priority_targets, indent=2)}\n\n"
        "Candidate frontend files with short excerpts:\n"
        f"{json.dumps(candidates, indent=2)}\n\n"
        "Return a JSON object with this shape:\n"
        "{\n"
        '  "branding_targets": ["path/from/repo/root"],\n'
        '  "theme_targets": ["path/from/repo/root"],\n'
        '  "api_targets": ["path/from/repo/root"],\n'
        '  "reasoning": ["short reasoning line"]\n'
        "}\n\n"
        "Rules:\n"
        "- branding_targets should include visible UI files, metadata files, and branding-related config files.\n"
        "- theme_targets should include styling, theme, and layout files.\n"
        "- api_targets should include domain, API, or runtime URL config files.\n"
        "- Projects may be static HTML/CSS/JS, React/Vite (src/*.tsx), Next.js (app/* or pages/*), or custom layouts. Choose targets that exist in candidates.\n"
        "- If manifest extensions contain nl_key_value entries and a suitable data.js exists, include it in branding_targets. If not, include direct UI files (index.html, app/page.tsx, src/App.tsx, etc.) for visible text updates.\n"
        "- For style-related extensions (target_raw containing 'color', 'font', 'size', 'background'), include relevant CSS/SCSS files and/or component files that control visual styles.\n"
        "- For any nl_key_value extension, prioritize component files mapped from target_raw scope (e.g. landing.*, footer.*, topbar.*) before broad discovery.\n"
        "- Do not invent file paths.\n"
        "- Keep reasoning concise."
    )

    try:
        result = client.complete_json(system_prompt=system_prompt, user_prompt=user_prompt, max_tokens=1400)
        reasoning = result.get("reasoning", []) if isinstance(result, dict) else []
        for line in reasoning if isinstance(reasoning, list) else []:
            if isinstance(line, str) and line.strip():
                log_agent("Scanner", line.strip())
        repo_map["branding_targets"] = _normalize_paths(result.get("branding_targets"), allowed_paths)
        repo_map["theme_targets"] = _normalize_paths(result.get("theme_targets"), allowed_paths)
        repo_map["api_targets"] = _normalize_paths(result.get("api_targets"), allowed_paths)
    except Exception as exc:
        errors.append(f"Scanner LLM failed: {exc}")
        log_agent("Scanner", f"LLM scan failed: {exc}")

    state["repo_map"] = repo_map
    state["errors"] = errors
    return state