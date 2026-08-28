"""Target authorization service.

A user-supplied URL is never sufficient. A scan is allowed only when the
target belongs to a verified project asset or a verified domain/host, and
then only after scope + SSRF checks succeed.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from dast_agent.codes import (
    AUTHZ_EXPIRED,
    AUTHZ_PENDING,
    AUTHZ_REJECTED,
    AUTHZ_REVOKED,
    AUTHZ_VERIFIED,
    DAST_DOMAIN_NOT_VERIFIED,
    DAST_GRANT_INVALID,
    DAST_TARGET_NOT_AUTHORIZED,
    DAST_TARGET_OUTSIDE_SCOPE,
    DAST_VERIFICATION_EXPIRED,
    DAST_VERIFICATION_REVOKED,
    POLICY_VERSION,
    REASON_DOMAIN_NOT_VERIFIED,
    REASON_EXPIRED,
    REASON_INVALID,
    REASON_NOT_ASSOCIATED,
    REASON_OUTSIDE_SCOPE,
    REASON_PROJECT_ASSET,
    REASON_REVOKED,
    REASON_UNSAFE,
    REASON_VERIFIED_DOMAIN,
    REASON_VERIFIED_HOST,
    SCOPE_DOMAIN,
    SCOPE_HOST,
    SCOPE_PROJECT_ASSET,
    USER_DOMAIN_NOT_VERIFIED,
    USER_NOT_AUTHORIZED,
)
from dast_agent.scope import DastScope, scope_from_asset
from dast_agent.ssrf import inspect_outbound_target


def authz_secret() -> str:
    return (
        os.getenv("DAST_AUTHZ_SECRET", "").strip()
        or os.getenv("DEPLAI_SERVICE_KEY", "").strip()
    )


def _parse_ts(value: str | None) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed
    except ValueError:
        return None


def canonical_grant(payload: dict[str, Any]) -> str:
    return "|".join([
        str(payload.get("asset_id") or ""),
        str(payload.get("project_id") or ""),
        str(payload.get("hostname") or "").strip().rstrip(".").lower(),
        str(payload.get("scope_mode") or ""),
        str(payload.get("status") or ""),
        str(payload.get("verification_expires_at") or ""),
        str(payload.get("issued_at") or ""),
        str(payload.get("grant_expires_at") or ""),
        str(payload.get("policy_version") or POLICY_VERSION),
    ])


def sign_grant(payload: dict[str, Any], secret: str | None = None) -> str:
    key = (secret if secret is not None else authz_secret()).encode("utf-8")
    if not key:
        raise ValueError(f"{DAST_GRANT_INVALID}: Authorization signing secret is not configured.")
    return hmac.new(key, canonical_grant(payload).encode("utf-8"), hashlib.sha256).hexdigest()


def verify_grant_signature(payload: dict[str, Any], secret: str | None = None) -> bool:
    provided = str(payload.get("signature") or "").strip()
    if not provided:
        return False
    try:
        expected = sign_grant(payload, secret)
    except ValueError:
        return False
    return hmac.compare_digest(provided, expected)


@dataclass
class AuthorizationResult:
    authorized: bool
    reason: str
    code: str
    message: str
    asset_id: str = ""
    scope_mode: str = ""
    verification_method: str = ""
    verification_timestamp: str = ""
    verification_expiry: str = ""
    hostname: str = ""
    resolved_ips: list[str] | None = None
    scope: DastScope | None = None

    def __post_init__(self) -> None:
        if self.resolved_ips is None:
            self.resolved_ips = []


def _rejected(reason: str, code: str, message: str) -> AuthorizationResult:
    return AuthorizationResult(False, reason, code, message)


def authorize_target(
    *,
    project_id: str,
    requested_target: str,
    grant: dict[str, Any] | None,
    live_asset: dict[str, Any] | None = None,
) -> AuthorizationResult:
    """Fail-closed authorization. Live asset status wins over a stale grant."""
    if not grant:
        return _rejected(REASON_NOT_ASSOCIATED, DAST_TARGET_NOT_AUTHORIZED, USER_NOT_AUTHORIZED)

    if str(grant.get("project_id") or "") != str(project_id or ""):
        return _rejected(REASON_NOT_ASSOCIATED, DAST_TARGET_NOT_AUTHORIZED, USER_NOT_AUTHORIZED)

    if not verify_grant_signature(grant):
        return _rejected(REASON_NOT_ASSOCIATED, DAST_GRANT_INVALID, USER_NOT_AUTHORIZED)

    now = datetime.now(timezone.utc)
    grant_exp = _parse_ts(str(grant.get("grant_expires_at") or ""))
    if grant_exp is None or grant_exp <= now:
        return _rejected(REASON_EXPIRED, DAST_GRANT_INVALID, USER_NOT_AUTHORIZED)

    status = str((live_asset or grant).get("status") or "").upper()
    if status == AUTHZ_REVOKED or (live_asset or {}).get("revoked_at"):
        return _rejected(REASON_REVOKED, DAST_VERIFICATION_REVOKED, USER_NOT_AUTHORIZED)
    if status == AUTHZ_EXPIRED:
        return _rejected(REASON_EXPIRED, DAST_VERIFICATION_EXPIRED, USER_NOT_AUTHORIZED)
    if status == AUTHZ_PENDING:
        return _rejected(REASON_DOMAIN_NOT_VERIFIED, DAST_DOMAIN_NOT_VERIFIED, USER_DOMAIN_NOT_VERIFIED)
    if status == AUTHZ_REJECTED:
        return _rejected(REASON_NOT_ASSOCIATED, DAST_TARGET_NOT_AUTHORIZED, USER_NOT_AUTHORIZED)
    if status != AUTHZ_VERIFIED:
        return _rejected(REASON_DOMAIN_NOT_VERIFIED, DAST_DOMAIN_NOT_VERIFIED, USER_DOMAIN_NOT_VERIFIED)

    verification_exp = _parse_ts(str((live_asset or grant).get("verification_expires_at") or grant.get("expires_at") or ""))
    if verification_exp is not None and verification_exp <= now:
        return _rejected(REASON_EXPIRED, DAST_VERIFICATION_EXPIRED, USER_NOT_AUTHORIZED)

    ssrf = inspect_outbound_target(requested_target)
    if not ssrf.ok or ssrf.normalized is None:
        code = ssrf.code or DAST_TARGET_NOT_AUTHORIZED
        reason = REASON_UNSAFE if "PRIVATE" in code or "UNSAFE" in code else REASON_INVALID
        return AuthorizationResult(False, reason, code, ssrf.message or USER_NOT_AUTHORIZED)

    hostname = str((live_asset or grant).get("hostname") or grant.get("hostname") or "").strip().rstrip(".").lower()
    scope_mode = str((live_asset or grant).get("scope_mode") or grant.get("scope_mode") or SCOPE_HOST).upper()
    scheme = str((live_asset or grant).get("scheme") or ssrf.normalized.scheme or "https")
    path_prefix = str((live_asset or grant).get("path_prefix") or "") or None
    port_raw = (live_asset or grant).get("port")
    port = int(port_raw) if str(port_raw or "").isdigit() else ssrf.normalized.port
    scope = scope_from_asset(
        hostname=hostname,
        scheme=scheme,
        scope_mode=scope_mode,
        path_prefix=path_prefix,
        port=port if scope_mode == SCOPE_HOST else None,
    )
    if not scope.covers_url(ssrf.normalized.url):
        return _rejected(REASON_OUTSIDE_SCOPE, DAST_TARGET_OUTSIDE_SCOPE, USER_NOT_AUTHORIZED)

    if scope_mode == SCOPE_DOMAIN:
        reason = REASON_VERIFIED_DOMAIN
    elif scope_mode == SCOPE_PROJECT_ASSET:
        reason = REASON_PROJECT_ASSET
    else:
        reason = REASON_VERIFIED_HOST

    return AuthorizationResult(
        authorized=True,
        reason=reason,
        code="",
        message="AUTHORIZED",
        asset_id=str(grant.get("asset_id") or ""),
        scope_mode=scope_mode if scope_mode in {SCOPE_HOST, SCOPE_DOMAIN, SCOPE_PROJECT_ASSET} else SCOPE_HOST,
        verification_method=str((live_asset or grant).get("verification_method") or ""),
        verification_timestamp=str((live_asset or grant).get("verified_at") or ""),
        verification_expiry=str(verification_exp.isoformat() if verification_exp else ""),
        hostname=ssrf.normalized.hostname,
        resolved_ips=list(ssrf.resolved_ips),
        scope=scope,
    )
