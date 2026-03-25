"""
AWS cost estimation module.
Adapted from DeplAI_old/aws_cost_estimation.py — RabbitMQ removed,
logger replaced with stdlib logging.
"""

import json
import logging
import os

logger = logging.getLogger(__name__)

REGION_CODE_MAP = {
    "US East (N. Virginia)": "us-east-1",
    "US East (Ohio)": "us-east-2",
    "US West (N. California)": "us-west-1",
    "US West (Oregon)": "us-west-2",
    "Africa (Cape Town)": "af-south-1",
    "Asia Pacific (Hong Kong)": "ap-east-1",
    "Asia Pacific (Hyderabad)": "ap-south-2",
    "Asia Pacific (Jakarta)": "ap-southeast-3",
    "Asia Pacific (Melbourne)": "ap-southeast-4",
    "Asia Pacific (Mumbai)": "ap-south-1",
    "Asia Pacific (Osaka)": "ap-northeast-3",
    "Asia Pacific (Seoul)": "ap-northeast-2",
    "Asia Pacific (Singapore)": "ap-southeast-1",
    "Asia Pacific (Sydney)": "ap-southeast-2",
    "Asia Pacific (Tokyo)": "ap-northeast-1",
    "Canada (Central)": "ca-central-1",
    "Europe (Frankfurt)": "eu-central-1",
    "Europe (Ireland)": "eu-west-1",
    "Europe (London)": "eu-west-2",
    "Europe (Milan)": "eu-south-1",
    "Europe (Paris)": "eu-west-3",
    "Europe (Spain)": "eu-south-2",
    "Europe (Stockholm)": "eu-north-1",
    "Europe (Zurich)": "eu-central-2",
    "Middle East (Bahrain)": "me-south-1",
    "Middle East (UAE)": "me-central-1",
    "South America (São Paulo)": "sa-east-1",
    "AWS GovCloud (US-East)": "us-gov-east-1",
    "AWS GovCloud (US-West)": "us-gov-west-1",
}

REGION_USAGE_TYPE_PREFIX = {
    "ap-south-1": "APS3",
    "ap-southeast-1": "APS1",
    "us-east-1": "USE1",
    "us-west-2": "USW2",
    "eu-north-1": "EUN1",
    "eu-west-1": "EU",
    "eu-west-2": "EUW2",
    "eu-central-1": "EUC1",
}

EC2_HOURLY_FALLBACK = {
    "t3.micro": 0.0124,
    "t2.micro": 0.0116,
    "t3.small": 0.0208,
    "t3.medium": 0.0416,
    "t3.large": 0.0832,
}

EBS_GB_MONTH_FALLBACK = {
    "gp3": 0.08,
    "gp2": 0.10,
    "st1": 0.045,
    "sc1": 0.025,
}

S3_GB_MONTH_FALLBACK = {
    "General Purpose": 0.023,
    "Infrequent Access": 0.0125,
    "Archive": 0.004,
}


def _create_pricing_client(access_key: str, secret_key: str):
    import boto3
    return boto3.client(
        "pricing",
        region_name="us-east-1",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
    )


def _extract_monthly_price(price_list_item: str) -> float:
    """Parse a PriceList JSON item and return the OnDemand price per unit."""
    item = json.loads(price_list_item)
    terms = item.get("terms", {})
    term_key = next(iter(terms), None)
    if not term_key:
        return 0.0
    sku_map = terms[term_key]
    first_sku = next(iter(sku_map), None)
    if not first_sku:
        return 0.0
    dims = sku_map[first_sku].get("priceDimensions", {})
    dim = next(iter(dims.values()), {})
    return float(dim.get("pricePerUnit", {}).get("USD", 0.0))


def _ec2_estimate(client, node: dict) -> dict:
    attrs = node.get("attributes", {})
    region = node.get("region", "Asia Pacific (Mumbai)")
    instance_type = attrs.get("instanceType", "t3.micro")
    instance_count = int(attrs.get("instanceCount", 1) or 1)
    operating_system = attrs.get("operatingSystem", "Linux")
    tenancy = attrs.get("tenancy", "Shared")
    capacity_status = attrs.get("capacitystatus", "Used")
    pre_installed_sw = attrs.get("preInstalledSw", "NA")
    term_type = attrs.get("termType", "OnDemand")
    storage_gb = attrs.get("storageGB", 30)
    volume_type = attrs.get("volumeType", "gp3")

    ec2_filters = [
        {"Type": "TERM_MATCH", "Field": "instanceType", "Value": instance_type},
        {"Type": "TERM_MATCH", "Field": "operatingSystem", "Value": operating_system},
        {"Type": "TERM_MATCH", "Field": "tenancy", "Value": tenancy},
        {"Type": "TERM_MATCH", "Field": "capacitystatus", "Value": capacity_status},
        {"Type": "TERM_MATCH", "Field": "preInstalledSw", "Value": pre_installed_sw},
        {"Type": "TERM_MATCH", "Field": "termType", "Value": term_type},
        {"Type": "TERM_MATCH", "Field": "location", "Value": region},
    ]
    resp = {"PriceList": []}
    if client is not None:
        resp = client.get_products(ServiceCode="AmazonEC2", Filters=ec2_filters, MaxResults=1)
    fallback_pricing_used = False
    if not resp["PriceList"]:
        hourly = float(EC2_HOURLY_FALLBACK.get(str(instance_type).lower(), EC2_HOURLY_FALLBACK["t3.micro"]))
        fallback_pricing_used = True
    else:
        hourly = _extract_monthly_price(resp["PriceList"][0])
    monthly_compute = round(hourly * 730 * max(1, instance_count), 4)

    storage_filters = [
        {"Type": "TERM_MATCH", "Field": "serviceCode", "Value": "AmazonEC2"},
        {"Type": "TERM_MATCH", "Field": "productFamily", "Value": "Storage"},
        {"Type": "TERM_MATCH", "Field": "location", "Value": region},
        {"Type": "TERM_MATCH", "Field": "volumeApiName", "Value": volume_type},
    ]
    sresp = {"PriceList": []}
    if client is not None:
        sresp = client.get_products(ServiceCode="AmazonEC2", Filters=storage_filters, MaxResults=1)
    monthly_storage = 0.0
    if sresp["PriceList"]:
        price_per_gb = _extract_monthly_price(sresp["PriceList"][0])
        monthly_storage = round(price_per_gb * storage_gb * max(1, instance_count), 4)
    else:
        fallback_pricing_used = True
        fallback_gb_price = float(EBS_GB_MONTH_FALLBACK.get(str(volume_type).lower(), EBS_GB_MONTH_FALLBACK["gp3"]))
        monthly_storage = round(fallback_gb_price * storage_gb * max(1, instance_count), 4)

    return {
        "service": "AmazonEC2",
        "instance_count": max(1, instance_count),
        "ec2_instance_monthly_usd": monthly_compute,
        "ec2_storage_monthly_usd": monthly_storage,
        "ec2_total_monthly_usd": round(monthly_compute + monthly_storage, 4),
        "fallback_pricing_used": fallback_pricing_used,
    }


def _rds_estimate(client, node: dict) -> dict:
    if client is None:
        return {"error": "RDS live pricing unavailable without AWS pricing credentials"}
    attrs = node.get("attributes", {})
    region_friendly = node.get("region", "Asia Pacific (Mumbai)")
    aws_region = REGION_CODE_MAP.get(region_friendly, "ap-south-1")
    instance_type = attrs.get("instanceType", "db.t3.micro")
    db_engine = attrs.get("databaseEngine", "PostgreSQL").lower()
    term_type = attrs.get("termType", "OnDemand")
    storage_gb = attrs.get("storageGB", 20)

    filters = [
        {"Type": "TERM_MATCH", "Field": "instanceType", "Value": instance_type},
        {"Type": "TERM_MATCH", "Field": "databaseEngine", "Value": db_engine},
        {"Type": "TERM_MATCH", "Field": "deploymentOption", "Value": "Single-AZ"},
        {"Type": "TERM_MATCH", "Field": "regionCode", "Value": aws_region},
        {"Type": "TERM_MATCH", "Field": "termType", "Value": term_type},
        {"Type": "TERM_MATCH", "Field": "productFamily", "Value": "Database Instance"},
    ]
    resp = client.get_products(ServiceCode="AmazonRDS", Filters=filters, MaxResults=1)
    if not resp["PriceList"]:
        return {"error": "No RDS pricing found"}
    hourly = _extract_monthly_price(resp["PriceList"][0])
    monthly_instance = round(hourly * 730, 4)
    return {
        "service": "AmazonRDS",
        "rds_instance_monthly_usd": monthly_instance,
        "rds_total_monthly_usd": monthly_instance,
    }


def _s3_estimate(client, node: dict) -> dict:
    attrs = node.get("attributes", {})
    region_friendly = node.get("region", "Asia Pacific (Mumbai)")
    aws_region = REGION_CODE_MAP.get(region_friendly, "ap-south-1")
    storage_gb = attrs.get("storageGB", 100)
    storage_class_input = attrs.get("storageClass", "Standard")
    storage_class_map = {
        "Standard": "General Purpose",
        "General Purpose": "General Purpose",
        "IA": "Infrequent Access",
        "Infrequent Access": "Infrequent Access",
        "Glacier": "Archive",
        "Archive": "Archive",
    }
    storage_class = storage_class_map.get(storage_class_input, "General Purpose")
    usage_prefix = REGION_USAGE_TYPE_PREFIX.get(aws_region, "USE1")

    storage_filters = [
        {"Type": "TERM_MATCH", "Field": "productFamily", "Value": "Storage"},
        {"Type": "TERM_MATCH", "Field": "location", "Value": region_friendly},
        {"Type": "TERM_MATCH", "Field": "storageClass", "Value": storage_class},
        {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{usage_prefix}-TimedStorage-ByteHrs"},
    ]
    resp = {"PriceList": []}
    if client is not None:
        resp = client.get_products(ServiceCode="AmazonS3", Filters=storage_filters, MaxResults=1)
    monthly_storage = 0.0
    fallback_pricing_used = False
    if resp["PriceList"]:
        price_per_gb = _extract_monthly_price(resp["PriceList"][0])
        monthly_storage = round(storage_gb * price_per_gb, 4)
    else:
        fallback_pricing_used = True
        price_per_gb = float(S3_GB_MONTH_FALLBACK.get(storage_class, S3_GB_MONTH_FALLBACK["General Purpose"]))
        monthly_storage = round(storage_gb * price_per_gb, 4)

    return {
        "service": "AmazonS3",
        "s3_storage_monthly_usd": monthly_storage,
        "s3_total_monthly_usd": monthly_storage,
        "fallback_pricing_used": fallback_pricing_used,
    }


def _lambda_estimate(client, node: dict) -> dict:
    if client is None:
        return {"error": "Lambda live pricing unavailable without AWS pricing credentials"}
    attrs = node.get("attributes", {})
    region_friendly = node.get("region", "Asia Pacific (Mumbai)")
    aws_region = REGION_CODE_MAP.get(region_friendly, "ap-south-1")
    aws_region_prefix = REGION_USAGE_TYPE_PREFIX.get(aws_region, "USE1")
    requests_per_month = attrs.get("requestsPerMonth", 1_000_000)
    memory_mb = attrs.get("memorySizeMB", 128)
    duration_ms = attrs.get("durationMs", 100)

    compute_filters = [
        {"Type": "TERM_MATCH", "Field": "productFamily", "Value": "Serverless"},
        {"Type": "TERM_MATCH", "Field": "regionCode", "Value": aws_region},
        {"Type": "TERM_MATCH", "Field": "usagetype", "Value": f"{aws_region_prefix}-Lambda-GB-Second"},
    ]
    cresp = client.get_products(ServiceCode="AWSLambda", Filters=compute_filters, MaxResults=1)
    if not cresp["PriceList"]:
        return {"error": "No Lambda pricing found"}
    price_per_gb_sec = _extract_monthly_price(cresp["PriceList"][0])
    total_gb_sec = (duration_ms / 1000) * (memory_mb / 1024) * requests_per_month
    compute_cost = round(price_per_gb_sec * total_gb_sec, 4)
    billable_requests = max(0, requests_per_month - 1_000_000)
    return {
        "service": "AWSLambda",
        "lambda_compute_monthly_usd": compute_cost,
        "lambda_total_monthly_usd": compute_cost,
        "billable_requests": billable_requests,
    }


# Node-type → estimator dispatch
_ESTIMATORS = {
    "AmazonEC2": _ec2_estimate,
    "AmazonRDS": _rds_estimate,
    "AmazonS3": _s3_estimate,
    "AWSLambda": _lambda_estimate,
}


def estimate_cost(architecture_json: dict, access_key: str = "", secret_key: str = "") -> dict:
    """
    Estimate monthly AWS costs from an architecture JSON.
    Returns {"success": bool, "breakdown": [...], "total_monthly_usd": float, "currency": "USD"}.
    Falls back to {"success": False, "error": ...} on failure.
    """
    _access_key = access_key or os.getenv("AWS_ACCESS_KEY_ID", "")
    _secret_key = secret_key or os.getenv("AWS_SECRET_ACCESS_KEY", "")
    used_fallback_only = False
    if not _access_key or not _secret_key:
        client = None
        used_fallback_only = True
    else:
        try:
            client = _create_pricing_client(_access_key, _secret_key)
        except Exception as exc:
            return {"success": False, "error": f"Failed to create boto3 client: {exc}"}

    nodes = architecture_json.get("nodes", [])
    breakdown = []
    total = 0.0
    errors = []

    for node in nodes:
        ntype = node.get("type", "")
        estimator = _ESTIMATORS.get(ntype)
        if not estimator:
            continue
        try:
            result = estimator(client, node)
            if "error" in result:
                errors.append(f"{ntype} ({node.get('id', '?')}): {result['error']}")
                continue
            # Sum up any *_total_monthly_usd key
            node_total = next(
                (v for k, v in result.items() if k.endswith("_total_monthly_usd")), 0.0
            )
            total += node_total
            breakdown.append({
                "node_id": node.get("id", ntype),
                "service": ntype,
                "monthly_usd": round(node_total, 4),
                "detail": result,
            })
        except Exception as exc:
            logger.warning("AWS cost estimate failed for %s: %s", ntype, exc)
            errors.append(f"{ntype}: {exc}")

    return {
        "success": True,
        "provider": "aws",
        "total_monthly_usd": round(total, 2),
        "currency": "USD",
        "breakdown": breakdown,
        "errors": errors,
        "note": (
            "AWS pricing credentials were not provided; using fallback heuristic rates for supported services."
            if used_fallback_only else None
        ),
    }
