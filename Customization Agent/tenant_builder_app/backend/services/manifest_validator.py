from __future__ import annotations

from pathlib import Path
import re
from urllib.parse import urlparse

from services.asset_service import ALLOWED_EXTENSIONS, SUPPORTED_ASSET_TYPES


_HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_CSS_COLOR_RE = re.compile(r"^[a-zA-Z]{3,32}$")
_TENANT_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{0,62}$")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class ManifestValidationError(ValueError):
    def __init__(self, errors: list[str]) -> None:
        super().__init__("Manifest validation failed.")
        self.errors = errors


def _as_dict(value: object) -> dict:
    return value if isinstance(value, dict) else {}


def _is_valid_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _validate_color(value: object, field_name: str, errors: list[str]) -> None:
    if value in (None, ""):
        return
    if not isinstance(value, str):
        errors.append(f"{field_name} must be a valid CSS color value.")
        return

    normalized = value.strip()
    if _HEX_COLOR_RE.match(normalized):
        return
    if _CSS_COLOR_RE.match(normalized):
        return

    errors.append(f"{field_name} must be a hex color like #3b82f6 or a CSS color name like blue.")


def _validate_domain(value: object, field_name: str, errors: list[str]) -> None:
    if value in (None, ""):
        return
    if not isinstance(value, str) or not _is_valid_url(value.strip()):
        errors.append(f"{field_name} must be a valid http/https URL.")


def _validate_asset_path(
    tenant_id: str,
    backend_dir: Path,
    asset_type: str,
    raw_path: object,
    errors: list[str],
) -> None:
    if raw_path in (None, ""):
        return
    if not isinstance(raw_path, str):
        errors.append(f"categories.branding.{asset_type} must be a string path.")
        return

    cleaned = raw_path.strip()
    expected_prefix = f"tenants/{tenant_id}/assets/"
    if not cleaned.startswith(expected_prefix):
        errors.append(
            f"categories.branding.{asset_type} must start with '{expected_prefix}'."
        )
        return
    if ".." in cleaned.split("/"):
        errors.append(f"categories.branding.{asset_type} contains unsafe path traversal.")
        return

    ext = Path(cleaned).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        errors.append(
            f"categories.branding.{asset_type} has unsupported extension '{ext}'."
        )
        return

    absolute = (backend_dir / cleaned).resolve()
    allowed_root = (backend_dir / "tenants" / tenant_id / "assets").resolve()
    try:
        absolute.relative_to(allowed_root)
    except ValueError:
        errors.append(
            f"categories.branding.{asset_type} resolves outside tenant assets directory."
        )
        return

    if not absolute.exists():
        errors.append(
            f"categories.branding.{asset_type} points to a missing file: {cleaned}"
        )


def validate_manifest_for_implementation(manifest: dict, backend_dir: Path) -> None:
    errors: list[str] = []

    tenant_id = manifest.get("tenant_id")
    if not isinstance(tenant_id, str) or not _TENANT_RE.match(tenant_id):
        errors.append("tenant_id is required and must be a slug like 'draft-tenant'.")
        tenant_id = "draft-tenant"

    categories = _as_dict(manifest.get("categories"))
    branding = _as_dict(categories.get("branding"))
    theme = _as_dict(categories.get("theme"))
    domains = _as_dict(categories.get("domains"))

    for field_name in ("company_name", "title"):
        value = branding.get(field_name)
        if not isinstance(value, str) or not value.strip():
            errors.append(f"categories.branding.{field_name} is required.")

    email = branding.get("contact_email")
    if email not in (None, ""):
        if not isinstance(email, str) or not _EMAIL_RE.match(email.strip()):
            errors.append("categories.branding.contact_email must be a valid email.")

    _validate_color(theme.get("primary"), "categories.theme.primary", errors)
    _validate_color(theme.get("secondary"), "categories.theme.secondary", errors)
    _validate_color(theme.get("accent"), "categories.theme.accent", errors)

    for field_name in ("site_url", "admin_url", "api_base_url", "video_base_url"):
        _validate_domain(domains.get(field_name), f"categories.domains.{field_name}", errors)

    for asset_type in SUPPORTED_ASSET_TYPES:
        _validate_asset_path(
            tenant_id=tenant_id,
            backend_dir=backend_dir,
            asset_type=asset_type,
            raw_path=branding.get(asset_type),
            errors=errors,
        )

    if errors:
        raise ManifestValidationError(errors)
