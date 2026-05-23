import os
from datetime import datetime, timezone
from pathlib import Path

# Maps service type -> the output keys we expect from terraform output -json
# Must stay in sync with outputs.tf in each template directory
SERVICE_OUTPUT_KEYS: dict[str, list[str]] = {
    "ec2": ["public_ip", "instance_id", "keypair_name", "availability_zone", "arn"],
    "s3": ["bucket_id", "bucket_arn", "bucket_domain_name", "region"],
    "rds": ["endpoint", "port", "db_instance_id", "db_instance_arn"],
    "ecs": ["cluster_arn", "service_name", "task_definition_arn"],
    "lambda": ["lambda_function_arn", "lambda_function_name", "lambda_function_url"],
    "elasticache": ["primary_endpoint_address", "port", "cluster_id"],
    "alb": ["lb_dns_name", "lb_arn", "target_group_arn"],
    "vpc": ["vpc_id", "public_subnets", "private_subnets"],
}

# Human-readable display labels for the UI card
OUTPUT_LABELS: dict[str, str] = {
    "public_ip": "Public IP",
    "instance_id": "Instance ID",
    "keypair_name": "Key Pair Name",
    "availability_zone": "Availability Zone",
    "arn": "ARN",
    "bucket_id": "Bucket Name",
    "bucket_arn": "Bucket ARN",
    "bucket_domain_name": "Bucket Domain",
    "region": "Region",
    "endpoint": "Endpoint",
    "port": "Port",
    "db_instance_id": "DB Instance ID",
    "db_instance_arn": "DB ARN",
    "cluster_arn": "Cluster ARN",
    "service_name": "Service Name",
    "task_definition_arn": "Task Definition ARN",
    "lambda_function_arn": "Function ARN",
    "lambda_function_name": "Function Name",
    "lambda_function_url": "Function URL",
    "primary_endpoint_address": "Primary Endpoint",
    "cluster_id": "Cluster ID",
    "lb_dns_name": "Load Balancer DNS",
    "lb_arn": "Load Balancer ARN",
    "target_group_arn": "Target Group ARN",
    "vpc_id": "VPC ID",
    "public_subnets": "Public Subnets",
    "private_subnets": "Private Subnets",
}


def parse_outputs(raw_tf_outputs: dict, service_type: str) -> dict:
    """
    Converts raw terraform output dict into a normalized UI-ready dict.

    raw_tf_outputs is the flat dict from executor.get_outputs():
      { "public_ip": "54.x.x.x", "instance_id": "i-0abc...", ... }

    Returns:
    {
        "service_type": "ec2",
        "managed_by": "deplai",
        "deployed_at": "2026-05-19T10:30:00Z",
        "outputs": [
            { "key": "public_ip", "label": "Public IP", "value": "54.x.x.x" },
            ...
        ],
        "raw": { ... }   # full raw dict for any custom use
    }
    """
    expected_keys = SERVICE_OUTPUT_KEYS.get(service_type, list(raw_tf_outputs.keys()))

    output_entries = []
    for key in expected_keys:
        if key in raw_tf_outputs:
            output_entries.append(
                {
                    "key": key,
                    "label": OUTPUT_LABELS.get(key, key.replace("_", " ").title()),
                    "value": raw_tf_outputs[key],
                }
            )

    return {
        "service_type": service_type,
        "managed_by": "deplai",
        "deployed_at": datetime.now(timezone.utc).isoformat(),
        "outputs": output_entries,
        "raw": raw_tf_outputs,
    }


def extract_keypair_details(workspace_path: str | Path) -> dict | None:
    """
    For EC2 deployments only.
    Reads the .pem private key file that Terraform writes to the workspace.
    Returns { "private_key_pem": "...", "keypair_name": "..." } or None if not found.

    IMPORTANT: After calling this function, the caller MUST delete the .pem file.
    The private key is returned to the UI exactly once and must not persist on disk.
    """
    workspace = Path(workspace_path)

    pem_files = list(workspace.glob("*.pem"))
    if not pem_files:
        return None

    pem_file = pem_files[0]
    keypair_name = pem_file.stem

    with open(pem_file, "r") as f:
        private_key_pem = f.read()

    # Scrub the key from disk immediately after reading
    os.remove(pem_file)

    return {
        "private_key_pem": private_key_pem,
        "keypair_name": keypair_name,
    }


def format_apply_log_line(raw_json_line: str) -> str | None:
    """
    Converts a single terraform apply -json log line into a human-readable string
    suitable for display in the ApplyLogViewer UI component.

    Returns None for lines that should be suppressed (heartbeat noise, etc.).
    """
    import json as _json

    try:
        event = _json.loads(raw_json_line)
    except _json.JSONDecodeError:
        return raw_json_line

    level = event.get("@level", "")
    message = event.get("@message", "")
    etype = event.get("type", "")

    # Suppress noisy / low-signal events
    if etype in ("version", "log") and level == "info" and not message:
        return None
    if message in ("", "Terraform 1.9.5"):
        return None

    # Highlight key milestones
    if etype == "apply_complete":
        resource = event.get("hook", {}).get("resource", {}).get("addr", "")
        return f"✓ {resource} created"

    if etype == "apply_start":
        resource = event.get("hook", {}).get("resource", {}).get("addr", "")
        return f"→ Creating {resource}..."

    if level == "error":
        return f"✗ ERROR: {message}"

    return message if message else None
