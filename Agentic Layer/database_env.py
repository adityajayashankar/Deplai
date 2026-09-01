"""Shared database environment construction for bootstrap and API surfaces."""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote, urlparse

_INVALID_HOST_TOKENS = frozenset({"", "null", "undefined", "none"})
_SUPPORTED_DATABASE_SCHEMES = frozenset({"postgres", "postgresql", "mysql", "mysql2", "mariadb"})
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")


def _valid_port(value: Any) -> str | None:
    raw = str(value or "").strip()
    try:
        port = int(raw)
    except (TypeError, ValueError):
        return None
    return str(port) if 1 <= port <= 65535 else None


def _valid_host(value: Any) -> str:
    host = str(value or "").strip()
    if host.lower() in _INVALID_HOST_TOKENS:
        return ""
    if _CONTROL_CHARACTERS.search(host) or any(char in host for char in "/@?#"):
        return ""
    return host


def resolve_database_host(
    secret: dict[str, Any] | None,
    *,
    rds_endpoint: str | None = None,
) -> str:
    host = ""
    if isinstance(secret, dict):
        host = _valid_host(secret.get("host") or secret.get("hostname"))
    endpoint = _valid_host(rds_endpoint)
    return host or endpoint


def database_url_has_empty_host(database_url: str) -> bool:
    raw = str(database_url or "").strip()
    if not raw:
        return True
    try:
        parsed = urlparse(raw)
        host = str(parsed.hostname or "").strip()
        port = parsed.port
    except (TypeError, ValueError):
        return True
    if parsed.scheme.lower() not in _SUPPORTED_DATABASE_SCHEMES or not parsed.netloc:
        return True
    if not _valid_host(host):
        return True
    if port is not None and not 1 <= port <= 65535:
        return True
    if _CONTROL_CHARACTERS.search(raw) or any(char.isspace() for char in raw):
        return True
    # mysql://user:pass@:3306/db style
    if re.search(r"@:(\d+)?", raw):
        return True
    return False


def build_database_env_lines(
    secret: dict[str, Any] | None,
    *,
    rds_endpoint: str | None = None,
    explicit_database_url: str | None = None,
) -> tuple[list[str], str | None]:
    """Return env lines and an error code (None when valid)."""
    if explicit_database_url:
        url = str(explicit_database_url).strip()
        if database_url_has_empty_host(url):
            return [], "INVALID_DATABASE_CONFIGURATION"
        return [f"DATABASE_URL={url}"], None

    if not isinstance(secret, dict) or not secret:
        return [], "INVALID_DATABASE_CONFIGURATION"

    user = str(secret.get("username") or secret.get("user") or "").strip()
    password = str(secret.get("password") or "").strip()
    host = resolve_database_host(secret, rds_endpoint=rds_endpoint)
    port = _valid_port(secret.get("port") or "5432")
    dbname = str(secret.get("dbname") or secret.get("database") or "appdb").strip() or "appdb"

    if not host:
        return [], "MISSING_DATABASE_HOST"
    if not port:
        return [], "INVALID_DATABASE_PORT"
    if not user or not password:
        return [], "INCOMPLETE_DATABASE_CREDENTIALS"
    if any(_CONTROL_CHARACTERS.search(value) for value in (user, password, dbname)):
        return [], "INVALID_DATABASE_CONFIGURATION"

    engine = str(secret.get("engine") or "postgres").lower()
    scheme = "mysql" if "mysql" in engine or "mariadb" in engine else "postgresql"
    database_url = (
        f"{scheme}://{quote(user, safe='')}:{quote(password, safe='')}@{host}:{port}/{quote(dbname, safe='')}"
    )
    if database_url_has_empty_host(database_url):
        return [], "INVALID_DATABASE_CONFIGURATION"

    lines = [
        f"PGHOST={host}",
        f"PGPORT={port}",
        f"PGUSER={user}",
        f"PGPASSWORD={password}",
        f"PGDATABASE={dbname}",
        f"DATABASE_URL={database_url}",
    ]
    return lines, None


def database_env_from_secret(
    secret: dict[str, Any] | None,
    *,
    rds_endpoint: str | None = None,
) -> str:
    lines, error = build_database_env_lines(secret, rds_endpoint=rds_endpoint)
    if error or not lines:
        return ""
    return "\n".join(lines) + "\n"


def validate_customer_database_configuration(
    *,
    database_url: str | None = None,
    host: str | None = None,
    port: str | None = None,
    database_name: str | None = None,
    username: str | None = None,
    password: str | None = None,
) -> dict[str, Any]:
    url = str(database_url or "").strip()
    if url:
        if database_url_has_empty_host(url):
            return {
                "ok": False,
                "code": "INVALID_DATABASE_CONFIGURATION",
                "message": "PostgreSQL configuration is incomplete: database hostname is missing.",
            }
        return {"ok": True}

    resolved_host = _valid_host(host)
    missing: list[str] = []
    if not resolved_host:
        missing.append("database hostname")
    if not _valid_port(port):
        missing.append("database port")
    if not str(database_name or "").strip():
        missing.append("database name")
    if not str(username or "").strip():
        missing.append("database username")
    if not str(password or "").strip():
        missing.append("database password")
    if missing:
        return {
            "ok": False,
            "code": "INVALID_DATABASE_CONFIGURATION",
            "message": f"PostgreSQL configuration is incomplete: {', '.join(missing)} missing.",
        }
    return {"ok": True}


def validate_provisioned_rds_preflight(*, database_required: bool) -> dict[str, Any]:
    if not database_required:
        return {"ok": True, "stage": "static_preflight"}
    return {
        "ok": True,
        "stage": "static_preflight",
        "message": "RDS will be provisioned during apply; hostname resolved from RDS endpoint at bootstrap.",
    }
