"""
asset_service.py — per-tenant branding asset storage.

Handles validation, storage and metadata tracking for uploaded branding files
(logos, favicons, branding images).  Assets are written to
  tenants/{tenant_id}/assets/{canonical_name}{ext}
and metadata is kept in the same directory as assets.json.
"""
from __future__ import annotations

from io import BytesIO
import json
import mimetypes
import re
from pathlib import Path

from PIL import Image, UnidentifiedImageError


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ALLOWED_CONTENT_TYPES: frozenset[str] = frozenset(
    {
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
        "image/svg+xml",
        "image/x-icon",
        "image/vnd.microsoft.icon",
    }
)

ALLOWED_EXTENSIONS: frozenset[str] = frozenset(
    {".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico"}
)

# 5 MB hard cap per file
MAX_FILE_SIZE_BYTES: int = 5 * 1024 * 1024

SUPPORTED_ASSET_TYPES: frozenset[str] = frozenset(
    {
        # Identity
        "logo_light",       # Primary brand logo (light / default background)
        "logo_dark",        # Brand logo for dark backgrounds
        "favicon",          # Browser tab icon
        # Social / SEO
        "og_image",         # Open-graph / social sharing card image
        # Landing-page sections
        "hero_illustration",     # Hero section right-side artwork
        "why_background",        # 'Why / Curated' section full-bleed background
        "activities_background", # Activities section full-bleed background
        "curated_image",         # Curated-activities section featured image
    }
)

# Canonical base-names used when writing to disk
_CANONICAL_NAME: dict[str, str] = {
    "logo_light": "logo-light",
    "logo_dark": "logo-dark",
    "favicon": "favicon",
    "og_image": "og-image",
    "hero_illustration": "hero-illustration",
    "why_background": "why-background",
    "activities_background": "activities-background",
    "curated_image": "curated-image",
}

# Only allow tenant-ids produced by ManifestState._slugify: [a-z0-9-]
_SAFE_TENANT_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{0,62}$")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _assert_safe_tenant_id(tenant_id: str) -> str:
    """Return the tenant_id unchanged, or raise ValueError if unsafe."""
    if not isinstance(tenant_id, str) or not _SAFE_TENANT_RE.match(tenant_id):
        raise ValueError(
            f"Invalid tenant_id {tenant_id!r}. Must match [a-z0-9][a-z0-9-]{{0,62}}."
        )
    return tenant_id


def _tenant_assets_dir(base_dir: Path, tenant_id: str) -> Path:
    """Return the resolved assets directory for a tenant (no mkdir yet)."""
    safe_id = _assert_safe_tenant_id(tenant_id)
    # Use .resolve() to prevent any path-traversal sneaking through symlinks
    return (base_dir / "tenants" / safe_id / "assets").resolve()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def validate_upload(content_type: str, file_size: int, filename: str) -> None:
    """
    Raise ValueError if the file does not pass security checks:
      - extension must be in ALLOWED_EXTENSIONS
      - content_type must be in ALLOWED_CONTENT_TYPES (or guessable from extension)
      - file_size must not exceed MAX_FILE_SIZE_BYTES
    """
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise ValueError(
            f"File extension '{ext}' is not allowed. "
            f"Accepted extensions: {sorted(ALLOWED_EXTENSIONS)}"
        )
    # Accept by explicit type or by mimetypes fallback (catches image/x-icon variants)
    if content_type not in ALLOWED_CONTENT_TYPES:
        guessed, _ = mimetypes.guess_type(filename)
        if guessed not in ALLOWED_CONTENT_TYPES:
            raise ValueError(
                f"Content type '{content_type}' is not an accepted image type. "
                "Only image files are allowed."
            )
    if file_size > MAX_FILE_SIZE_BYTES:
        mb = MAX_FILE_SIZE_BYTES // (1024 * 1024)
        raise ValueError(f"File exceeds the maximum allowed size of {mb} MB.")


def _transform_asset(
    asset_type: str,
    file_data: bytes,
    original_filename: str,
) -> tuple[bytes, str, str]:
    """
    Returns transformed bytes, final extension, and content_type.

    Rules:
    - logos: resize within 512x512, normalize to PNG
    - favicon: generate multi-size ICO (16/32/48)
    - hero/banner images: resize within 1920x1920, normalize to WEBP
    - SVG assets: left unchanged (Pillow does not rasterize SVG safely)
    """
    ext = Path(original_filename).suffix.lower()

    # Keep SVG untouched for vector quality and compatibility.
    if ext == ".svg":
        return file_data, ".svg", "image/svg+xml"

    try:
        image = Image.open(BytesIO(file_data))
    except UnidentifiedImageError as exc:
        raise ValueError("Uploaded file is not a valid image.") from exc

    # Normalize alpha-safe mode first.
    if image.mode not in {"RGB", "RGBA"}:
        image = image.convert("RGBA")

    if asset_type in {"logo_light", "logo_dark"}:
        transformed = image.copy()
        transformed.thumbnail((512, 512), Image.Resampling.LANCZOS)
        output = BytesIO()
        transformed.save(output, format="PNG", optimize=True)
        return output.getvalue(), ".png", "image/png"

    if asset_type == "favicon":
        transformed = image.convert("RGBA")
        transformed.thumbnail((256, 256), Image.Resampling.LANCZOS)
        output = BytesIO()
        transformed.save(output, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
        return output.getvalue(), ".ico", "image/x-icon"

    # hero_illustration, og_image, why_background, activities_background, curated_image
    transformed = image.convert("RGB")
    transformed.thumbnail((1920, 1920), Image.Resampling.LANCZOS)
    output = BytesIO()
    transformed.save(output, format="WEBP", quality=86, method=6)
    return output.getvalue(), ".webp", "image/webp"


def store_asset(
    base_dir: Path,
    tenant_id: str,
    asset_type: str,
    file_data: bytes,
    original_filename: str,
    content_type: str,
) -> str:
    """
    Validate and persist an uploaded branding asset.

    Returns the manifest-relative path string, e.g.
      "tenants/draft-tenant/assets/logo-light.png"
    which is stored in categories.branding.{asset_type} in the manifest.
    """
    if asset_type not in SUPPORTED_ASSET_TYPES:
        raise ValueError(
            f"Unsupported asset_type {asset_type!r}. "
            f"Supported types: {sorted(SUPPORTED_ASSET_TYPES)}"
        )
    validate_upload(content_type, len(file_data), original_filename)

    transformed_bytes, transformed_ext, transformed_content_type = _transform_asset(
        asset_type=asset_type,
        file_data=file_data,
        original_filename=original_filename,
    )

    assets_dir = _tenant_assets_dir(base_dir, tenant_id)
    assets_dir.mkdir(parents=True, exist_ok=True)

    # Build canonical filename: e.g. "logo-light.png"
    canonical = _CANONICAL_NAME[asset_type]
    dest_filename = f"{canonical}{transformed_ext}"
    dest_path = assets_dir / dest_filename

    # Safety check: destination must stay inside assets_dir
    try:
        dest_path.relative_to(assets_dir)
    except ValueError as exc:
        raise ValueError("Path traversal detected in asset destination.") from exc

    # Write atomically: write to a temp file then rename
    tmp_path = assets_dir / f".{dest_filename}.tmp"
    try:
        tmp_path.write_bytes(transformed_bytes)
        tmp_path.replace(dest_path)
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)

    # Remove previous versions with other extensions to keep one canonical asset per type.
    for extension in ALLOWED_EXTENSIONS:
        stale = assets_dir / f"{canonical}{extension}"
        if stale != dest_path and stale.exists():
            stale.unlink(missing_ok=True)

    # Update the assets metadata sidecar
    metadata_path = assets_dir / "assets.json"
    metadata: dict[str, dict] = {}
    if metadata_path.exists():
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            metadata = {}

    metadata[asset_type] = {
        "filename": dest_filename,
        "original_name": original_filename,
        "content_type": transformed_content_type,
        "size_bytes": len(transformed_bytes),
        "transformed": True,
    }
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    safe_id = _assert_safe_tenant_id(tenant_id)
    return f"tenants/{safe_id}/assets/{dest_filename}"


def get_assets_metadata(base_dir: Path, tenant_id: str) -> dict[str, dict]:
    """Return the stored assets.json metadata dict (empty dict if none yet)."""
    assets_dir = _tenant_assets_dir(base_dir, tenant_id)
    metadata_path = assets_dir / "assets.json"
    if not metadata_path.exists():
        return {}
    try:
        return json.loads(metadata_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def get_asset_file_path(
    base_dir: Path, tenant_id: str, asset_type: str
) -> Path | None:
    """Return the absolute Path to the stored asset file, or None if not found."""
    if asset_type not in SUPPORTED_ASSET_TYPES:
        return None
    _assert_safe_tenant_id(tenant_id)
    assets_dir = _tenant_assets_dir(base_dir, tenant_id)
    if not assets_dir.exists():
        return None
    canonical = _CANONICAL_NAME[asset_type]
    for ext in ALLOWED_EXTENSIONS:
        candidate = assets_dir / f"{canonical}{ext}"
        if candidate.exists():
            return candidate
    return None
