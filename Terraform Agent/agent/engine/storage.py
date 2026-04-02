from __future__ import annotations

import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from botocore.exceptions import ClientError

from .runtime import run_dir, runs_root


RUNS_PREFIX = "deplai-runs"
RUN_RETENTION_DAYS = 7


def resolve_execution_credentials(
    *,
    aws_region: str,
    aws_access_key_id: str = "",
    aws_secret_access_key: str = "",
    aws_session_token: str = "",
) -> dict[str, str]:
    access_key = str(aws_access_key_id or "").strip()
    secret_key = str(aws_secret_access_key or "").strip()
    session_token = str(aws_session_token or "").strip()
    if access_key and secret_key:
        result = {
            "AWS_ACCESS_KEY_ID": access_key,
            "AWS_SECRET_ACCESS_KEY": secret_key,
            "AWS_DEFAULT_REGION": aws_region,
        }
        if session_token:
            result["AWS_SESSION_TOKEN"] = session_token
        return result

    import boto3

    session = boto3.session.Session(region_name=aws_region)
    creds = session.get_credentials()
    if creds is None:
        raise RuntimeError("No AWS execution credentials available from request or default credential chain.")
    frozen = creds.get_frozen_credentials()
    result = {
        "AWS_ACCESS_KEY_ID": str(frozen.access_key or "").strip(),
        "AWS_SECRET_ACCESS_KEY": str(frozen.secret_key or "").strip(),
        "AWS_DEFAULT_REGION": aws_region,
    }
    token = str(getattr(frozen, "token", "") or "").strip()
    if token:
        result["AWS_SESSION_TOKEN"] = token
    if not result["AWS_ACCESS_KEY_ID"] or not result["AWS_SECRET_ACCESS_KEY"]:
        raise RuntimeError("Resolved AWS credentials are incomplete.")
    return result


def boto3_session_from_env(env: dict[str, str]) -> Any:
    import boto3

    session_kwargs: dict[str, str] = {
        "region_name": str(env.get("AWS_DEFAULT_REGION") or ""),
    }
    if env.get("AWS_ACCESS_KEY_ID") and env.get("AWS_SECRET_ACCESS_KEY"):
        session_kwargs["aws_access_key_id"] = env["AWS_ACCESS_KEY_ID"]
        session_kwargs["aws_secret_access_key"] = env["AWS_SECRET_ACCESS_KEY"]
    if env.get("AWS_SESSION_TOKEN"):
        session_kwargs["aws_session_token"] = env["AWS_SESSION_TOKEN"]
    return boto3.session.Session(**session_kwargs)


def _iter_files(root: Path) -> list[Path]:
    return [path for path in sorted(root.rglob("*")) if path.is_file()]


def upload_run_snapshot(*, env: dict[str, str], state_bucket: str, workspace: str, run_id: str) -> None:
    session = boto3_session_from_env(env)
    s3 = session.client("s3", region_name=str(env.get("AWS_DEFAULT_REGION") or ""))
    root = run_dir(workspace, run_id)
    prefix = f"{RUNS_PREFIX}/{workspace}/{run_id}"
    for file_path in _iter_files(root):
        key = f"{prefix}/{file_path.relative_to(root).as_posix()}"
        s3.upload_file(str(file_path), state_bucket, key)


def download_run_snapshot(*, env: dict[str, str], state_bucket: str, workspace: str, run_id: str) -> Path:
    session = boto3_session_from_env(env)
    s3 = session.client("s3", region_name=str(env.get("AWS_DEFAULT_REGION") or ""))
    root = run_dir(workspace, run_id)
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True, exist_ok=True)
    prefix = f"{RUNS_PREFIX}/{workspace}/{run_id}/"
    paginator = s3.get_paginator("list_objects_v2")
    found_any = False
    for page in paginator.paginate(Bucket=state_bucket, Prefix=prefix):
        for item in page.get("Contents") or []:
            key = str(item.get("Key") or "")
            if not key or key.endswith("/"):
                continue
            rel_path = key[len(prefix):]
            target = root / rel_path
            target.parent.mkdir(parents=True, exist_ok=True)
            s3.download_file(state_bucket, key, str(target))
            found_any = True
    if not found_any:
        raise FileNotFoundError(f"Run snapshot not found in s3://{state_bucket}/{prefix}")
    return root


def cleanup_local_runs(*, retention_days: int = RUN_RETENTION_DAYS) -> None:
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    base = runs_root()
    if not base.exists():
        return
    for workspace_dir in base.iterdir():
        if not workspace_dir.is_dir():
            continue
        for candidate in workspace_dir.iterdir():
            if not candidate.is_dir():
                continue
            modified_at = datetime.fromtimestamp(candidate.stat().st_mtime, tz=timezone.utc)
            if modified_at < cutoff:
                shutil.rmtree(candidate, ignore_errors=True)


def cleanup_remote_runs(*, env: dict[str, str], state_bucket: str, retention_days: int = RUN_RETENTION_DAYS) -> None:
    bucket = str(state_bucket or "").strip()
    if not bucket:
        return

    session = boto3_session_from_env(env)
    s3 = session.client("s3", region_name=str(env.get("AWS_DEFAULT_REGION") or ""))
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    paginator = s3.get_paginator("list_objects_v2")
    to_delete: list[dict[str, str]] = []
    try:
        for page in paginator.paginate(Bucket=bucket, Prefix=f"{RUNS_PREFIX}/"):
            for item in page.get("Contents") or []:
                key = str(item.get("Key") or "")
                modified = item.get("LastModified")
                if not key or modified is None:
                    continue
                if modified < cutoff:
                    to_delete.append({"Key": key})
                    if len(to_delete) >= 500:
                        s3.delete_objects(Bucket=bucket, Delete={"Objects": to_delete, "Quiet": True})
                        to_delete = []
        if to_delete:
            s3.delete_objects(Bucket=bucket, Delete={"Objects": to_delete, "Quiet": True})
    except ClientError as exc:
        error_code = str(exc.response.get("Error", {}).get("Code") or "")
        if error_code in {"NoSuchBucket", "404"}:
            return
        if error_code in {"InvalidAccessKeyId", "SignatureDoesNotMatch", "AccessDenied", "ExpiredToken", "AuthFailure"}:
            raise RuntimeError(
                "AWS credentials are invalid or expired. Update the AWS access key, secret key, and session token if applicable, then retry."
            ) from exc
        raise
