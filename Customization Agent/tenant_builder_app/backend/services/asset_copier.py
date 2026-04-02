"""
asset_copier.py — copies branding assets from backend storage into a tenant repo
and patches the relevant frontend source files to reference them.

Called after the main customization graph runs inside runner.py.

Supported asset types and their patch targets
─────────────────────────────────────────────
logo_light          data.js logo field, Topbar.jsx src attributes, og:image fallback
logo_dark           (copied to public, available for manual use)
favicon             _document.js icon link, _app.js shortcut icon
og_image            _document.js og:image content (overrides logo_light fallback)
hero_illustration   landing/index.jsx Hero section <img src="landingJoyy.svg">
why_background      landing/index.jsx CuratedActivities bg-[url(...)] Tailwind class
activities_background  landing/index.jsx Activities bg-[url(...)] Tailwind class
curated_image       landing/index.jsx CuratedActivities <img src="/Curated.png">
"""
from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any

from services.agent_logger import log_agent


ALLOWED_APP_TARGETS = {"frontend", "admin-frontend", "expert", "corporates"}


def _log(message: str) -> None:
    log_agent("AssetCopier", message)


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


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _resolve_asset_source(backend_dir: Path, manifest_path_value: str) -> Path | None:
    """
    Resolve a manifest branding value like
      "tenants/draft-tenant/assets/logo-light.png"
    to an absolute path that exists within backend_dir.

    Returns None (with a log line) if missing or path-unsafe.
    """
    if not manifest_path_value or not isinstance(manifest_path_value, str):
        return None
    # Prevent path traversal: strip leading slashes and reject "/.." segments
    cleaned = manifest_path_value.lstrip("/")
    candidate = (backend_dir / cleaned).resolve()
    try:
        candidate.relative_to(backend_dir.resolve())
    except ValueError:
        _log(f"Security: asset path escapes backend_dir — skipping: {manifest_path_value!r}")
        return None
    if not candidate.exists():
        _log(f"Asset source not found: {candidate}")
        return None
    return candidate


def _copy_asset(source: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, dest)
    _log(f"Copied {source.name}  →  {dest.relative_to(dest.parents[2])}")


def _patch_file(
    file_path: Path,
    pattern: str,
    replacement: str,
    description: str,
) -> bool:
    """
    Apply one regex substitution to a file in-place.
    Returns True when the file was changed, False otherwise.
    """
    if not file_path.exists():
        return False
    original = file_path.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, replacement, original, count=1)
    if count and updated != original:
        file_path.write_text(updated, encoding="utf-8")
        _log(f"Patched {file_path.name}: {description}")
        return True
    return False


def _patch_file_all(
    file_path: Path,
    pattern: str,
    replacement: str,
    description: str,
) -> bool:
    """Same as _patch_file but replaces ALL occurrences."""
    if not file_path.exists():
        return False
    original = file_path.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, replacement, original)
    if count and updated != original:
        file_path.write_text(updated, encoding="utf-8")
        _log(f"Patched {file_path.name} ({count} occurrences): {description}")
        return True
    return False


def _track(modified: list[str], rel_path: str, changed: bool) -> None:
    if changed and rel_path not in modified:
        modified.append(rel_path)


def _set_or_insert_data_property(data_js: Path, property_name: str, value: str) -> bool:
    """Set object property in data.js, or insert it after `logo` when absent."""
    if not data_js.exists():
        return False
    original = data_js.read_text(encoding="utf-8")
    escaped_value = value.replace("\\", "\\\\").replace('"', '\\"')

    updated, count = re.subn(
        rf'({re.escape(property_name)}\s*:\s*")[^"]*(")',
        rf'\g<1>{escaped_value}\g<2>',
        original,
        count=1,
    )
    if count and updated != original:
        data_js.write_text(updated, encoding="utf-8")
        return True

    updated, count = re.subn(
        r'(logo\s*:\s*"[^"]*",\s*\n)',
        rf'\g<1>  {property_name}: "{escaped_value}",\n',
        original,
        count=1,
    )
    if count and updated != original:
        data_js.write_text(updated, encoding="utf-8")
        return True
    return False


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def apply_tenant_assets(
    manifest: dict[str, Any],
    repo_path: str,
    backend_dir: Path,
    app_targets: list[str] | None = None,
) -> list[str]:
    """
    Copy branding assets declared in the manifest into the tenant repo and
    patch the relevant Next.js source files.

    Returns a list of repo-relative paths that were created or modified.
    """
    branding = manifest.get("categories", {}).get("branding", {})
    if not isinstance(branding, dict):
        return []

    repo = Path(repo_path).resolve()
    modified: list[str] = []

    # ------------------------------------------------------------------
    # Helper: resolve + copy + return public URL
    # ------------------------------------------------------------------
    for app_root in _normalize_app_targets(app_targets):
        app_dir = repo / app_root
        if not app_dir.exists():
            continue

        public_dir = app_dir / "public"
        landing = app_dir / "components" / "landing" / "index.jsx"
        document_js = app_dir / "pages" / "_document.js"
        app_js = app_dir / "pages" / "_app.js"
        data_js = app_dir / "utils" / "data.js"
        topbar = app_dir / "components" / "topbar" / "Topbar.jsx"

        def _fetch(asset_type: str) -> tuple[Path | None, str | None]:
            src = _resolve_asset_source(backend_dir, branding.get(asset_type, ""))
            if src is None:
                return None, None
            dest = public_dir / src.name
            _copy_asset(src, dest)
            modified.append(f"{app_root}/public/{src.name}")
            return src, f"/{src.name}"

        if not any(branding.get(t) for t in (
            "logo_light", "logo_dark", "favicon", "og_image",
            "hero_illustration", "why_background", "activities_background", "curated_image",
        )):
            _log("No branding assets declared in manifest — skipping asset copy step.")
            return []

    # ==================================================================
    # 1. logo_light
    # ==================================================================
        logo_src, logo_url = _fetch("logo_light")

        if logo_url:
            safe = logo_url.replace("\\", "/")

            changed = _set_or_insert_data_property(data_js, "logo", safe)
            _track(modified, f"{app_root}/utils/data.js", changed)
            changed = _set_or_insert_data_property(data_js, "logoLight", safe)
            _track(modified, f"{app_root}/utils/data.js", changed)

        # data.js — logo field
            _log(f"Patched branding data: logo/logoLight -> {safe}")

        # Topbar.jsx — default to light logo (or legacy logo fallback)
            if topbar.exists():
                original = topbar.read_text(encoding="utf-8")
                updated = original
                updated = re.sub(
                    r"src=\{companyData\.logoDark\s*\|\|\s*companyData\.logo\}",
                    "src={companyData.logoLight || companyData.logo}",
                    updated,
                )
                updated = re.sub(
                    r'src="/Cultureplace\.png"',
                    "src={companyData.logoLight || companyData.logo}",
                    updated,
                )
                if updated != original:
                    topbar.write_text(updated, encoding="utf-8")
                    _log("Patched Topbar.jsx: default logo uses logoLight (fallback to logo)")
                    _track(modified, f"{app_root}/components/topbar/Topbar.jsx", True)

        # _document.js — og:image fallback (may be overridden by og_image below)
            changed = _patch_file(
                document_js,
                r'(property="og:image"\s+content=")([^"]*?)(")',
                rf"\g<1>{safe}\g<3>",
                f"og:image -> {safe}",
            )
            _track(modified, f"{app_root}/pages/_document.js", changed)

    # ==================================================================
    # 2. logo_dark  (copy + store data key; do not globally override light logo)
    # ==================================================================
        _logo_dark_src, logo_dark_url = _fetch("logo_dark")

        if logo_dark_url:
            safe_dark = logo_dark_url.replace("\\", "/")
            changed = _set_or_insert_data_property(data_js, "logoDark", safe_dark)
            _track(modified, f"{app_root}/utils/data.js", changed)

        # Keep dark logo available as companyData.logoDark.
        # Rendering should explicitly opt-in on dark surfaces instead of overriding
        # all logo usages globally.

    # ==================================================================
    # 3. favicon
    # ==================================================================
        _favicon_src, favicon_url = _fetch("favicon")

        if favicon_url:
            safe_fav = favicon_url.replace("\\", "/")

        # _document.js — <link rel="icon"> href
            changed = _patch_file(
                document_js,
                r'(<link\s[^>]*rel="icon"[^>]*\bhref=")([^"]*?)(")',
                rf"\g<1>{safe_fav}\g<3>",
                f"icon href -> {safe_fav}",
            )
            _track(modified, f"{app_root}/pages/_document.js", changed)

        # _app.js — shortcut icon href
            changed = _patch_file(
                app_js,
                r'(href=")(/favicon\.ico)(")',
                rf"\g<1>{safe_fav}\g<3>",
                f"shortcut icon -> {safe_fav}",
            )
            _track(modified, f"{app_root}/pages/_app.js", changed)

    # ==================================================================
    # 4. og_image  — dedicated social sharing card (overrides logo fallback)
    # ==================================================================
        _og_src, og_url = _fetch("og_image")

        if og_url:
            safe_og = og_url.replace("\\", "/")
            changed = _patch_file(
                document_js,
                r'(property="og:image"\s+content=")([^"]*?)(")',
                rf"\g<1>{safe_og}\g<3>",
                f"og:image -> {safe_og}",
            )
            _track(modified, f"{app_root}/pages/_document.js", changed)

    # ==================================================================
    # 5. hero_illustration  — Hero section right-side <img src="landingJoyy.svg">
    # ==================================================================
        _hero_src, hero_url = _fetch("hero_illustration")

        if hero_url and landing.exists():
            safe_hero = hero_url.replace("\\", "/")
            # Support both `landingJoyy.svg` and previously patched src values.
            changed = _patch_file_all(
                landing,
                r'(src=")(?:/?landingJoyy\.svg|/[^"/]+\.(?:svg|png|webp|jpg|jpeg))(")',
                rf"\g<1>{safe_hero}\g<2>",
                f"hero illustration -> {safe_hero}",
            )
            _track(modified, f"{app_root}/components/landing/index.jsx", changed)

    # ==================================================================
    # 6. why_background  — Tailwind bg-[url('/Why_Background.png')] in landing
    # ==================================================================
        _why_src, why_url = _fetch("why_background")

        if why_url and landing.exists():
            safe_why = why_url.replace("\\", "/")
            # Tailwind arbitrary value variants for the Why section background.
            changed = _patch_file_all(
                landing,
                r"bg-\[url\('[^']*(Why_Background|why-background)[^']*'\)\]",
                f"bg-[url('{safe_why}')]",
                f"why_background -> {safe_why}",
            )
            _track(modified, f"{app_root}/components/landing/index.jsx", changed)

    # ==================================================================
    # 7. activities_background — Tailwind bg-[url('/homepage_back_2.png')]
    # ==================================================================
        _act_src, act_url = _fetch("activities_background")

        if act_url and landing.exists():
            safe_act = act_url.replace("\\", "/")
            changed = _patch_file_all(
                landing,
                r"bg-\[url\('[^']*(homepage_back_2|activities-background)[^']*'\)\]",
                f"bg-[url('{safe_act}')]",
                f"activities_background -> {safe_act}",
            )
            _track(modified, f"{app_root}/components/landing/index.jsx", changed)

    # ==================================================================
    # 8. curated_image  — <img src="/Curated.png"> in CuratedActivities
    # ==================================================================
        _cur_src, cur_url = _fetch("curated_image")

        if cur_url and landing.exists():
            safe_cur = cur_url.replace("\\", "/")
            changed = _patch_file_all(
                landing,
                r'(src=")(?:/Curated\.png|/[^"/]+(?:curated|Curated)[^"/]*\.(?:png|jpg|jpeg|webp|svg))(")',
                f'src="{safe_cur}"',
                f"curated_image -> {safe_cur}",
            )
            _track(modified, f"{app_root}/components/landing/index.jsx", changed)

    # Deduplicate while preserving order
    seen: set[str] = set()
    unique: list[str] = []
    for p in modified:
        if p not in seen:
            seen.add(p)
            unique.append(p)

    _log(f"Asset copy complete. Files affected: {unique}")
    return unique

