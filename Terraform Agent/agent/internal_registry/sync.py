"""Sync pin metadata from the public Terraform Registry (read-only check).

Does not auto-bump major versions — prints drift for operators to refresh contracts.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

from .catalog import list_services, load_catalog

REGISTRY_API = "https://registry.terraform.io/v1/modules"


def _fetch_module_versions(namespace: str, name: str, provider: str) -> list[str]:
    url = f"{REGISTRY_API}/{namespace}/{name}/{provider}/versions"
    req = urllib.request.Request(url, headers={"User-Agent": "deplai-internal-registry/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 — public registry API
        payload = json.loads(resp.read().decode("utf-8"))
    modules = payload.get("modules") if isinstance(payload, dict) else None
    if not isinstance(modules, list) or not modules:
        return []
    versions = modules[0].get("versions") if isinstance(modules[0], dict) else None
    if not isinstance(versions, list):
        return []
    out: list[str] = []
    for item in versions:
        if isinstance(item, dict) and item.get("version"):
            out.append(str(item["version"]))
        elif isinstance(item, str):
            out.append(item)
    return out


def check_drift() -> list[dict[str, Any]]:
    catalog = load_catalog()
    services = catalog.get("services") if isinstance(catalog.get("services"), dict) else {}
    reports: list[dict[str, Any]] = []
    for service_id in list_services():
        entry = services.get(service_id) or {}
        if entry.get("kind") != "module":
            continue
        source = str(entry.get("source") or "")
        pinned = str(entry.get("version") or "")
        parts = source.split("/")
        if len(parts) != 3:
            continue
        namespace, name, provider = parts
        try:
            versions = _fetch_module_versions(namespace, name, provider)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            reports.append(
                {
                    "id": service_id,
                    "source": source,
                    "pinned": pinned,
                    "error": str(exc),
                }
            )
            continue
        latest = versions[0] if versions else None
        reports.append(
            {
                "id": service_id,
                "source": source,
                "pinned": pinned,
                "latest": latest,
                "drift": bool(latest and pinned and latest != pinned),
                "same_major": bool(
                    latest
                    and pinned
                    and latest.split(".")[0] == pinned.split(".")[0]
                ),
            }
        )
    return reports


def main() -> None:
    reports = check_drift()
    print(json.dumps(reports, indent=2))
    drifting = [item for item in reports if item.get("drift")]
    if drifting:
        print(f"\n{len(drifting)} service(s) have newer registry versions (contracts not auto-bumped).")


if __name__ == "__main__":
    main()
