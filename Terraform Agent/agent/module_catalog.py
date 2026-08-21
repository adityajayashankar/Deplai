"""Curated pinned terraform-aws-modules catalog for deterministic IaC generation.

Compatibility facade over ``agent.internal_registry``. Prefer importing from
``agent.internal_registry`` for contracts, snippets, and edit schemas.
"""

from __future__ import annotations

from typing import Any

from .internal_registry.catalog import (
    MODULE_CATALOG,
    STABLE_ENDPOINT_OUTPUTS,
    catalog_summary,
    get_module,
    module_source_block,
)

__all__ = [
    "MODULE_CATALOG",
    "STABLE_ENDPOINT_OUTPUTS",
    "catalog_summary",
    "get_module",
    "module_source_block",
]


# Re-export for type checkers / star imports.
def __getattr__(name: str) -> Any:
    if name == "MODULE_CATALOG":
        from .internal_registry.catalog import MODULE_CATALOG as catalog

        return catalog
    raise AttributeError(name)
