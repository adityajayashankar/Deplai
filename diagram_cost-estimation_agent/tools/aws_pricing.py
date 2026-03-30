from __future__ import annotations

from typing import Optional


PRICING_TABLE: dict = {
    "ec2": {
        "t3.micro": {"ap-south-1": 8.91, "us-east-1": 7.59},
        "t3.small": {"ap-south-1": 17.81, "us-east-1": 15.18},
        "t3.medium": {"ap-south-1": 35.62, "us-east-1": 30.37},
        "t3.large": {"ap-south-1": 71.25, "us-east-1": 60.74},
    },
    "rds_postgres": {
        "db.t3.micro": {"ap-south-1": 28.08, "us-east-1": 25.55},
        "db.t3.medium": {"ap-south-1": 112.32, "us-east-1": 102.20},
    },
    "elasticache_redis": {
        "cache.t3.micro": {"ap-south-1": 13.14, "us-east-1": 11.52},
    },
    "ecs_fargate": {
        "0.25vcpu_0.5gb": {"ap-south-1": 8.10, "us-east-1": 7.30},
        "0.5vcpu_1gb": {"ap-south-1": 16.20, "us-east-1": 14.60},
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
}


EC2_HOURLY_RATE: dict[str, dict[str, float]] = {
    "t3.micro": {"ap-south-1": 0.0116, "us-east-1": 0.0104},
    "t3.small": {"ap-south-1": 0.0232, "us-east-1": 0.0208},
    "t3.medium": {"ap-south-1": 0.0464, "us-east-1": 0.0416},
    "t3.large": {"ap-south-1": 0.0928, "us-east-1": 0.0832},
}


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

    if rtype == "ec2":
        instance_type = "t3.micro" if tier == "default" else tier
        monthly = _region_value(PRICING_TABLE["ec2"].get(instance_type, {}), aws_region)
        if monthly is None:
            return None
        hourly = _region_value(EC2_HOURLY_RATE.get(instance_type, {}), aws_region)
        hourly_text = f"${hourly:.4f}/hr" if hourly is not None else "hourly rate unavailable"
        notes = f"{instance_type} on-demand {aws_region} ~{hourly_text} x 730h"
        return round_money(monthly), "AmazonEC2", "General", notes

    if rtype == "s3":
        per_gb = _region_value(PRICING_TABLE["s3"]["per_gb_month"], aws_region)
        if per_gb is None:
            return None
        assumed_gb = float(PRICING_TABLE["s3"]["assumed_gb"])
        monthly = per_gb * assumed_gb
        notes = "~5GB storage + GET requests"
        return round_money(monthly), "AmazonS3", "General", notes

    if rtype == "rds":
        monthly = _region_value(PRICING_TABLE["rds_postgres"]["db.t3.micro"], aws_region)
        if monthly is None:
            return None
        notes = "db.t3.micro on-demand baseline"
        return round_money(monthly), "AmazonRDS", "PostgreSQL", notes

    if rtype == "elasticache":
        monthly = _region_value(PRICING_TABLE["elasticache_redis"]["cache.t3.micro"], aws_region)
        if monthly is None:
            return None
        notes = "cache.t3.micro node baseline"
        return round_money(monthly), "AmazonElastiCache", "Redis", notes

    if rtype == "ecs":
        monthly = _region_value(PRICING_TABLE["ecs_fargate"]["0.25vcpu_0.5gb"], aws_region)
        if monthly is None:
            return None
        notes = "Fargate task 0.25 vCPU / 0.5GB baseline"
        return round_money(monthly), "AmazonECS", "Fargate", notes

    if rtype == "cloudfront":
        return 0.00, "AmazonCloudFront", "General", "Within free tier (first 1TB/month)"

    if rtype == "cloudwatch":
        return 0.00, "AmazonCloudWatch", "General", "Basic metrics/logs assumed within free tier"

    if rtype in {"vpc", "subnet", "security_group"}:
        return 0.00, "AmazonVPC", "General", "No direct hourly charge"

    if rtype == "lambda":
        return 0.00, "AWSLambda", "General", "Assumed within free tier for low usage"

    return None

