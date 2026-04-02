from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .runtime import ensure_dir, knowledge_root, utc_now_iso


REGISTRY_BASE = "https://registry.terraform.io/v1"
LANGUAGE_DOC_URL = "https://developer.hashicorp.com/terraform/language"


def knowledge_cache_path(provider_version: str, resource_type: str) -> Path:
    safe_version = str(provider_version).strip()
    safe_resource = str(resource_type).strip().lower()
    return knowledge_root() / safe_version / f"{safe_resource}.json"


def is_cache_stale(entry: dict[str, Any] | None, provider_version: str, max_age_days: int = 7) -> bool:
    if not entry:
        return True
    if str(entry.get("provider_version") or "").strip() != str(provider_version).strip():
        return True
    fetched_at_raw = str(entry.get("fetched_at") or "").strip()
    if not fetched_at_raw:
        return True
    try:
        fetched_at = datetime.fromisoformat(fetched_at_raw.replace("Z", "+00:00"))
    except ValueError:
        return True
    return datetime.now(timezone.utc) - fetched_at > timedelta(days=max_age_days)


def _resource_slug(resource_type: str) -> str:
    resource_type = str(resource_type or "").strip().lower()
    if resource_type.startswith("aws_"):
        return resource_type[4:]
    return resource_type


def _walk_argument_schema(raw: Any) -> tuple[list[str], list[str], list[str], dict[str, Any]]:
    required: list[str] = []
    optional: list[str] = []
    deprecated: list[str] = []
    attributes: dict[str, Any] = {}

    if isinstance(raw, list):
        for item in raw:
            req, opt, dep, attr = _walk_argument_schema(item)
            required.extend(req)
            optional.extend(opt)
            deprecated.extend(dep)
            attributes.update(attr)
        return sorted(set(required)), sorted(set(optional)), sorted(set(deprecated)), attributes

    if not isinstance(raw, dict):
        return required, optional, deprecated, attributes

    if {"name", "required"} <= set(raw.keys()):
        name = str(raw.get("name") or "").strip()
        if name:
            attributes[name] = raw
            if bool(raw.get("deprecated")):
                deprecated.append(name)
            if bool(raw.get("required")):
                required.append(name)
            else:
                optional.append(name)

    for key, value in raw.items():
        if key in {"attributes", "arguments", "block", "schema", "fields"}:
            req, opt, dep, attr = _walk_argument_schema(value)
            required.extend(req)
            optional.extend(opt)
            deprecated.extend(dep)
            attributes.update(attr)
        elif isinstance(value, (dict, list)):
            req, opt, dep, attr = _walk_argument_schema(value)
            required.extend(req)
            optional.extend(opt)
            deprecated.extend(dep)
            attributes.update(attr)

    return sorted(set(required)), sorted(set(optional)), sorted(set(deprecated)), attributes


def _normalize_module_candidates(payload: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    items = payload.get("modules") or payload.get("items") or []
    if not isinstance(items, list):
        return []
    candidates: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        source = item.get("id") or item.get("source") or item.get("full_name")
        if not source:
            namespace = item.get("namespace")
            name = item.get("name")
            provider = item.get("provider")
            if namespace and name and provider:
                source = f"{namespace}/{name}/{provider}"
        if not source:
            continue
        latest_version = item.get("version") or item.get("latest_version")
        downloads = item.get("downloads") or item.get("download_count") or 0
        published_at = item.get("published_at") or item.get("updated_at") or item.get("created_at")
        subresources = item.get("sub_resources") or item.get("resources") or []
        coverage = len(subresources) if isinstance(subresources, list) else 0
        candidates.append(
            {
                "source": str(source),
                "version": str(latest_version or ""),
                "downloads": int(downloads or 0),
                "published_at": str(published_at or ""),
                "subresource_count": coverage,
            }
        )
    candidates.sort(key=lambda item: (item["downloads"], item["published_at"]), reverse=True)
    return candidates[:10]


def fetch_knowledge(
    provider_version: str,
    resource_type: str,
    refresh_docs: bool = False,
    http_session: Any | None = None,
) -> dict[str, Any]:
    import requests

    cache_path = knowledge_cache_path(provider_version, resource_type)
    if cache_path.exists() and not refresh_docs:
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if not is_cache_stale(cached, provider_version):
                return cached
        except json.JSONDecodeError:
            pass

    session = http_session or requests.Session()
    slug = _resource_slug(resource_type)
    docs_url = f"{REGISTRY_BASE}/providers/hashicorp/aws/{provider_version}/docs/resources/{slug}"
    modules_url = f"{REGISTRY_BASE}/modules"

    docs_payload: dict[str, Any] | None = None
    module_payload: dict[str, Any] | None = None
    errors: list[str] = []

    try:
        docs_res = session.get(docs_url, timeout=30)
        docs_res.raise_for_status()
        docs_payload = docs_res.json()
    except Exception as exc:
        errors.append(f"docs_fetch_failed: {exc}")
        docs_payload = {}

    try:
        modules_res = session.get(
            modules_url,
            params={"provider": "aws", "verified": "true", "q": slug},
            timeout=30,
        )
        modules_res.raise_for_status()
        module_payload = modules_res.json()
    except Exception as exc:
        errors.append(f"module_fetch_failed: {exc}")
        module_payload = {}

    required_args, optional_args, deprecated_args, attributes = _walk_argument_schema(docs_payload)
    knowledge = {
        "provider_version": str(provider_version),
        "resource_type": str(resource_type),
        "fetched_at": utc_now_iso(),
        "doc_url": docs_url,
        "language_doc_url": LANGUAGE_DOC_URL,
        "schema": docs_payload or {},
        "required_args": required_args,
        "optional_args": optional_args,
        "deprecated_args": deprecated_args,
        "attributes": attributes,
        "module_candidates": _normalize_module_candidates(module_payload),
        "errors": errors,
    }
    ensure_dir(cache_path.parent)
    cache_path.write_text(json.dumps(knowledge, indent=2, sort_keys=True), encoding="utf-8")
    return knowledge
