"""Curated internal Terraform registry for core AWS services.

Public Terraform Registry pins + input contracts + golden snippets are the
source of truth. Generators and apply-time sanitizers must stay inside these
contracts so agents only make allowlisted small edits.
"""

from __future__ import annotations

from .catalog import (
    STABLE_ENDPOINT_OUTPUTS,
    assert_catalog_pin_policy,
    catalog_summary,
    filter_allowlisted_edits,
    get_contract,
    get_edit_schema,
    get_module,
    list_services,
    load_catalog,
    module_source_block,
    render_snippet,
    resolve_service_id,
)
from .edits import select_allowlisted_edits
from .contracts import (
    enforce_registry_contracts_on_text,
    rewrite_ec2_module_count_not_gated_on_key_reuse,
    rewrite_ec2_module_v5_compat,
)

__all__ = [
    "STABLE_ENDPOINT_OUTPUTS",
    "assert_catalog_pin_policy",
    "catalog_summary",
    "enforce_registry_contracts_on_text",
    "filter_allowlisted_edits",
    "get_contract",
    "get_edit_schema",
    "get_module",
    "list_services",
    "load_catalog",
    "module_source_block",
    "render_snippet",
    "resolve_service_id",
    "rewrite_ec2_module_count_not_gated_on_key_reuse",
    "rewrite_ec2_module_v5_compat",
    "select_allowlisted_edits",
]
