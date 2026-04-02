from __future__ import annotations

import time
from typing import Any

from .storage import boto3_session_from_env


LEASE_SECONDS = 3600


def acquire_workspace_lock(*, env: dict[str, str], lock_table: str, workspace: str, run_id: str) -> None:
    session = boto3_session_from_env(env)
    dynamodb = session.client("dynamodb", region_name=str(env.get("AWS_DEFAULT_REGION") or ""))
    now = int(time.time())
    lease_until = now + LEASE_SECONDS
    lock_id = f"deplai-run::{workspace}"
    try:
        dynamodb.put_item(
            TableName=lock_table,
            Item={
                "LockID": {"S": lock_id},
                "RunID": {"S": run_id},
                "LeaseUntil": {"N": str(lease_until)},
            },
            ConditionExpression="attribute_not_exists(LockID) OR LeaseUntil < :now OR RunID = :run_id",
            ExpressionAttributeValues={
                ":now": {"N": str(now)},
                ":run_id": {"S": run_id},
            },
        )
    except Exception as exc:
        raise RuntimeError(f"Workspace {workspace} is already active in another Terraform run.") from exc


def release_workspace_lock(*, env: dict[str, str], lock_table: str, workspace: str, run_id: str) -> None:
    session = boto3_session_from_env(env)
    dynamodb = session.client("dynamodb", region_name=str(env.get("AWS_DEFAULT_REGION") or ""))
    lock_id = f"deplai-run::{workspace}"
    try:
        dynamodb.delete_item(
            TableName=lock_table,
            Key={"LockID": {"S": lock_id}},
            ConditionExpression="RunID = :run_id",
            ExpressionAttributeValues={":run_id": {"S": run_id}},
        )
    except Exception:
        pass
