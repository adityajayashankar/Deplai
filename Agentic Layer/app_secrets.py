"""Application secrets in the customer's AWS Secrets Manager.

Naming: {prefix}/{KEY} where prefix is typically /{project}/{environment}.
Values are never returned by list APIs — only key metadata.
"""

from __future__ import annotations

import re
from typing import Any


def normalize_secrets_prefix(prefix: str, *, project_name: str = "deplai", environment: str = "prod") -> str:
    raw = str(prefix or "").strip().replace("\\", "/")
    if not raw:
        slug = re.sub(r"[^a-zA-Z0-9-]+", "-", str(project_name or "deplai").strip()).strip("-").lower() or "deplai"
        env = re.sub(r"[^a-zA-Z0-9-]+", "-", str(environment or "prod").strip()).strip("-").lower() or "prod"
        raw = f"/{slug}/{env}"
    if not raw.startswith("/"):
        raw = f"/{raw}"
    return raw.rstrip("/") or "/deplai/prod"


def normalize_secret_key(key: str) -> str:
    name = str(key or "").strip()
    if not name:
        raise ValueError("secret key is required")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        raise ValueError(f"invalid secret key '{name}': use letters, numbers, underscore")
    return name


def secret_full_name(prefix: str, key: str) -> str:
    return f"{normalize_secrets_prefix(prefix)}/{normalize_secret_key(key)}"


def key_from_full_name(prefix: str, full_name: str) -> str | None:
    normalized_prefix = normalize_secrets_prefix(prefix)
    name = str(full_name or "").strip()
    if not name.startswith(f"{normalized_prefix}/"):
        return None
    key = name[len(normalized_prefix) + 1 :]
    if not key or "/" in key:
        return None
    return key


def _client(session_kwargs: dict[str, Any], region: str):
    import boto3

    session = boto3.session.Session(**session_kwargs)
    return session.client("secretsmanager", region_name=region)


def list_app_secrets(
    *,
    aws_access_key_id: str,
    aws_secret_access_key: str,
    aws_session_token: str | None,
    aws_region: str,
    prefix: str,
) -> list[dict[str, Any]]:
    session_kwargs: dict[str, Any] = {
        "aws_access_key_id": aws_access_key_id,
        "aws_secret_access_key": aws_secret_access_key,
        "region_name": aws_region,
    }
    if aws_session_token:
        session_kwargs["aws_session_token"] = aws_session_token
    client = _client(session_kwargs, aws_region)
    normalized_prefix = normalize_secrets_prefix(prefix)
    # ListSecrets NameFilter is a substring match, not a path prefix filter.
    # Filter client-side to keys exactly under our prefix.
    secrets: list[dict[str, Any]] = []
    token: str | None = None
    while True:
        kwargs: dict[str, Any] = {"MaxResults": 100}
        if token:
            kwargs["NextToken"] = token
        # Name filter is a prefix on the full secret name (includes leading '/').
        kwargs["Filters"] = [{"Key": "name", "Values": [normalized_prefix]}]
        try:
            resp = client.list_secrets(**kwargs)
        except Exception:
            # Fallback without filter for older permissions / regions.
            kwargs.pop("Filters", None)
            resp = client.list_secrets(**kwargs)
        for item in resp.get("SecretList") or []:
            name = str(item.get("Name") or "")
            key = key_from_full_name(normalized_prefix, name)
            if not key:
                continue
            secrets.append(
                {
                    "key": key,
                    "name": name,
                    "arn": str(item.get("ARN") or "") or None,
                    "updated_at": str(item.get("LastChangedDate") or item.get("LastAccessedDate") or "") or None,
                    "is_set": True,
                }
            )
        token = resp.get("NextToken")
        if not token:
            break
    secrets.sort(key=lambda row: str(row.get("key") or ""))
    return secrets


def upsert_app_secrets(
    *,
    aws_access_key_id: str,
    aws_secret_access_key: str,
    aws_session_token: str | None,
    aws_region: str,
    prefix: str,
    secrets: list[dict[str, str]],
) -> list[dict[str, Any]]:
    session_kwargs: dict[str, Any] = {
        "aws_access_key_id": aws_access_key_id,
        "aws_secret_access_key": aws_secret_access_key,
        "region_name": aws_region,
    }
    if aws_session_token:
        session_kwargs["aws_session_token"] = aws_session_token
    client = _client(session_kwargs, aws_region)
    normalized_prefix = normalize_secrets_prefix(prefix)
    results: list[dict[str, Any]] = []
    for entry in secrets:
        key = normalize_secret_key(str(entry.get("key") or ""))
        value = str(entry.get("value") or "")
        if not value:
            raise ValueError(f"secret value required for key '{key}'")
        full_name = secret_full_name(normalized_prefix, key)
        try:
            resp = client.create_secret(Name=full_name, SecretString=value)
            arn = str(resp.get("ARN") or "")
        except Exception:
            client.put_secret_value(SecretId=full_name, SecretString=value)
            desc = client.describe_secret(SecretId=full_name)
            arn = str(desc.get("ARN") or "")
        results.append({"key": key, "name": full_name, "arn": arn or None, "is_set": True})
    return results


def delete_app_secret(
    *,
    aws_access_key_id: str,
    aws_secret_access_key: str,
    aws_session_token: str | None,
    aws_region: str,
    prefix: str,
    key: str,
) -> dict[str, Any]:
    session_kwargs: dict[str, Any] = {
        "aws_access_key_id": aws_access_key_id,
        "aws_secret_access_key": aws_secret_access_key,
        "region_name": aws_region,
    }
    if aws_session_token:
        session_kwargs["aws_session_token"] = aws_session_token
    client = _client(session_kwargs, aws_region)
    full_name = secret_full_name(prefix, key)
    client.delete_secret(SecretId=full_name, ForceDeleteWithoutRecovery=True)
    return {"key": normalize_secret_key(key), "name": full_name, "deleted": True}
