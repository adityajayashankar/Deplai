from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
from typing import Any


IGNORED_SCAN_DIRECTORIES = {
    "node_modules",
    ".next",
    "dist",
    "build",
    "coverage",
    ".git",
    ".cache",
}

_ALLOWED_SUFFIXES = {".js", ".jsx", ".ts", ".tsx", ".css", ".scss", ".json", ".md", ".mjs", ".cjs", ".env", ".html", ".htm"}
_INDEX_SCHEMA_VERSION = "2.0"
_INDEX_ENGINE_VERSION = "deterministic-frontend-semantic-indexer-v2"
_MAX_TEXT_FILE_SIZE = 1_500_000
_MAX_EXTRACTED_SYMBOLS = 64
_INDEX_CACHE_FILE = "repo-index.cache.json"
_APP_ROOTS = ("frontend", "admin-frontend", "expert", "corporates")

_CATEGORY_RULES: dict[str, tuple[str, ...]] = {
    "branding": (
        "logo",
        "brand",
        "company",
        "footer",
        "topbar",
        "_document",
        "data.js",
        "favicon",
    ),
    "theme": (
        "theme",
        "tailwind",
        "styles",
        "globals.css",
        "font",
        "color",
        "radius",
    ),
    "navigation": (
        "nav",
        "navbar",
        "topbar",
        "sidebar",
        "menu",
        "header",
        "layout",
    ),
    "api_configuration": (
        "api",
        "domainconfig",
        "apisetup",
        "next.config",
        "env",
        "proxy",
    ),
    "ui_components": (
        "components/",
        "pages/",
        "styles/",
    ),
}

_MEANINGFUL_EXTENSIONS = {".js", ".jsx", ".ts", ".tsx", ".css", ".scss", ".json", ".mjs", ".cjs", ".html", ".htm"}
_ROOT_CONFIG_FILES = {
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
    "tailwind.config.js",
    "tailwind.config.ts",
    "postcss.config.js",
    "postcss.config.mjs",
    "package.json",
    "jsconfig.json",
    "tsconfig.json",
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
}


def _assert_tenant_repo(repo_root: Path) -> None:
    if not repo_root.name.startswith("SubSpace-"):
        raise ValueError(f"Refusing to index non-tenant repository: {repo_root}")


def _is_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _safe_read_text(path: Path) -> str:
    if not path.exists() or not path.is_file() or path.is_symlink():
        return ""
    try:
        if path.stat().st_size > _MAX_TEXT_FILE_SIZE:
            return ""
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def _extract_exports(content: str) -> list[str]:
    names: set[str] = set()
    patterns = [
        r"export\s+default\s+function\s+([A-Za-z_][A-Za-z0-9_]*)",
        r"export\s+function\s+([A-Za-z_][A-Za-z0-9_]*)",
        r"export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)",
        r"export\s+class\s+([A-Za-z_][A-Za-z0-9_]*)",
        r"export\s+\{\s*([^\}]+)\s*\}",
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, content):
            group = match.group(1)
            if pattern.endswith("\\}"):
                for token in group.split(","):
                    token = token.strip().split(" as ")[0].strip()
                    if token:
                        names.add(token)
            elif group:
                names.add(group)
            if len(names) >= _MAX_EXTRACTED_SYMBOLS:
                return sorted(names)
    return sorted(names)


def _extract_react_components(path: str, content: str) -> list[str]:
    if not path.endswith((".jsx", ".tsx", ".js", ".ts")):
        return []
    names: set[str] = set()
    patterns = [
        r"function\s+([A-Z][A-Za-z0-9_]*)\s*\(",
        r"const\s+([A-Z][A-Za-z0-9_]*)\s*=\s*\(",
        r"class\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+React\.Component",
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, content):
            names.add(match.group(1))
            if len(names) >= _MAX_EXTRACTED_SYMBOLS:
                return sorted(names)
    if "return (" in content and re.search(r"<[A-Za-z]", content):
        stem = Path(path).stem
        if stem and stem[0].isalpha() and stem[0].isupper():
            names.add(stem)
    return sorted(names)


def _extract_env_vars(content: str) -> list[str]:
    names = set(re.findall(r"(?:process\.env|import\.meta\.env)\.([A-Z0-9_]+)", content))
    return sorted(names)


def _extract_config_objects(content: str) -> list[str]:
    names: set[str] = set()
    for match in re.finditer(r"(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{", content):
        names.add(match.group(1))
        if len(names) >= _MAX_EXTRACTED_SYMBOLS:
            break
    return sorted(names)


def _to_next_route(relative_path: str) -> str | None:
    route_part = ""
    for app_root in _APP_ROOTS:
        prefix = f"{app_root}/pages/"
        if relative_path.startswith(prefix):
            route_part = relative_path[len(prefix):]
            break
    if not route_part:
        return None
    if "/api/" in route_part:
        return None

    route_part = re.sub(r"\.(jsx|tsx|js|ts)$", "", route_part)
    if route_part.endswith("/index"):
        route_part = route_part[:-len("/index")]
    if route_part == "index":
        route_part = ""
    route = f"/{route_part}" if route_part else "/"
    route = route.replace("//", "/")
    return route


def _to_next_api_route(relative_path: str) -> str | None:
    route_part = ""
    for app_root in _APP_ROOTS:
        prefix = f"{app_root}/pages/api/"
        if relative_path.startswith(prefix):
            route_part = relative_path[len(prefix):]
            break
    if not route_part:
        return None

    route_part = re.sub(r"\.(jsx|tsx|js|ts)$", "", route_part)
    if route_part.endswith("/index"):
        route_part = route_part[:-len("/index")]
    if route_part == "index":
        route_part = ""
    route = f"/api/{route_part}" if route_part else "/api"
    route = route.replace("//", "/")
    return route


def _score_file(relative_path: str, tags: set[str], exports: list[str], components: list[str], env_vars: list[str]) -> tuple[int, list[str]]:
    score = 0
    reasons: list[str] = []
    lowered = relative_path.lower()

    if "branding" in tags:
        score += 4
        reasons.append("branding-target")
    if "theme" in tags:
        score += 4
        reasons.append("theme-target")
    if "navigation" in tags:
        score += 4
        reasons.append("navigation-target")
    if "api_configuration" in tags:
        score += 4
        reasons.append("api-config-target")

    if any(relative_path.startswith(f"{app_root}/pages/") for app_root in _APP_ROOTS):
        score += 3
        reasons.append("route-file")
    if "layout" in lowered or relative_path.endswith(("/_app.js", "/_app.tsx", "/_document.js", "/_document.tsx")):
        score += 4
        reasons.append("layout-anchor")
    if any(part in lowered for part in ["topbar", "navbar", "sidebar", "menu", "header", "footer", "nav"]):
        score += 3
        reasons.append("navigation-anchor")
    if exports:
        score += min(3, len(exports))
        reasons.append("exports")
    if components:
        score += min(4, len(components))
        reasons.append("react-components")
    if env_vars:
        score += min(2, len(env_vars))
        reasons.append("env-usage")

    return score, sorted(set(reasons))


def _iter_scannable_files(repo_root: Path) -> list[Path]:
    files: list[Path] = []
    has_app_roots = False
    for app_root in _APP_ROOTS:
        frontend = repo_root / app_root
        if frontend.exists() and frontend.is_dir():
            has_app_roots = True
            for path in sorted(frontend.rglob("*")):
                if any(part in IGNORED_SCAN_DIRECTORIES for part in path.parts):
                    continue
                if not path.is_file() or path.is_symlink():
                    continue
                if not _is_within(repo_root, path):
                    continue
                if path.suffix.lower() in _ALLOWED_SUFFIXES:
                    files.append(path)

    # Static-site fallback: index root/frontend-like files when app roots are absent.
    if not has_app_roots:
        for path in sorted(repo_root.rglob("*")):
            if any(part in IGNORED_SCAN_DIRECTORIES for part in path.parts):
                continue
            if not path.is_file() or path.is_symlink():
                continue
            if not _is_within(repo_root, path):
                continue
            if path.suffix.lower() in _ALLOWED_SUFFIXES:
                files.append(path)

    for filename in sorted(_ROOT_CONFIG_FILES):
        candidate = repo_root / filename
        if candidate.exists() and candidate.is_file() and not candidate.is_symlink() and _is_within(repo_root, candidate):
            files.append(candidate)

    # Preserve deterministic order while removing duplicates.
    unique: dict[str, Path] = {}
    for path in files:
        rel = path.relative_to(repo_root).as_posix()
        unique[rel] = path
    return [unique[key] for key in sorted(unique)]


def _build_repo_signature(repo_root: Path, files: list[Path]) -> str:
    digest = hashlib.sha256()
    digest.update(_INDEX_ENGINE_VERSION.encode("utf-8"))
    for path in files:
        rel = path.relative_to(repo_root).as_posix()
        try:
            stat = path.stat()
            digest.update(rel.encode("utf-8"))
            digest.update(str(stat.st_size).encode("utf-8"))
            digest.update(str(stat.st_mtime_ns).encode("utf-8"))
        except OSError:
            digest.update(rel.encode("utf-8"))
            digest.update(b"missing")
    return digest.hexdigest()


def _load_cached_index(cache_path: Path, expected_signature: str) -> dict[str, Any] | None:
    if not cache_path.exists():
        return None
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("signature") != expected_signature:
        return None
    index = payload.get("index")
    if not isinstance(index, dict):
        return None
    index["cache"] = {
        "used": True,
        "signature": expected_signature,
        "cache_file": cache_path.name,
    }
    return index


def _store_cache(cache_path: Path, signature: str, index: dict[str, Any]) -> None:
    payload = {
        "signature": signature,
        "schema_version": _INDEX_SCHEMA_VERSION,
        "index": index,
    }
    cache_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _list_frontend_files(repo_root: Path) -> list[str]:
    scannable = _iter_scannable_files(repo_root)
    app_root_files = [
        path.relative_to(repo_root).as_posix()
        for path in scannable
        if any(str(path.relative_to(repo_root).as_posix()).startswith(f"{app_root}/") for app_root in _APP_ROOTS)
    ]
    if app_root_files:
        return app_root_files
    return [path.relative_to(repo_root).as_posix() for path in scannable]


def _categorize_file(relative_path: str) -> set[str]:
    lowered = relative_path.lower()
    tags: set[str] = set()
    for category, needles in _CATEGORY_RULES.items():
        if any(needle in lowered for needle in needles):
            tags.add(category)
    return tags


def build_repo_index(repo_path: str) -> dict:
    repo_root = Path(repo_path).resolve()
    _assert_tenant_repo(repo_root)
    all_files = _list_frontend_files(repo_root)

    meaningful_files: list[dict[str, Any]] = []
    routes: list[dict[str, str]] = []
    api_routes: list[dict[str, str]] = []
    layout_components: set[str] = set()
    navigation_components: set[str] = set()
    theme_files: set[str] = set()
    api_client_files: set[str] = set()
    config_files: set[str] = set()
    feature_toggle_files: set[str] = set()
    data_config_files: set[str] = set()
    env_usage: dict[str, list[str]] = {}

    branding_targets: set[str] = set()
    theme_targets: set[str] = set()
    api_targets: set[str] = set()

    for relative_path in all_files:
        lowered = relative_path.lower()
        suffix = Path(relative_path).suffix.lower()
        content = _safe_read_text(repo_root / relative_path) if suffix in _MEANINGFUL_EXTENSIONS else ""
        tags = _categorize_file(relative_path)
        exports = _extract_exports(content) if content and suffix in {".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"} else []
        components = _extract_react_components(relative_path, content) if content else []
        env_vars = _extract_env_vars(content) if content else []
        shared_objects = _extract_config_objects(content) if content else []
        score, reasons = _score_file(relative_path, tags, exports, components, env_vars)

        route = _to_next_route(relative_path)
        if route:
            routes.append({"path": relative_path, "route": route})
            tags.add("route")
        api_route = _to_next_api_route(relative_path)
        if api_route:
            api_routes.append({"path": relative_path, "route": api_route})
            tags.add("api_route")

        if any(key in lowered for key in ["layout", "_app.", "_document.", "components/layout/"]):
            layout_components.add(relative_path)
            tags.add("layout")
        if any(key in lowered for key in ["nav", "navbar", "topbar", "sidebar", "menu", "header", "footer", "breadcrumb"]):
            navigation_components.add(relative_path)
        if any(key in lowered for key in ["theme", "tailwind", "globals.css", "styles/"]):
            theme_files.add(relative_path)
        if any(key in lowered for key in ["api", "apisetup", "axios", "domainconfig", "proxy", "graphql", "fetch"]):
            api_client_files.add(relative_path)
        if any(key in lowered for key in ["config", "next.config", "tailwind.config", "postcss.config", "jsconfig", "tsconfig", ".env"]):
            config_files.add(relative_path)
        if any(key in lowered for key in ["feature", "toggle", "tenantfeatures", "flags"]):
            feature_toggle_files.add(relative_path)
        if any(key in lowered for key in ["/data", "sample", "constants", "domainconfig", "settings"]):
            data_config_files.add(relative_path)

        if "branding" in tags or any(k in lowered for k in ["logo", "favicon", "brand", "og:", "companyname"]):
            branding_targets.add(relative_path)
        if "theme" in tags or any(k in lowered for k in ["theme", "tailwind", "color", "font", "radius"]):
            theme_targets.add(relative_path)
        if "api_configuration" in tags or any(k in lowered for k in ["api", "axios", "domainconfig", "baseurl", "endpoint"]):
            api_targets.add(relative_path)

        if env_vars:
            env_usage[relative_path] = env_vars

        is_meaningful = bool(
            tags
            or exports
            or components
            or route
            or api_route
            or env_vars
            or (config_files and relative_path in config_files)
            or (feature_toggle_files and relative_path in feature_toggle_files)
            or score >= 5
        )
        if is_meaningful:
            meaningful_files.append(
                {
                    "path": relative_path,
                    "kind": suffix.lstrip(".") or "unknown",
                    "tags": sorted(tags),
                    "score": score,
                    "reasons": reasons,
                    "exports": exports,
                    "react_components": components,
                    "shared_objects": shared_objects,
                    "env_vars": env_vars,
                    "route": route,
                    "api_route": api_route,
                }
            )

    categorized = {
        "branding": [],
        "theme": [],
        "navigation": [],
        "api_configuration": [],
        "ui_components": [],
    }

    for relative_path in all_files:
        for category in _categorize_file(relative_path):
            categorized[category].append(relative_path)

    for key in categorized:
        categorized[key] = sorted(dict.fromkeys(categorized[key]))

    priority_targets = sorted(
        {
            *branding_targets,
            *theme_targets,
            *api_targets,
            *layout_components,
            *navigation_components,
            *[entry["path"] for entry in sorted(meaningful_files, key=lambda item: (-int(item.get("score", 0)), str(item.get("path", ""))))[:40]],
        }
    )

    index = {
        "schema_version": _INDEX_SCHEMA_VERSION,
        "engine_version": _INDEX_ENGINE_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "repo_path": str(repo_root),
        "all_frontend_files": all_files,
        "targets": categorized,
        # Compatibility fields consumed by planner and other callers.
        "branding_targets": sorted(branding_targets),
        "theme_targets": sorted(theme_targets),
        "api_targets": sorted(api_targets),
        "priority_targets": priority_targets,
        # Rich deterministic semantic map for agentic and deterministic systems.
        "summary": {
            "frontend_file_count": len(all_files),
            "meaningful_file_count": len(meaningful_files),
            "route_count": len(routes),
            "api_route_count": len(api_routes),
            "layout_component_count": len(layout_components),
            "navigation_component_count": len(navigation_components),
            "theme_file_count": len(theme_files),
            "api_client_file_count": len(api_client_files),
            "config_file_count": len(config_files),
            "feature_toggle_file_count": len(feature_toggle_files),
        },
        "structures": {
            "routes": sorted(routes, key=lambda item: (item["route"], item["path"])),
            "api_routes": sorted(api_routes, key=lambda item: (item["route"], item["path"])),
            "layout_components": sorted(layout_components),
            "navigation_components": sorted(navigation_components),
            "theme_files": sorted(theme_files),
            "api_clients": sorted(api_client_files),
            "config_files": sorted(config_files),
            "feature_toggle_files": sorted(feature_toggle_files),
            "data_config_files": sorted(data_config_files),
            "env_usage": {path: env_usage[path] for path in sorted(env_usage)},
        },
        "meaningful_files": sorted(meaningful_files, key=lambda item: (-int(item.get("score", 0)), str(item.get("path", "")))),
    }
    return index


def build_and_store_repo_index(repo_path: str, backend_dir: Path, tenant_id: str) -> dict:
    repo_root = Path(repo_path).resolve()
    _assert_tenant_repo(repo_root)

    destination = (backend_dir / "tenants" / tenant_id / "repo-index.json").resolve()
    cache_destination = destination.with_name(_INDEX_CACHE_FILE)
    destination.parent.mkdir(parents=True, exist_ok=True)

    scannable_files = _iter_scannable_files(repo_root)
    signature = _build_repo_signature(repo_root, scannable_files)

    cached_index = _load_cached_index(cache_destination, signature)
    if cached_index is not None:
        destination.write_text(json.dumps(cached_index, indent=2), encoding="utf-8")
        return cached_index

    index = build_repo_index(repo_path)
    index["cache"] = {
        "used": False,
        "signature": signature,
        "cache_file": cache_destination.name,
    }
    destination.write_text(json.dumps(index, indent=2), encoding="utf-8")
    _store_cache(cache_destination, signature, index)
    return index
