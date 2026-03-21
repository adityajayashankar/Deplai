"""
GCP cost estimation module.
The Google Cloud Billing SDK approach is not fully implemented upstream.
This module provides rule-based approximations for common GCP services
using publicly known on-demand rates (us-central1 baseline, ~Apr 2025).
"""

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Approximate on-demand monthly rates (USD) — us-central1 baseline
_GCE_RATES: dict[str, float] = {
    "e2-micro": 6.11,
    "e2-small": 12.23,
    "e2-medium": 24.46,
    "e2-standard-2": 48.92,
    "e2-standard-4": 97.84,
    "n1-standard-1": 24.27,
    "n1-standard-2": 48.55,
    "n1-standard-4": 97.09,
    "n2-standard-2": 58.00,
    "n2-standard-4": 116.00,
}

_CLOUD_SQL_RATES: dict[str, float] = {
    "db-f1-micro": 7.67,
    "db-g1-small": 25.56,
    "db-n1-standard-1": 46.03,
    "db-n1-standard-2": 92.06,
    "db-n1-standard-4": 184.12,
}

_GCS_STANDARD_GB = 0.020   # per GB/month
_GCS_NEARLINE_GB = 0.010
_GCS_COLDLINE_GB = 0.004

_CLOUD_RUN_PER_M_REQUESTS = 0.40
_CLOUD_FUNCTIONS_PER_M_CALLS = 0.40


def _gce_estimate(node: dict) -> dict:
    attrs = node.get("attributes", {})
    instance_type = attrs.get("instanceType", "e2-medium")
    hourly_approx = _GCE_RATES.get(instance_type)
    if hourly_approx is None:
        # Unknown type → rough estimate $50/month
        hourly_approx = 50.0
    return {
        "service": "GCE",
        "gce_total_monthly_usd": round(hourly_approx, 2),
    }


def _cloud_sql_estimate(node: dict) -> dict:
    attrs = node.get("attributes", {})
    instance_type = attrs.get("instanceType", "db-n1-standard-1")
    storage_gb = attrs.get("storageGB", 10)
    instance_cost = _CLOUD_SQL_RATES.get(instance_type, 46.03)
    storage_cost = round(storage_gb * 0.17, 4)  # SSD storage ~$0.17/GB
    total = round(instance_cost + storage_cost, 4)
    return {
        "service": "CloudSQL",
        "sql_instance_monthly_usd": instance_cost,
        "sql_storage_monthly_usd": storage_cost,
        "cloudsql_total_monthly_usd": total,
    }


def _gcs_estimate(node: dict) -> dict:
    attrs = node.get("attributes", {})
    storage_gb = attrs.get("storageGB", 100)
    storage_class = attrs.get("storageClass", "Standard").lower()
    rates = {"standard": _GCS_STANDARD_GB, "nearline": _GCS_NEARLINE_GB, "coldline": _GCS_COLDLINE_GB}
    rate = rates.get(storage_class, _GCS_STANDARD_GB)
    monthly = round(storage_gb * rate, 4)
    return {"service": "GCS", "gcs_total_monthly_usd": monthly}


def _cloud_functions_estimate(node: dict) -> dict:
    attrs = node.get("attributes", {})
    monthly_calls = attrs.get("monthlyInvocations", 1_000_000)
    billed = max(monthly_calls - 2_000_000, 0)  # 2M free tier
    cost = round((billed / 1_000_000) * _CLOUD_FUNCTIONS_PER_M_CALLS, 4)
    return {"service": "CloudFunctions", "cloudfunctions_total_monthly_usd": cost}


def _vpc_estimate(node: dict) -> dict:
    attrs = node.get("attributes", {})
    egress_gb = attrs.get("egressGB", 0)
    cost = round(egress_gb * 0.085, 4)  # ~$0.085/GB inter-region
    return {"service": "VPC", "vpc_total_monthly_usd": cost}


_TYPE_MAP = {
    "GCE": _gce_estimate,
    "CloudSQL": _cloud_sql_estimate,
    "GCS": _gcs_estimate,
    "CloudFunctions": _cloud_functions_estimate,
    "VPC": _vpc_estimate,
}


def estimate_cost(architecture_json: dict, **_kwargs: Any) -> dict:
    """
    Estimate monthly GCP costs from an architecture JSON.
    Uses rule-based approximations; not live API pricing.
    Returns {"success": bool, "breakdown": [...], "total_monthly_usd": float}.
    """
    nodes = architecture_json.get("nodes", [])
    breakdown = []
    total = 0.0
    errors = []

    for node in nodes:
        ntype = node.get("type", "")
        estimator = _TYPE_MAP.get(ntype)
        if not estimator:
            continue
        try:
            result = estimator(node)
            node_total = next(
                (v for k, v in result.items() if k.endswith("_total_monthly_usd") and isinstance(v, (int, float))),
                0.0,
            )
            total += node_total
            breakdown.append({
                "node_id": node.get("id", ntype),
                "service": ntype,
                "monthly_usd": round(node_total, 4),
                "detail": result,
            })
        except Exception as exc:
            logger.warning("GCP cost estimate failed for %s: %s", ntype, exc)
            errors.append(f"{ntype}: {exc}")

    return {
        "success": True,
        "provider": "gcp",
        "total_monthly_usd": round(total, 2),
        "currency": "USD",
        "note": "GCP estimates are rule-based approximations (us-central1 baseline), not live API pricing.",
        "breakdown": breakdown,
        "errors": errors,
    }
