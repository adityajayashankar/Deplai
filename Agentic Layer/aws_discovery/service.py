from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable

import boto3

from deployment_planning_contract import AwsDiscoveryContext, AwsResourceMetadata, AwsReuseRecommendation


def _name(tags: list[dict[str, Any]] | None, fallback: str | None = None) -> str | None:
    for tag in tags or []:
        if str(tag.get("Key") or tag.get("key") or "") == "Name":
            return str(tag.get("Value") or tag.get("value") or "") or fallback
    return fallback


def discover_aws_environment(
    *,
    aws_access_key_id: str,
    aws_secret_access_key: str,
    aws_session_token: str | None,
    region: str,
    session_factory: Callable[..., Any] = boto3.Session,
) -> AwsDiscoveryContext:
    """Read AWS metadata only. Secret values and raw credentials never leave this call."""

    kwargs: dict[str, Any] = {
        "aws_access_key_id": aws_access_key_id,
        "aws_secret_access_key": aws_secret_access_key,
        "region_name": region,
    }
    if aws_session_token:
        kwargs["aws_session_token"] = aws_session_token
    session = session_factory(**kwargs)
    resources: list[AwsResourceMetadata] = []
    gaps: list[str] = []

    def attempt(label: str, operation: Callable[[], None]) -> None:
        try:
            operation()
        except Exception as exc:  # permission gaps are expected for least-privilege discovery roles
            code = getattr(exc, "response", {}).get("Error", {}).get("Code") if hasattr(exc, "response") else None
            gaps.append(f"{label}:{code or type(exc).__name__}")

    account_id: str | None = None

    def identity() -> None:
        nonlocal account_id
        account_id = str(session.client("sts").get_caller_identity().get("Account") or "") or None

    attempt("sts:GetCallerIdentity", identity)

    ec2 = session.client("ec2", region_name=region)

    def networks() -> None:
        for item in ec2.describe_vpcs().get("Vpcs", []):
            rid = str(item.get("VpcId") or "")
            resources.append(AwsResourceMetadata(resource_type="vpc", resource_id=rid, name=_name(item.get("Tags"), rid), region=region, state=str(item.get("State") or ""), metadata={"cidr": item.get("CidrBlock"), "default": bool(item.get("IsDefault"))}))
        for item in ec2.describe_subnets().get("Subnets", []):
            rid = str(item.get("SubnetId") or "")
            resources.append(AwsResourceMetadata(resource_type="subnet", resource_id=rid, name=_name(item.get("Tags"), rid), region=region, state=str(item.get("State") or ""), metadata={"vpc_id": item.get("VpcId"), "availability_zone": item.get("AvailabilityZone"), "public_ip_on_launch": bool(item.get("MapPublicIpOnLaunch"))}))
        for item in ec2.describe_nat_gateways().get("NatGateways", []):
            rid = str(item.get("NatGatewayId") or "")
            resources.append(AwsResourceMetadata(resource_type="nat_gateway", resource_id=rid, name=_name(item.get("Tags"), rid), region=region, state=str(item.get("State") or ""), metadata={"vpc_id": item.get("VpcId"), "subnet_id": item.get("SubnetId")}))
        for item in ec2.describe_security_groups().get("SecurityGroups", []):
            rid = str(item.get("GroupId") or "")
            resources.append(AwsResourceMetadata(resource_type="security_group", resource_id=rid, name=str(item.get("GroupName") or rid), region=region, metadata={"vpc_id": item.get("VpcId")}))

    attempt("ec2:DescribeNetworkMetadata", networks)

    def instances() -> None:
        for reservation in ec2.describe_instances().get("Reservations", []):
            for item in reservation.get("Instances", []):
                rid = str(item.get("InstanceId") or "")
                resources.append(AwsResourceMetadata(resource_type="ec2_instance", resource_id=rid, name=_name(item.get("Tags"), rid), region=region, state=str((item.get("State") or {}).get("Name") or ""), metadata={"instance_type": item.get("InstanceType"), "vpc_id": item.get("VpcId"), "subnet_id": item.get("SubnetId")}))

    attempt("ec2:DescribeInstances", instances)

    def rds() -> None:
        for item in session.client("rds", region_name=region).describe_db_instances().get("DBInstances", []):
            rid = str(item.get("DBInstanceIdentifier") or "")
            resources.append(AwsResourceMetadata(resource_type="rds", resource_id=rid, name=rid, arn=item.get("DBInstanceArn"), region=region, state=item.get("DBInstanceStatus"), metadata={"engine": item.get("Engine"), "engine_version": item.get("EngineVersion"), "multi_az": bool(item.get("MultiAZ")), "public": bool(item.get("PubliclyAccessible")), "vpc_id": ((item.get("DBSubnetGroup") or {}).get("VpcId"))}))

    attempt("rds:DescribeDBInstances", rds)

    def ecs() -> None:
        client = session.client("ecs", region_name=region)
        arns = client.list_clusters().get("clusterArns", [])
        for item in client.describe_clusters(clusters=arns).get("clusters", []) if arns else []:
            arn = str(item.get("clusterArn") or "")
            resources.append(AwsResourceMetadata(resource_type="ecs_cluster", resource_id=str(item.get("clusterName") or arn), name=item.get("clusterName"), arn=arn, region=region, state=item.get("status"), metadata={"running_tasks": item.get("runningTasksCount")}))

    attempt("ecs:ListClusters", ecs)

    def ecr() -> None:
        for item in session.client("ecr", region_name=region).describe_repositories().get("repositories", []):
            rid = str(item.get("repositoryName") or "")
            resources.append(AwsResourceMetadata(resource_type="ecr_repository", resource_id=rid, name=rid, arn=item.get("repositoryArn"), region=region, metadata={"mutable_tags": item.get("imageTagMutability") == "MUTABLE", "scan_on_push": bool((item.get("imageScanningConfiguration") or {}).get("scanOnPush"))}))

    attempt("ecr:DescribeRepositories", ecr)

    def s3() -> None:
        for item in session.client("s3").list_buckets().get("Buckets", []):
            rid = str(item.get("Name") or "")
            resources.append(AwsResourceMetadata(resource_type="s3_bucket", resource_id=rid, name=rid, region=None, metadata={"created_at": str(item.get("CreationDate") or "")}))

    attempt("s3:ListBuckets", s3)

    def route53() -> None:
        for item in session.client("route53").list_hosted_zones().get("HostedZones", []):
            rid = str(item.get("Id") or "").split("/")[-1]
            resources.append(AwsResourceMetadata(resource_type="route53_zone", resource_id=rid, name=str(item.get("Name") or "").rstrip("."), metadata={"private": bool((item.get("Config") or {}).get("PrivateZone"))}))

    attempt("route53:ListHostedZones", route53)

    def certificates() -> None:
        client = session.client("acm", region_name=region)
        for summary in client.list_certificates().get("CertificateSummaryList", []):
            arn = str(summary.get("CertificateArn") or "")
            resources.append(AwsResourceMetadata(resource_type="acm_certificate", resource_id=arn.rsplit("/", 1)[-1], name=summary.get("DomainName"), arn=arn, region=region, state=summary.get("Status")))

    attempt("acm:ListCertificates", certificates)

    def secrets_metadata() -> None:
        for item in session.client("secretsmanager", region_name=region).list_secrets().get("SecretList", []):
            arn = str(item.get("ARN") or "")
            resources.append(AwsResourceMetadata(resource_type="secret_metadata", resource_id=arn or str(item.get("Name") or ""), name=item.get("Name"), arn=arn or None, region=region, metadata={"rotation_enabled": bool(item.get("RotationEnabled"))}))

    attempt("secretsmanager:ListSecrets", secrets_metadata)

    recommendations: list[AwsReuseRecommendation] = []
    for item in resources:
        if item.resource_type in {"vpc", "route53_zone", "acm_certificate", "rds", "ecr_repository", "s3_bucket"}:
            recommendations.append(AwsReuseRecommendation(
                resource_type=item.resource_type, resource_id=item.resource_id,
                recommendation="evaluate_reuse", authority="recommend_confirm",
                reason="The resource already exists, but reuse needs explicit confirmation and compatibility/blast-radius checks.",
            ))

    status = "complete" if not gaps else ("partial" if resources or account_id else "unavailable")
    return AwsDiscoveryContext(
        status=status, account_id=account_id, region=region, resources=resources,
        reuse_recommendations=recommendations, permission_gaps=gaps,
        discovered_at=datetime.now(timezone.utc).isoformat(),
    )
