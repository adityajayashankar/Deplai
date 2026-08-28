"""Load catalog.json, contracts, and snippets for the internal registry."""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

_REGISTRY_ROOT = Path(__file__).resolve().parent
_CATALOG_PATH = _REGISTRY_ROOT / "catalog.json"
_CONTRACTS_DIR = _REGISTRY_ROOT / "contracts"
_SNIPPETS_DIR = _REGISTRY_ROOT / "snippets"


@lru_cache(maxsize=1)
def load_catalog() -> dict[str, Any]:
    return json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))


def resolve_service_id(name: str) -> str:
    catalog = load_catalog()
    key = str(name or "").strip().lower().replace("-", "_")
    aliases = catalog.get("aliases") if isinstance(catalog.get("aliases"), dict) else {}
    resolved = str(aliases.get(key, key))
    services = catalog.get("services") if isinstance(catalog.get("services"), dict) else {}
    if resolved not in services:
        raise KeyError(f"Unknown registry service: {name!r}. Known: {sorted(services)}")
    return resolved


def get_module(name: str) -> dict[str, Any]:
    """Compatibility shape matching the legacy module_catalog.get_module API."""
    catalog = load_catalog()
    service_id = resolve_service_id(name)
    entry = dict(catalog["services"][service_id])
    # Preserve legacy keys expected by enterprise_bundle / template_registry.
    return {
        "source": entry.get("source"),
        "version": entry.get("version"),
        "constraint": entry.get("constraint"),
        "template": entry.get("template"),
        "resource": entry.get("resource"),
        "notes": entry.get("notes"),
        "kind": entry.get("kind"),
        "contract": entry.get("contract"),
        "snippet": entry.get("snippet"),
        "id": service_id,
    }


def list_services() -> list[str]:
    catalog = load_catalog()
    services = catalog.get("services") if isinstance(catalog.get("services"), dict) else {}
    return sorted(services.keys())


def catalog_summary() -> list[dict[str, Any]]:
    catalog = load_catalog()
    services = catalog.get("services") if isinstance(catalog.get("services"), dict) else {}
    aliases = catalog.get("aliases") if isinstance(catalog.get("aliases"), dict) else {}
    also_known: dict[str, list[str]] = {}
    for alias, target in aliases.items():
        also_known.setdefault(str(target), []).append(str(alias))
    return [
        {
            "id": key,
            "source": value.get("source"),
            "version": value.get("version"),
            "constraint": value.get("constraint"),
            "template": value.get("template"),
            "resource": value.get("resource"),
            "kind": value.get("kind"),
            "contract": value.get("contract"),
            "aliases": sorted(also_known.get(key, [])),
        }
        for key, value in services.items()
        if isinstance(value, dict)
    ]


def module_source_block(name: str, *, use_constraint: bool = False) -> str:
    """Emit source + exact version pin for a registry module.

    ``use_constraint`` is retained for API compatibility but ignored: open-ended
    constraints (``>=`` / ``~>``) on module blocks pull newest majors that often
    require AWS provider 6.x. Always pin ``version = "X.Y.Z"``.
    """
    del use_constraint  # exact pins only
    entry = get_module(name)
    source = str(entry.get("source") or "").strip()
    if not source or entry.get("resource"):
        raise ValueError(f"Catalog entry {name!r} is a native resource, not a registry module")
    version = str(entry.get("version") or "").strip()
    if not version or any(token in version for token in (">=", "~>", "<", ",")):
        raise ValueError(
            f"Catalog entry {name!r} must declare an exact module version, got {version!r}"
        )
    return "\n".join([f'  source  = "{source}"', f'  version = "{version}"'])


def assert_catalog_pin_policy() -> None:
    """Fail fast if any module pin is open-ended or diverges from version."""
    catalog = load_catalog()
    services = catalog.get("services") if isinstance(catalog.get("services"), dict) else {}
    for service_id, entry in services.items():
        if not isinstance(entry, dict) or entry.get("kind") != "module":
            continue
        version = str(entry.get("version") or "").strip()
        constraint = str(entry.get("constraint") or "").strip()
        if not version or any(token in version for token in (">=", "~>", "<", ",")):
            raise ValueError(f"Service {service_id!r} needs exact version, got {version!r}")
        if constraint and constraint != version:
            raise ValueError(
                f"Service {service_id!r} constraint {constraint!r} must equal exact version {version!r}"
            )
    provider = catalog.get("provider") if isinstance(catalog.get("provider"), dict) else {}
    provider_constraint = str(provider.get("constraint") or "").strip()
    if provider_constraint.startswith(">=") and "<" not in provider_constraint:
        raise ValueError(
            f"Provider constraint must keep an upper bound (got {provider_constraint!r}); "
            "never use bare >= which allows AWS provider 6.x drift"
        )


@lru_cache(maxsize=64)
def get_contract(name: str) -> dict[str, Any]:
    service = get_module(name)
    contract_id = str(service.get("contract") or resolve_service_id(name)).strip()
    path = _CONTRACTS_DIR / f"{contract_id}.json"
    if not path.exists():
        raise FileNotFoundError(f"Missing contract for {name!r}: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def get_edit_schema(name: str) -> list[dict[str, Any]]:
    contract = get_contract(name)
    edits = contract.get("edit_schema")
    return list(edits) if isinstance(edits, list) else []


def filter_allowlisted_edits(service: str, edits: dict[str, Any] | None) -> dict[str, Any]:
    """Keep only keys declared in the service edit_schema (agent small-edit surface)."""
    if not isinstance(edits, dict):
        return {}
    allowed = {
        str(item.get("name") or "").strip()
        for item in get_edit_schema(service)
        if isinstance(item, dict) and str(item.get("name") or "").strip()
    }
    return {key: value for key, value in edits.items() if key in allowed}


def render_snippet(name: str, params: dict[str, Any] | None = None) -> str:
    """Render a golden HCL snippet with allowlisted params + pinned source/version."""
    service = get_module(name)
    snippet_name = str(service.get("snippet") or "").strip()
    if not snippet_name:
        raise ValueError(f"Service {name!r} has no golden snippet")
    path = _SNIPPETS_DIR / snippet_name
    if not path.exists():
        raise FileNotFoundError(f"Missing snippet for {name!r}: {path}")

    values: dict[str, Any] = {
        "source": service.get("source") or "",
        "version": service.get("version") or "",
    }
    for item in get_edit_schema(name):
        if not isinstance(item, dict):
            continue
        key = str(item.get("name") or "").strip()
        if not key:
            continue
        values[key] = item.get("default")
    if params:
        # Only allowlisted edit keys (plus source/version already set).
        allowed = {str(item.get("name") or "") for item in get_edit_schema(name)}
        for key, value in params.items():
            if key in allowed or key in {"source", "version", "handler", "health_path"}:
                values[key] = value

    # Sensible fallbacks used by snippets.
    values.setdefault("root_volume_size_gb", 8)
    values.setdefault("health_path", "/")
    values.setdefault("engine", "postgres")
    values.setdefault("engine_version", "15.17")
    values.setdefault("instance_class", "db.t4g.micro")
    values.setdefault("allocated_storage", 20)
    values.setdefault("multi_az", "false")
    values.setdefault("node_type", "cache.t4g.micro")
    values.setdefault("price_class", "PriceClass_100")
    values.setdefault("runtime", "python3.12")
    values.setdefault("handler", "index.handler")
    values.setdefault("memory_size", 128)
    values.setdefault("timeout", 30)

    text = path.read_text(encoding="utf-8")
    # Convert bools to HCL literals.
    for key, value in list(values.items()):
        if isinstance(value, bool):
            values[key] = "true" if value else "false"
        elif value is None:
            values[key] = ""

    def _replace(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in values:
            raise KeyError(f"Snippet {snippet_name} references unknown param {key!r}")
        return str(values[key])

    return re.sub(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}", _replace, text)


# Legacy constant expected by importers.
STABLE_ENDPOINT_OUTPUTS: tuple[str, ...] = tuple(
    str(item) for item in (load_catalog().get("stable_endpoint_outputs") or [])
)


# Expose MODULE_CATALOG-like mapping for template_registry.
def _module_catalog_dict() -> dict[str, dict[str, Any]]:
    catalog = load_catalog()
    services = catalog.get("services") if isinstance(catalog.get("services"), dict) else {}
    legacy_keys = (
        "vpc",
        "ec2_instance",
        "alb",
        "security_group",
        "rds",
        "rds_aurora",
        "elasticache",
        "eip",
        "nat_gateway",
        "s3_cloudfront",
        "cloudfront",
        "s3_bucket",
        "lambda",
    )
    out: dict[str, dict[str, Any]] = {}
    for key in legacy_keys:
        if key in services:
            out[key] = get_module(key)
    return out


MODULE_CATALOG: dict[str, dict[str, Any]] = _module_catalog_dict()
