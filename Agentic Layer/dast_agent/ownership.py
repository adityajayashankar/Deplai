"""DNS TXT and HTTP ownership verification.

Network fetches always go through OutboundTargetSecurityService. Tokens are
compared by hash; plaintext is not persisted by this module.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from urllib.parse import urljoin

import httpx

from dast_agent.codes import (
    AUTHZ_VERIFIED,
    DAST_DOMAIN_NOT_VERIFIED,
    DAST_INVALID_TARGET,
    DAST_REDIRECT_OUT_OF_SCOPE,
    DAST_UNSAFE_TARGET,
    METHOD_DNS,
    METHOD_HTTP,
    SCOPE_DOMAIN,
    SCOPE_HOST,
)
from dast_agent.normalize import normalize_target
from dast_agent.scope import DastScope, scope_from_asset
from dast_agent.ssrf import inspect_outbound_target, validate_redirect_hop

TXT_PREFIX = "deplai-domain-verification="
TXT_NAME_PREFIX = "_deplai-verify."
WELL_KNOWN_PREFIX = "/.well-known/deplai-verification/"


def token_hash(token: str) -> str:
    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


def expected_txt_value(token: str) -> str:
    return f"{TXT_PREFIX}{token}"


def dns_challenge_name(domain: str) -> str:
    host = str(domain or "").strip().rstrip(".").lower()
    return f"{TXT_NAME_PREFIX}{host}"


def http_challenge_url(hostname: str, token: str, scheme: str = "https") -> str:
    host = str(hostname or "").strip().rstrip(".").lower()
    return f"{scheme}://{host}{WELL_KNOWN_PREFIX}{token}"


def _hash_txt_candidate(value: str) -> set[str]:
    text = str(value or "").strip().strip('"')
    hashes = {token_hash(text)}
    if text.startswith(TXT_PREFIX):
        hashes.add(token_hash(text[len(TXT_PREFIX):]))
        hashes.add(token_hash(text))
    return hashes


def query_txt_records(name: str) -> list[str]:
    try:
        import dns.resolver  # type: ignore
    except ImportError:
        return []
    try:
        answers = dns.resolver.resolve(name, "TXT", lifetime=5)
    except Exception:
        return []
    records: list[str] = []
    for item in answers:
        try:
            joined = "".join(part.decode("utf-8") if isinstance(part, bytes) else str(part) for part in item.strings)
        except Exception:
            joined = str(item).strip('"')
        if joined:
            records.append(joined)
    return records


@dataclass
class OwnershipCheck:
    ok: bool
    method: str
    status: str
    code: str
    message: str
    evidence_hash: str = ""
    records: list[str] | None = None


def verify_dns(domain: str, expected_hash: str) -> OwnershipCheck:
    target = normalize_target(f"https://{str(domain or '').strip().rstrip('.')}/")
    if not target.ok:
        return OwnershipCheck(False, METHOD_DNS, "REJECTED", target.code, target.message)
    ssrf = inspect_outbound_target(target.url)
    if not ssrf.ok:
        return OwnershipCheck(False, METHOD_DNS, "REJECTED", ssrf.code, ssrf.message)
    name = dns_challenge_name(target.hostname)
    records = query_txt_records(name)
    want = str(expected_hash or "").strip().lower()
    matched = False
    for record in records:
        if want and want in _hash_txt_candidate(record):
            matched = True
            break
    if not matched:
        return OwnershipCheck(
            False,
            METHOD_DNS,
            "PENDING",
            DAST_DOMAIN_NOT_VERIFIED,
            "DNS TXT verification record was not found yet.",
            records=records,
        )
    evidence = token_hash("|".join(sorted(records)))
    return OwnershipCheck(True, METHOD_DNS, AUTHZ_VERIFIED, "", "VERIFIED", evidence, records)


def _http_get_no_follow(url: str) -> httpx.Response:
    timeout = float(os.getenv("DAST_VERIFY_TIMEOUT_SECONDS", "10"))
    with httpx.Client(follow_redirects=False, timeout=timeout, verify=True) as client:
        return client.get(url, headers={"User-Agent": "DeplAI-DAST-Verify/1.0"})


def verify_http(
    hostname: str,
    token: str,
    expected_hash: str,
    *,
    scheme: str = "https",
    max_redirects: int | None = None,
) -> OwnershipCheck:
    if scheme != "https" and os.getenv("DAST_ALLOW_HTTP_VERIFICATION", "false").strip().lower() not in {"1", "true", "yes", "on"}:
        return OwnershipCheck(
            False,
            METHOD_HTTP,
            "REJECTED",
            DAST_UNSAFE_TARGET,
            "HTTP file verification requires https.",
        )
    url = http_challenge_url(hostname, token, scheme=scheme)
    ssrf = inspect_outbound_target(url, allow_http_override=(scheme == "http"))
    if not ssrf.ok or ssrf.normalized is None:
        return OwnershipCheck(False, METHOD_HTTP, "REJECTED", ssrf.code or DAST_INVALID_TARGET, ssrf.message)
    scope = scope_from_asset(hostname=ssrf.normalized.hostname, scheme=ssrf.normalized.scheme, scope_mode=SCOPE_HOST)
    hops = int(max_redirects if max_redirects is not None else os.getenv("DAST_MAX_REDIRECTS", "2"))
    current = ssrf.normalized.url
    body = ""
    for hop in range(hops + 1):
        check = inspect_outbound_target(current, allow_http_override=(scheme == "http"))
        if not check.ok:
            return OwnershipCheck(False, METHOD_HTTP, "REJECTED", check.code, check.message)
        if check.normalized and not scope.covers_url(check.normalized.url):
            return OwnershipCheck(False, METHOD_HTTP, "REJECTED", DAST_REDIRECT_OUT_OF_SCOPE, "Verification redirect left the authorized host.")
        try:
            response = _http_get_no_follow(current)
        except httpx.HTTPError as exc:
            return OwnershipCheck(False, METHOD_HTTP, "PENDING", DAST_DOMAIN_NOT_VERIFIED, f"Verification endpoint was not reachable ({exc.__class__.__name__}).")
        if response.status_code in {301, 302, 303, 307, 308}:
            location = response.headers.get("location") or ""
            nxt = validate_redirect_hop(current, location, scope, max_redirects=hops, hop_index=hop)
            if not nxt.ok:
                return OwnershipCheck(False, METHOD_HTTP, "REJECTED", nxt.code, nxt.message)
            current = urljoin(current, location)
            continue
        if response.status_code >= 400:
            return OwnershipCheck(False, METHOD_HTTP, "PENDING", DAST_DOMAIN_NOT_VERIFIED, "Verification file was not found.")
        body = (response.text or "").strip()
        break
    else:
        return OwnershipCheck(False, METHOD_HTTP, "REJECTED", DAST_REDIRECT_OUT_OF_SCOPE, "Too many verification redirects.")

    want = str(expected_hash or "").strip().lower()
    body_token = body[len(TXT_PREFIX):] if body.startswith(TXT_PREFIX) else body
    accepted = {token_hash(body), token_hash(body_token)}
    if want not in accepted:
        return OwnershipCheck(False, METHOD_HTTP, "PENDING", DAST_DOMAIN_NOT_VERIFIED, "Verification file did not match the expected challenge.")
    evidence = token_hash(body)
    return OwnershipCheck(True, METHOD_HTTP, AUTHZ_VERIFIED, "", "VERIFIED", evidence)


def verification_scope_mode(method: str) -> str:
    return SCOPE_DOMAIN if method == METHOD_DNS else SCOPE_HOST
