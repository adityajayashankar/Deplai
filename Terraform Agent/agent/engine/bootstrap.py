from __future__ import annotations

from pathlib import Path
from typing import Any

import boto3
from botocore.exceptions import ClientError

from .execution import run_terraform_command
from .runtime import AWS_PROVIDER_SOURCE, DEFAULT_PROVIDER_CONSTRAINT, ensure_dir, extract_provider_version


def _create_bucket(s3_client: Any, bucket: str, region: str) -> None:
    if region == "us-east-1":
        s3_client.create_bucket(Bucket=bucket)
    else:
        s3_client.create_bucket(
            Bucket=bucket,
            CreateBucketConfiguration={"LocationConstraint": region},
        )


def _ensure_bucket(s3_client: Any, bucket: str, region: str) -> None:
    try:
        s3_client.head_bucket(Bucket=bucket)
    except ClientError:
        _create_bucket(s3_client, bucket, region)

    s3_client.put_bucket_versioning(
        Bucket=bucket,
        VersioningConfiguration={"Status": "Enabled"},
    )
    s3_client.put_bucket_encryption(
        Bucket=bucket,
        ServerSideEncryptionConfiguration={
            "Rules": [
                {
                    "ApplyServerSideEncryptionByDefault": {
                        "SSEAlgorithm": "AES256",
                    }
                }
            ]
        },
    )


def _ensure_lock_table(dynamo_client: Any, table_name: str) -> None:
    try:
        dynamo_client.describe_table(TableName=table_name)
        return
    except dynamo_client.exceptions.ResourceNotFoundException:
        pass

    dynamo_client.create_table(
        TableName=table_name,
        AttributeDefinitions=[{"AttributeName": "LockID", "AttributeType": "S"}],
        KeySchema=[{"AttributeName": "LockID", "KeyType": "HASH"}],
        BillingMode="PAY_PER_REQUEST",
    )
    waiter = dynamo_client.get_waiter("table_exists")
    waiter.wait(TableName=table_name)


def bootstrap_environment(
    *,
    bootstrap_dir: Path,
    state_bucket: str,
    lock_table: str,
    workspace: str,
    aws_region: str,
    aws_access_key_id: str,
    aws_secret_access_key: str,
    aws_session_token: str = "",
    apply_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    session_kwargs: dict[str, str] = {"region_name": aws_region}
    if aws_access_key_id and aws_secret_access_key:
        session_kwargs["aws_access_key_id"] = aws_access_key_id
        session_kwargs["aws_secret_access_key"] = aws_secret_access_key
    if aws_session_token:
        session_kwargs["aws_session_token"] = aws_session_token
    session = boto3.session.Session(**session_kwargs)
    sts = session.client("sts", region_name=aws_region)
    identity = sts.get_caller_identity()
    if not identity.get("Account") or not identity.get("UserId") or not identity.get("Arn"):
        raise RuntimeError("sts get-caller-identity response missing Account, UserId, or Arn")

    s3 = session.client("s3", region_name=aws_region)
    dynamodb = session.client("dynamodb", region_name=aws_region)
    _ensure_bucket(s3, state_bucket, aws_region)
    _ensure_lock_table(dynamodb, lock_table)

    ensure_dir(bootstrap_dir)
    (bootstrap_dir / "providers.tf").write_text(
        f"""terraform {{
  required_providers {{
    aws = {{
      source  = "hashicorp/aws"
      version = "{DEFAULT_PROVIDER_CONSTRAINT}"
    }}
  }}
}}

provider "aws" {{
  region = "{aws_region}"
}}
""",
        encoding="utf-8",
    )
    (bootstrap_dir / "backend.tf").write_text(
        f"""terraform {{
  backend "s3" {{
    bucket         = "{state_bucket}"
    key            = "{workspace}/terraform.tfstate"
    region         = "{aws_region}"
    dynamodb_table = "{lock_table}"
    encrypt        = true
  }}
}}
""",
        encoding="utf-8",
    )

    env = {
        "AWS_ACCESS_KEY_ID": aws_access_key_id,
        "AWS_SECRET_ACCESS_KEY": aws_secret_access_key,
        "AWS_DEFAULT_REGION": aws_region,
        "TF_IN_AUTOMATION": "1",
    }
    init_result = run_terraform_command(
        bootstrap_dir,
        ["init", "-input=false", "-no-color"],
        env=env,
        apply_context=apply_context,
    )
    lock_text = (bootstrap_dir / ".terraform.lock.hcl").read_text(encoding="utf-8")
    provider_version = extract_provider_version(lock_text, AWS_PROVIDER_SOURCE)
    return {
        "caller_identity": identity,
        "provider_version": provider_version,
        "init_log": init_result["stdout"],
    }
