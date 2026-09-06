"""Deterministic repository intake and frontend mapping. No LLM required."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from frontend_customization.models import (
    CONFIG_FILENAMES,
    FRONTEND_EXTENSIONS,
    FRONTEND_PATH_HINTS,
    IGNORED_DIRECTORY_NAMES,
    empty_manifest,
)
from frontend_customization.workspace import iter_files, read_text, relative_posix

ROUTE_FILE_RE = re.compile(r"(page|route|layout|index)\.(t|j)sx?$", re.I)
COMPONENT_RE = re.compile(r"(export\s+default\s+function|export\s+function|function|const)\s+([A-Z][A-Za-z0-9_]+)")
HOOK_RE = re.compile(r"\buse[A-Z][A-Za-z0-9_]+\b")


def analyze_repository(working_root: str, max_read_batch: int = 8) -> dict[str, Any]:
    root = Path(working_root).resolve()
    files = iter_files(root)
    relatives = [relative_posix(root, path) for path in files]
    package = _read_json(root / "package.json") or _first_package_json(root, files)
    dependencies = {}
    if isinstance(package, dict):
        for key in ("dependencies", "devDependencies"):
            block = package.get(key)
            if isinstance(block, dict):
                dependencies.update({str(name): str(version) for name, version in block.items()})

    scripts = package.get("scripts") if isinstance(package.get("scripts"), dict) else {}
    manifest = empty_manifest()
    manifest.update(
        {
            "language": _detect_language(relatives, dependencies),
            "framework": _detect_framework(relatives, dependencies, root),
            "frontend_framework": _detect_frontend_framework(dependencies, relatives),
            "package_manager": _detect_package_manager(relatives),
            "build_system": _detect_build_system(relatives, dependencies),
            "routing": _detect_routing(relatives, dependencies),
            "source_directories": _source_directories(relatives),
            "entry_points": _entry_points(relatives),
            "design_system": _detect_design_system(dependencies, relatives),
            "component_libraries": _component_libraries(dependencies),
            "css_strategy": _detect_css_strategy(dependencies, relatives),
            "state_management": _detect_state(dependencies, relatives),
            "api_clients": _api_clients(dependencies, relatives),
            "auth_boundaries": [path for path in relatives if "auth" in path.lower()][:20],
            "testing": _testing(dependencies, relatives),
            "build_command": _script(scripts, ("build", "next build", "vite build")),
            "dev_command": _script(scripts, ("dev", "start", "next dev", "vite")),
            "preview_requirements": _preview_requirements(scripts, dependencies),
            "file_count": len(relatives),
            "config_files": [name for name in relatives if Path(name).name in CONFIG_FILENAMES][:40],
        }
    )
    frontend_surface = list_frontend_paths(working_root, relatives=relatives)
    manifest["frontend_file_count"] = len(frontend_surface)
    manifest["has_frontend_surface"] = bool(frontend_surface)
    return manifest


def list_frontend_paths(working_root: str, relatives: list[str] | None = None, limit: int = 200) -> list[str]:
    """Presentational files the studio file list can show before any edits exist."""
    if relatives is None:
        root = Path(working_root).resolve()
        relatives = [relative_posix(root, path) for path in iter_files(root)]
    paths = [path for path in relatives if _looks_listable_frontend(path)]
    return paths[:limit]


def map_frontend(working_root: str, manifest: dict[str, Any]) -> dict[str, Any]:
    root = Path(working_root).resolve()
    files = iter_files(root)
    relatives = [relative_posix(root, path) for path in files]
    frontend_files = list_frontend_paths(working_root, relatives=relatives, limit=500)
    routes = _extract_routes(relatives)
    components = []
    hooks = []
    layouts = []
    styles = []
    for path in frontend_files[:400]:
        lowered = path.lower()
        if lowered.endswith((".css", ".scss", ".sass", ".less")):
            styles.append(path)
        if "layout." in Path(path).name.lower():
            layouts.append(path)
        text = read_text(root / path) or ""
        for match in COMPONENT_RE.finditer(text):
            components.append({"name": match.group(2), "file": path})
        for match in HOOK_RE.finditer(text):
            if match.group(0) not in {"useState", "useEffect", "useMemo", "useCallback", "useRef", "useContext"}:
                hooks.append({"name": match.group(0), "file": path})

    return {
        "important_directories": manifest.get("source_directories") or [],
        "frontend_files": frontend_files[:500],
        "routes": routes,
        "page_components": [item for item in frontend_files if ROUTE_FILE_RE.search(Path(item).name or "")],
        "shared_components": [item["file"] for item in components[:80]],
        "layouts": layouts[:40],
        "hooks": hooks[:60],
        "styles": styles[:80],
        "assets": [path for path in relatives if path.lower().endswith((".png", ".svg", ".jpg", ".webp", ".ico"))][:40],
        "tests": [path for path in relatives if ".test." in path.lower() or ".spec." in path.lower() or "/__tests__/" in path.lower()][:40],
        "components": components[:80],
        "stack_summary": " · ".join(
            part
            for part in (
                str(manifest.get("frontend_framework") or ""),
                str(manifest.get("framework") or ""),
                str(manifest.get("css_strategy") or ""),
            )
            if part and part != "unknown"
        )
        or "Unknown stack",
    }


def _looks_frontend(path: str) -> bool:
    posix = f"/{path.replace(chr(92), '/')}"
    suffix = Path(path).suffix.lower()
    if suffix in FRONTEND_EXTENSIONS:
        if any(hint in posix.lower() for hint in ("/api/", "/server/", "/backend/", "/prisma/")):
            return False
        return True
    return any(hint in posix.lower() for hint in FRONTEND_PATH_HINTS)


def _looks_listable_frontend(path: str) -> bool:
    if _looks_frontend(path):
        return True
    suffix = Path(path).suffix.lower()
    return suffix in {".html", ".htm", ".css", ".scss", ".sass", ".less", ".svg"}


def _extract_routes(relatives: list[str]) -> list[dict[str, str]]:
    routes: list[dict[str, str]] = []
    for path in relatives:
        posix = path.replace("\\", "/")
        name = Path(posix).name.lower()
        if name not in {"page.tsx", "page.jsx", "page.ts", "page.js", "index.tsx", "index.jsx", "index.js", "index.html"}:
            if "/pages/" not in f"/{posix.lower()}/" and "\\pages\\" not in path.lower():
                continue
        route = _route_from_path(posix)
        if route:
            routes.append({"path": route, "file": posix, "purpose": _purpose_from_route(route)})
    # de-dupe by route path
    unique: dict[str, dict[str, str]] = {}
    for item in routes:
        unique.setdefault(item["path"], item)
    return list(unique.values())[:80]


def _route_from_path(posix: str) -> str | None:
    lowered = posix.lower()
    for marker in ("/app/", "/src/app/", "/pages/", "/src/pages/"):
        if marker in f"/{lowered}":
            rest = posix.split(marker, 1)[-1]
            rest = re.sub(r"\(.*?\)/", "", rest)
            rest = re.sub(r"(page|layout|route|index)\.(t|j)sx?$", "", rest, flags=re.I)
            rest = rest.strip("/")
            rest = rest.replace("[", ":").replace("]", "")
            return "/" + rest if rest else "/"
    if posix.lower().endswith("index.html"):
        return "/"
    return None


def _purpose_from_route(route: str) -> str:
    slug = route.strip("/").split("/")[0] or "home"
    mapping = {
        "": "home",
        "home": "home",
        "projects": "manage projects",
        "dashboard": "operations dashboard",
        "settings": "account and product settings",
        "users": "user administration",
        "billing": "billing and invoices",
        "login": "authentication",
        "signup": "registration",
        "docs": "documentation",
    }
    return mapping.get(slug.lower(), f"{slug.replace('-', ' ')} screen")


def _detect_language(relatives: list[str], dependencies: dict[str, str]) -> str:
    if any(path.endswith((".ts", ".tsx")) for path in relatives) or "typescript" in dependencies:
        return "TypeScript"
    if any(path.endswith((".js", ".jsx")) for path in relatives):
        return "JavaScript"
    if any(path.endswith(".vue") for path in relatives):
        return "JavaScript"
    if any(path.endswith(".py") for path in relatives):
        return "Python"
    return "unknown"


def _detect_framework(relatives: list[str], dependencies: dict[str, str], root: Path) -> str:
    names = {Path(path).name.lower() for path in relatives}
    if "next" in dependencies or any(name.startswith("next.config") for name in names):
        return "Next.js"
    if "nuxt" in dependencies:
        return "Nuxt"
    if "vite" in dependencies or any(name.startswith("vite.config") for name in names):
        return "Vite"
    if "@angular/core" in dependencies or "angular.json" in names:
        return "Angular"
    if "svelte" in dependencies:
        return "Svelte"
    if (root / "index.html").exists() or any(path.endswith((".html", ".htm")) for path in relatives):
        return "static"
    return "unknown"


def _detect_frontend_framework(dependencies: dict[str, str], relatives: list[str]) -> str:
    if "next" in dependencies:
        return "React"
    if "react" in dependencies:
        return "React"
    if "vue" in dependencies or any(path.endswith(".vue") for path in relatives):
        return "Vue"
    if "@angular/core" in dependencies:
        return "Angular"
    if "svelte" in dependencies or any(path.endswith(".svelte") for path in relatives):
        return "Svelte"
    if any(path.endswith((".html", ".htm")) for path in relatives):
        return "HTML"
    return "unknown"


def _detect_package_manager(relatives: list[str]) -> str:
    names = {Path(path).name.lower() for path in relatives}
    if "pnpm-lock.yaml" in names:
        return "pnpm"
    if "yarn.lock" in names:
        return "yarn"
    if "bun.lockb" in names or "bun.lock" in names:
        return "bun"
    if "package-lock.json" in names:
        return "npm"
    if "package.json" in names:
        return "npm"
    return "unknown"


def _detect_build_system(relatives: list[str], dependencies: dict[str, str]) -> str:
    names = {Path(path).name.lower() for path in relatives}
    if "next" in dependencies:
        return "next"
    if "vite" in dependencies or any(name.startswith("vite.config") for name in names):
        return "vite"
    if "webpack" in dependencies:
        return "webpack"
    return "unknown"


def _detect_routing(relatives: list[str], dependencies: dict[str, str]) -> str:
    joined = " ".join(relatives).lower()
    if "next" in dependencies and "/app/" in joined:
        return "next-app-router"
    if "next" in dependencies:
        return "next-pages-router"
    if "react-router" in dependencies or "react-router-dom" in dependencies:
        return "react-router"
    if "vue-router" in dependencies:
        return "vue-router"
    return "unknown"


def _source_directories(relatives: list[str]) -> list[str]:
    prefixes = []
    for candidate in ("src", "app", "pages", "components", "features", "frontend", "ui", "styles"):
        if any(path == candidate or path.startswith(f"{candidate}/") for path in relatives):
            prefixes.append(candidate)
    return prefixes[:12]


def _entry_points(relatives: list[str]) -> list[str]:
    candidates = [
        "src/main.tsx",
        "src/main.ts",
        "src/main.jsx",
        "src/index.tsx",
        "src/index.jsx",
        "src/app/layout.tsx",
        "app/layout.tsx",
        "src/app/page.tsx",
        "app/page.tsx",
        "pages/_app.tsx",
        "pages/index.tsx",
        "index.html",
    ]
    return [item for item in candidates if item in set(relatives)][:8]


def _detect_design_system(dependencies: dict[str, str], relatives: list[str]) -> str:
    libraries = _component_libraries(dependencies)
    if libraries:
        return libraries[0]
    if any("globals.css" in path or "tokens" in path.lower() for path in relatives):
        return "custom"
    return "unknown"


def _component_libraries(dependencies: dict[str, str]) -> list[str]:
    mapping = {
        "@mui/material": "Material UI",
        "antd": "Ant Design",
        "@chakra-ui/react": "Chakra UI",
        "@radix-ui/react-dialog": "radix / shadcn",
        "shadcn": "shadcn",
        "@headlessui/react": "Headless UI",
        "vuetify": "Vuetify",
        "bootstrap": "Bootstrap",
    }
    found = [label for dep, label in mapping.items() if dep in dependencies]
    if "@radix-ui/react-slot" in dependencies or "class-variance-authority" in dependencies:
        found.append("shadcn")
    # unique preserve order
    unique: list[str] = []
    for item in found:
        if item not in unique:
            unique.append(item)
    return unique


def _detect_css_strategy(dependencies: dict[str, str], relatives: list[str]) -> str:
    if "tailwindcss" in dependencies or any("tailwind.config" in path for path in relatives):
        return "Tailwind"
    if "styled-components" in dependencies:
        return "styled-components"
    if "@emotion/react" in dependencies:
        return "emotion"
    if any(path.endswith(".module.css") for path in relatives):
        return "CSS Modules"
    if any(path.endswith(".css") for path in relatives):
        return "CSS"
    return "unknown"


def _detect_state(dependencies: dict[str, str], relatives: list[str]) -> str:
    if "zustand" in dependencies:
        return "zustand"
    if "redux" in dependencies or "@reduxjs/toolkit" in dependencies:
        return "redux"
    if "jotai" in dependencies:
        return "jotai"
    if "recoil" in dependencies:
        return "recoil"
    if "mobx" in dependencies:
        return "mobx"
    if "react" in dependencies:
        return "react-hooks"
    joined = " ".join(relatives).lower()
    if "/store" in joined or "store.ts" in joined:
        return "custom-store"
    return "unknown"


def _api_clients(dependencies: dict[str, str], relatives: list[str]) -> list[str]:
    found = []
    for name in ("axios", "graphql", "@tanstack/react-query", "swr", "trpc", "@apollo/client"):
        if name in dependencies:
            found.append(name)
    if any("fetch(" in (path.lower()) for path in relatives[:0]):
        found.append("fetch")
    return found[:8]


def _testing(dependencies: dict[str, str], relatives: list[str]) -> list[str]:
    found = []
    for name, label in (("vitest", "vitest"), ("jest", "jest"), ("playwright", "playwright"), ("cypress", "cypress"), ("@testing-library/react", "testing-library")):
        if name in dependencies:
            found.append(label)
    if any(".test." in path or ".spec." in path for path in relatives):
        if "unit" not in found:
            found.append("unit-files")
    return found


def _script(scripts: dict[str, Any], names: tuple[str, ...]) -> str | None:
    for name in names:
        value = scripts.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for key, value in scripts.items():
        if any(name in key for name in names) and isinstance(value, str):
            return value.strip()
    return None


def _preview_requirements(scripts: dict[str, Any], dependencies: dict[str, str]) -> list[str]:
    req = []
    if "next" in dependencies:
        req.append("next-dev-server")
    if "vite" in dependencies:
        req.append("vite-dev-server")
    if scripts.get("dev"):
        req.append("package-dev-script")
    return req


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else None
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None


def _first_package_json(root: Path, files: list[Path]) -> dict[str, Any]:
    for path in files:
        if path.name == "package.json":
            payload = _read_json(path)
            if payload:
                return payload
    nested = root / "frontend" / "package.json"
    return _read_json(nested) or {}
