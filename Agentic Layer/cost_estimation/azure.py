"""
Azure cost estimation module.
Adapted from DeplAI_old/azure_cost_estimation.py — RabbitMQ removed,
uses Azure Retail Prices API (no SDK required).
"""

import logging
import time
import requests
from typing import Any

logger = logging.getLogger(__name__)

_AZURE_PRICES_URL = "https://prices.azure.com/api/retail/prices"
_MAX_RETRIES = 3
_RETRY_DELAY = 2


def _api_get(params: dict) -> dict | None:
    for attempt in range(_MAX_RETRIES):
        try:
            resp = requests.get(_AZURE_PRICES_URL, params=params, timeout=30)
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:
            logger.warning("Azure pricing API attempt %d failed: %s", attempt + 1, exc)
            if attempt < _MAX_RETRIES - 1:
                time.sleep(_RETRY_DELAY)
    return None


def _all_pages(filt: str) -> list[dict]:
    params = {"$filter": filt, "api-version": "2023-01-01-preview"}
    items: list[dict] = []
    while True:
        data = _api_get(params)
        if not data:
            break
        items.extend(data.get("Items", []))
        nxt = data.get("NextPageLink", "")
        if not nxt:
            break
        skip = nxt.split("$skiptoken=")[-1]
        params = {"$filter": filt, "api-version": "2023-01-01-preview", "$skiptoken": skip}
    return items


def _vm_estimate(node: dict) -> dict:
    attrs = node.get("attributes", {})
    region = node.get("region", "eastus")
    sku_name = attrs.get("vmSize", "Standard_D2_v3")
    os_name = attrs.get("operatingSystem", "Linux")
    hours_per_month = attrs.get("hoursPerMonth", 730)
    num_instances = attrs.get("numberOfInstances", 1)

    filt = (
        f"serviceName eq 'Virtual Machines' and "
        f"armRegionName eq '{region}' and "
        f"armSkuName eq '{sku_name}'"
    )
    resp = _api_get({"$filter": filt, "api-version": "2023-01-01-preview"})
    items = resp.get("Items", []) if resp else []

    for item in items:
        if item.get("type") != "Consumption":
            continue
        if item.get("unitOfMeasure") != "1 Hour":
            continue
        name_lower = item.get("productName", "").lower()
        meter_lower = item.get("meterName", "").lower()
        if os_name.lower() not in name_lower:
            continue
        exclusions = ["spot", "low priority", "byol", "promo", "dev/test"]
        if any(e in name_lower or e in meter_lower for e in exclusions):
            continue
        hourly = item["retailPrice"]
        monthly = round(hourly * hours_per_month * num_instances, 4)
        return {
            "service": "VirtualMachines",
            "vm_monthly_usd": monthly,
            "vm_total_monthly_usd": monthly,
            "currency": item.get("currencyCode", "USD"),
        }
    return {"service": "VirtualMachines", "vm_total_monthly_usd": 0.0, "error": "No pricing match found"}


def _function_estimate(node: dict) -> dict:
    attrs = node.get("attributes", {})
    region = node.get("region", "eastus")
    monthly_execs = attrs.get("monthlyExecutions", 0)
    exec_ms = attrs.get("executionTimeMs", 0)
    mem_mb = attrs.get("memorySizeMB", 128)

    FREE_EXEC = 1_000_000
    FREE_GB_SEC = 400_000
    mem_gb = mem_mb / 1024
    exec_s = exec_ms / 1000
    total_gb_sec = monthly_execs * mem_gb * exec_s
    billed_execs = max(monthly_execs - FREE_EXEC, 0)
    billed_gb_sec = max(total_gb_sec - FREE_GB_SEC, 0)

    filt = (
        f"serviceName eq 'Functions' and "
        f"priceType eq 'Consumption' and "
        f"armRegionName eq '{region}'"
    )
    meters = _all_pages(filt)
    exec_price = 0.0
    gb_sec_price = 0.0
    for m in meters:
        if m.get("skuName", "").lower() != "standard":
            continue
        name_lower = m.get("meterName", "").lower()
        unit_lower = m.get("unitOfMeasure", "").lower()
        if "total executions" in name_lower and m.get("unitOfMeasure") == "10":
            exec_price = m["retailPrice"] / 10
        elif "execution time" in name_lower and "gb second" in unit_lower:
            gb_sec_price = m["retailPrice"]

    cost = round(billed_execs * exec_price + billed_gb_sec * gb_sec_price, 4)
    return {"service": "AzureFunctions", "function_total_monthly_usd": cost}


def _blob_estimate(node: dict) -> dict:
    attrs = node.get("attributes", {})
    region = node.get("region", "eastus")
    redundancy = attrs.get("redundancy", "LRS").upper()
    access_tier = attrs.get("accessTier", "Hot").capitalize()
    capacity_gb = attrs.get("storageGB", 0.0)

    filt = (
        f"serviceName eq 'Storage' and "
        f"armRegionName eq '{region}' and "
        f"contains(tolower(productName), 'blob') and "
        f"contains(tolower(meterName), 'data stored') and "
        f"priceType eq 'Consumption'"
    )
    items = _all_pages(filt)
    monthly_cost = 0.0
    for item in items:
        if access_tier.lower() in item.get("meterName", "").lower() and \
                redundancy.lower() in item.get("skuName", "").lower() and \
                "gb/month" in item.get("unitOfMeasure", "").lower():
            monthly_cost = round(item["retailPrice"] * capacity_gb, 4)
            break
    return {"service": "BlobStorage", "blob_total_monthly_usd": monthly_cost}


def _sql_estimate(node: dict) -> dict:
    attrs = node.get("attributes", {})
    region = node.get("region", "eastus")
    tier = attrs.get("serviceTier", "Standard")
    level = attrs.get("performanceLevel", "S0")
    storage_gb = attrs.get("storageGB", 250)

    filt = (
        f"serviceName eq 'SQL Database' and "
        f"armRegionName eq '{region}' and "
        f"contains(tolower(skuName), '{tier.lower()}') and "
        f"priceType eq 'Consumption'"
    )
    items = _all_pages(filt)
    monthly_cost = 0.0
    for item in items:
        if level.lower() in item.get("meterName", "").lower():
            monthly_cost = round(item["retailPrice"] * 730, 4)
            break
    return {"service": "SQLDatabase", "sql_total_monthly_usd": monthly_cost}


def _vnet_estimate(node: dict) -> dict:
    attrs = node.get("attributes", {})
    outbound_gb = attrs.get("outboundDataGB", 0)
    static_ips = attrs.get("staticPublicIPs", 0)
    # Approximate: $0.087/GB outbound + ~$0.004/hr per static IP
    cost = round(outbound_gb * 0.087 + static_ips * 0.004 * 730, 4)
    return {"service": "VirtualNetwork", "vnet_total_monthly_usd": cost}


_TYPE_MAP = {
    "VirtualMachines": _vm_estimate,
    "AzureFunctions": _function_estimate,
    "BlobStorage": _blob_estimate,
    "SQLDatabase": _sql_estimate,
    "VirtualNetwork": _vnet_estimate,
}


def estimate_cost(architecture_json: dict, **_kwargs: Any) -> dict:
    """
    Estimate monthly Azure costs from an architecture JSON.
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
            logger.warning("Azure cost estimate failed for %s: %s", ntype, exc)
            errors.append(f"{ntype}: {exc}")

    return {
        "success": True,
        "provider": "azure",
        "total_monthly_usd": round(total, 2),
        "currency": "USD",
        "breakdown": breakdown,
        "errors": errors,
    }
