from __future__ import annotations

import json
from typing import Optional


AWS_REGION_LABELS: dict[str, str] = {
    "ap-south-1": "Asia Pacific (Mumbai)",
    "ap-south-2": "Asia Pacific (Hyderabad)",
    "ap-southeast-1": "Asia Pacific (Singapore)",
    "ap-southeast-2": "Asia Pacific (Sydney)",
    "ap-northeast-1": "Asia Pacific (Tokyo)",
    "eu-north-1": "Europe (Stockholm)",
    "eu-west-1": "Europe (Ireland)",
    "eu-west-2": "Europe (London)",
    "eu-central-1": "Europe (Frankfurt)",
    "us-east-1": "US East (N. Virginia)",
    "us-east-2": "US East (Ohio)",
    "us-west-2": "US West (Oregon)",
}


PRICING_TABLE: dict = {
    "ec2": {
        "t3.micro": {"ap-south-1": 8.91, "us-east-1": 7.59},
        "t3.small": {"ap-south-1": 17.81, "us-east-1": 15.18},
        "t3.medium": {"ap-south-1": 35.62, "us-east-1": 30.37},
        "t3.large": {"ap-south-1": 71.25, "us-east-1": 60.74},
    },
    "rds_postgres": {
        "db.t3.micro": {"ap-south-1": 28.08, "us-east-1": 25.55},
        "db.t3.small": {"ap-south-1": 56.16, "us-east-1": 51.10},
        "db.t3.medium": {"ap-south-1": 112.32, "us-east-1": 102.20},
        "db.r6g.large": {"ap-south-1": 215.00, "us-east-1": 196.00},
    },
    "elasticache_redis": {
        "cache.t3.micro": {"ap-south-1": 13.14, "us-east-1": 11.52},
        "cache.t3.small": {"ap-south-1": 17.35, "us-east-1": 15.20},
        "cache.t3.medium": {"ap-south-1": 34.70, "us-east-1": 30.40},
        "cache.r6g.large": {"ap-south-1": 138.00, "us-east-1": 121.00},
    },
    "ecs_fargate": {
        "0.25vcpu_0.5gb": {"ap-south-1": 8.10, "us-east-1": 7.30},
        "0.5vcpu_1gb": {"ap-south-1": 16.20, "us-east-1": 14.60},
        "web": {"ap-south-1": 23.00, "us-east-1": 23.00},
        "worker": {"ap-south-1": 15.50, "us-east-1": 15.50},
    },
    "s3": {
        "per_gb_month": {"ap-south-1": 0.023, "us-east-1": 0.023},
        "assumed_gb": 5,
    },
    "cloudfront": {
        "free_tier_gb": 1024,
        "per_gb_after": 0.0085,
    },
    "cloudwatch": {
        "log_ingestion_per_gb": 0.50,
        "assumed_gb_month": 1,
    },
    "vpc": {"monthly_usd": 0.00},
    "subnet": {"monthly_usd": 0.00},
    "security_group": {"monthly_usd": 0.00},
    "alb": {"ap-south-1": 20.10, "us-east-1": 18.40},
    "nat_gateway": {"ap-south-1": 39.50, "us-east-1": 32.85},
    "ecr": {"ap-south-1": 1.20, "us-east-1": 0.90},
    "task_definition": {"monthly_usd": 0.00},
    "igw": {"monthly_usd": 0.00},
}


EC2_HOURLY_RATE: dict[str, dict[str, float]] = {
    "t3.micro": {"ap-south-1": 0.0116, "us-east-1": 0.0104},
    "t3.small": {"ap-south-1": 0.0232, "us-east-1": 0.0208},
    "t3.medium": {"ap-south-1": 0.0464, "us-east-1": 0.0416},
    "t3.large": {"ap-south-1": 0.0928, "us-east-1": 0.0832},
}


def _pricing_client():
    try:
        import boto3

        session = boto3.session.Session(region_name="us-east-1")
        creds = session.get_credentials()
        if creds is None:
            return None
        return session.client("pricing", region_name="us-east-1")
    except Exception:
        return None


def _extract_monthly_price(price_list_item: str) -> float:
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


def _aws_location(region: str) -> str:
    return AWS_REGION_LABELS.get(str(region or "").strip(), "US East (N. Virginia)")


def _estimate_ec2_live(client, region: str, instance_type: str) -> Optional[tuple[float, str]]:
    if client is None:
        return None
    filters = [
        {"Type": "TERM_MATCH", "Field": "instanceType", "Value": instance_type},
        {"Type": "TERM_MATCH", "Field": "operatingSystem", "Value": "Linux"},
        {"Type": "TERM_MATCH", "Field": "tenancy", "Value": "Shared"},
        {"Type": "TERM_MATCH", "Field": "capacitystatus", "Value": "Used"},
        {"Type": "TERM_MATCH", "Field": "preInstalledSw", "Value": "NA"},
        {"Type": "TERM_MATCH", "Field": "termType", "Value": "OnDemand"},
        {"Type": "TERM_MATCH", "Field": "location", "Value": _aws_location(region)},
    ]
    try:
        resp = client.get_products(ServiceCode="AmazonEC2", Filters=filters, MaxResults=1)
    except Exception:
        return None
    if not resp.get("PriceList"):
        return None
    hourly = _extract_monthly_price(resp["PriceList"][0])
    return round_money(hourly * 730), f"{instance_type} on-demand {region} ~${hourly:.4f}/hr x 730h"


def _estimate_rds_live(client, region: str) -> Optional[tuple[float, str]]:
    if client is None:
        return None
    filters = [
        {"Type": "TERM_MATCH", "Field": "instanceType", "Value": "db.t3.micro"},
        {"Type": "TERM_MATCH", "Field": "databaseEngine", "Value": "postgresql"},
        {"Type": "TERM_MATCH", "Field": "deploymentOption", "Value": "Single-AZ"},
        {"Type": "TERM_MATCH", "Field": "location", "Value": _aws_location(region)},
        {"Type": "TERM_MATCH", "Field": "termType", "Value": "OnDemand"},
        {"Type": "TERM_MATCH", "Field": "productFamily", "Value": "Database Instance"},
    ]
    try:
        resp = client.get_products(ServiceCode="AmazonRDS", Filters=filters, MaxResults=1)
    except Exception:
        return None
    if not resp.get("PriceList"):
        return None
    hourly = _extract_monthly_price(resp["PriceList"][0])
    return round_money(hourly * 730), "db.t3.micro live AWS Pricing API estimate"


def _estimate_s3_live(client, region: str) -> Optional[tuple[float, str]]:
    if client is None:
        return None
    filters = [
        {"Type": "TERM_MATCH", "Field": "productFamily", "Value": "Storage"},
        {"Type": "TERM_MATCH", "Field": "location", "Value": _aws_location(region)},
        {"Type": "TERM_MATCH", "Field": "storageClass", "Value": "General Purpose"},
    ]
    try:
        resp = client.get_products(ServiceCode="AmazonS3", Filters=filters, MaxResults=1)
    except Exception:
        return None
    if not resp.get("PriceList"):
        return None
    price_per_gb = _extract_monthly_price(resp["PriceList"][0])
    assumed_gb = float(PRICING_TABLE["s3"]["assumed_gb"])
    return round_money(price_per_gb * assumed_gb), "~5GB storage estimated via AWS Pricing API"


def round_money(value: float) -> float:
    return round(float(value), 2)


def _region_value(values: dict, region: str) -> Optional[float]:
    if region in values:
        return float(values[region])
    if "us-east-1" in values:
        return float(values["us-east-1"])
    return None


def estimate_cost(resource_type: str, region: str, tier: str = "default") -> Optional[tuple[float, str, str, str]]:
    rtype = str(resource_type or "").strip().lower()
    aws_region = str(region or "ap-south-1").strip() or "ap-south-1"
    client = _pricing_client()

    if rtype == "ec2":
        instance_type = "t3.micro" if tier == "default" else tier
        live = _estimate_ec2_live(client, aws_region, instance_type)
        if live is not None:
            monthly, notes = live
            return monthly, "AmazonEC2", "AWS Pricing API", notes
        monthly = _region_value(PRICING_TABLE["ec2"].get(instance_type, {}), aws_region)
        if monthly is None:
            return None
        hourly = _region_value(EC2_HOURLY_RATE.get(instance_type, {}), aws_region)
        hourly_text = f"${hourly:.4f}/hr" if hourly is not None else "hourly rate unavailable"
        notes = f"{instance_type} on-demand {aws_region} ~{hourly_text} x 730h"
        return round_money(monthly), "AmazonEC2", "General", notes

    if rtype == "s3":
        live = _estimate_s3_live(client, aws_region)
        if live is not None:
            monthly, notes = live
            return monthly, "AmazonS3", "AWS Pricing API", notes
        per_gb = _region_value(PRICING_TABLE["s3"]["per_gb_month"], aws_region)
        if per_gb is None:
            return None
        assumed_gb = float(PRICING_TABLE["s3"]["assumed_gb"])
        monthly = per_gb * assumed_gb
        notes = "~5GB storage + GET requests"
        return round_money(monthly), "AmazonS3", "General", notes

    if rtype == "rds":
        instance_type = tier if tier in PRICING_TABLE["rds_postgres"] else "db.t3.small"
        live = _estimate_rds_live(client, aws_region) if instance_type == "db.t3.micro" else None
        if live is not None:
            monthly, notes = live
            return monthly, "AmazonRDS", "AWS Pricing API", notes
        monthly = _region_value(PRICING_TABLE["rds_postgres"].get(instance_type, {}), aws_region)
        if monthly is None:
            return None
        notes = f"{instance_type} on-demand baseline"
        return round_money(monthly), "AmazonRDS", "PostgreSQL", notes

    if rtype == "elasticache":
        node_type = tier if tier in PRICING_TABLE["elasticache_redis"] else "cache.t3.small"
        monthly = _region_value(PRICING_TABLE["elasticache_redis"][node_type], aws_region)
        if monthly is None:
            return None
        notes = f"{node_type} node baseline"
        return round_money(monthly), "AmazonElastiCache", "Redis", notes

    if rtype == "ecs":
        monthly = _region_value(PRICING_TABLE["ecs_fargate"]["0.25vcpu_0.5gb"], aws_region)
        if monthly is None:
            return None
        notes = "Fargate task 0.25 vCPU / 0.5GB baseline"
        return round_money(monthly), "AmazonECS", "Fargate", notes

    if rtype == "service":
        service_tier = tier if tier in PRICING_TABLE["ecs_fargate"] else "web"
        monthly = _region_value(PRICING_TABLE["ecs_fargate"][service_tier], aws_region)
        if monthly is None:
            return None
        notes = f"Fargate {service_tier} service baseline"
        return round_money(monthly), "AWSFargate", "FargateService", notes

    if rtype == "alb":
        monthly = _region_value(PRICING_TABLE["alb"], aws_region)
        if monthly is None:
            return None
        return round_money(monthly), "ElasticLoadBalancing", "ApplicationLoadBalancer", "Baseline ALB hourly + light LCU usage"

    if rtype == "nat_gateway":
        monthly = _region_value(PRICING_TABLE["nat_gateway"], aws_region)
        if monthly is None:
            return None
        return round_money(monthly), "AmazonVPC", "NATGateway", "Single NAT gateway baseline with light egress"

    if rtype == "ecr":
        monthly = _region_value(PRICING_TABLE["ecr"], aws_region)
        if monthly is None:
            return None
        return round_money(monthly), "AmazonECR", "ContainerRegistry", "Small private repository storage baseline"

    if rtype == "cloudfront":
        return 0.00, "AmazonCloudFront", "General", "Within free tier (first 1TB/month)"

    if rtype == "cloudwatch":
        return 0.00, "AmazonCloudWatch", "General", "Basic metrics/logs assumed within free tier"

    if rtype in {"vpc", "subnet", "security_group", "task_definition", "igw"}:
        return 0.00, "AmazonVPC", "General", "No direct hourly charge"

    if rtype == "lambda":
        return 0.00, "AWSLambda", "General", "Assumed within free tier for low usage"

    return None

