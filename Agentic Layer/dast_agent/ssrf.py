"""Outbound target security: SSRF, DNS safety, and redirect hop checks.

Every outbound URL (scan target, ownership HTTP check, redirect) must pass
this service immediately before connect.
"""

from __future__ import annotations

import ipaddress
import os
import socket
from dataclasses import dataclass, field
from urllib.parse import urljoin

from dast_agent.codes import (
    DAST_DNS_REBINDING_BLOCKED,
    DAST_INVALID_TARGET,
    DAST_PRIVATE_IP_BLOCKED,
    DAST_REDIRECT_OUT_OF_SCOPE,
    DAST_UNSAFE_TARGET,
)
from dast_agent.normalize import NormalizedTarget, normalize_target
from dast_agent.scope import DastScope

_BLOCKED_HOSTS = {
    "localhost",
    "localhost.localdomain",
    "metadata",
    "metadata.google.internal",
    "metadata.internal",
    "kubernetes",
    "kubernetes.default",
    "kubernetes.default.svc",
}

_BLOCKED_NETWORKS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("224.0.0.0/4"),
    ipaddress.ip_network("240.0.0.0/4"),
    ipaddress.ip_network("198.18.0.0/15"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]

_METADATA_IPS = {
    "169.254.169.254",
    "169.254.170.2",
    "fd00:ec2::254",
}


@dataclass
class OutboundCheck:
    ok: bool
    code: str
    message: str
    normalized: NormalizedTarget | None = None
    resolved_ips: list[str] = field(default_factory=list)


def allow_http() -> bool:
    return os.getenv("DAST_ALLOW_HTTP", "false").strip().lower() in {"1", "true", "yes", "on"}


def _parse_literal_ip(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    raw = str(host or "").strip()
    if not raw:
        return None
    if raw.endswith("."):
        raw = raw[:-1]
    try:
        return ipaddress.ip_address(raw)
    except ValueError:
        pass
    if raw.isdigit():
        try:
            return ipaddress.ip_address(int(raw))
        except (ValueError, OverflowError):
            return None
    lowered = raw.lower()
    if lowered.startswith("0x"):
        try:
            return ipaddress.ip_address(int(lowered, 16))
        except (ValueError, OverflowError):
            return None
    if lowered.startswith("0") and all(c in "01234567" for c in lowered):
        try:
            return ipaddress.ip_address(int(lowered, 8))
        except (ValueError, OverflowError):
            return None
    return None


def is_blocked_ip(value: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    address = value
    if isinstance(address, ipaddress.IPv6Address):
        mapped = address.ipv4_mapped
        if mapped is not None:
            address = mapped
        elif address.sixtofour is not None:
            address = address.sixtofour
        elif address.teredo is not None:
            return True
    text = str(address)
    if text in _METADATA_IPS:
        return True
    if any((
        address.is_private,
        address.is_loopback,
        address.is_link_local,
        address.is_multicast,
        address.is_reserved,
        address.is_unspecified,
    )):
        return True
    for network in _BLOCKED_NETWORKS:
        try:
            if address in network:
                return True
        except TypeError:
            continue
    return False


def _hostname_blocked(host: str) -> bool:
    name = str(host or "").strip().rstrip(".").lower()
    if not name:
        return True
    if name in _BLOCKED_HOSTS:
        return True
    if name.endswith(".localhost") or name.endswith(".internal") or name.endswith(".local"):
        return True
    if name.endswith(".lan") or name.endswith(".home") or name.endswith(".corp"):
        return True
    return False


def resolve_public_ips(hostname: str) -> tuple[list[str], str]:
    literal = _parse_literal_ip(hostname)
    if literal is not None:
        if is_blocked_ip(literal):
            return [], DAST_PRIVATE_IP_BLOCKED
        return [str(literal)], ""
    try:
        infos = socket.getaddrinfo(hostname, None)
    except OSError:
        return [], DAST_INVALID_TARGET
    addresses: list[str] = []
    for info in infos:
        sockaddr = info[4]
        if not sockaddr:
            continue
        candidate = str(sockaddr[0]).split("%", 1)[0]
        if candidate not in addresses:
            addresses.append(candidate)
    if not addresses:
        return [], DAST_INVALID_TARGET
    for item in addresses:
        try:
            parsed_ip = ipaddress.ip_address(item)
        except ValueError:
            continue
        if is_blocked_ip(parsed_ip):
            return [], DAST_PRIVATE_IP_BLOCKED
    return addresses, ""


def inspect_outbound_target(url: str, *, allow_http_override: bool | None = None) -> OutboundCheck:
    http_ok = allow_http() if allow_http_override is None else allow_http_override
    target = normalize_target(url, allow_http=http_ok)
    if not target.ok:
        return OutboundCheck(False, target.code, target.message, target)

    if _hostname_blocked(target.hostname):
        return OutboundCheck(
            False,
            DAST_UNSAFE_TARGET,
            "Target hostname is not allowed for dynamic testing.",
            target,
        )

    ips, code = resolve_public_ips(target.hostname)
    if code == DAST_PRIVATE_IP_BLOCKED:
        return OutboundCheck(
            False,
            DAST_PRIVATE_IP_BLOCKED,
            "Target must be a public application URL, not an internal address.",
            target,
        )
    if code:
        return OutboundCheck(
            False,
            DAST_INVALID_TARGET,
            "Target hostname could not be resolved.",
            target,
        )
    return OutboundCheck(True, "", "", target, ips)


def validate_outbound_target(url: str) -> tuple[bool, str]:
    """Compatibility wrapper used by the existing DAST pipeline validators."""
    check = inspect_outbound_target(url)
    return check.ok, check.message


def pin_matches(previous: list[str], current: list[str]) -> bool:
    prior = {item for item in previous if item}
    now = {item for item in current if item}
    if not prior or not now:
        return False
    return now.issubset(prior)


def revalidate_resolution(url: str, pinned_ips: list[str]) -> OutboundCheck:
    check = inspect_outbound_target(url)
    if not check.ok:
        if check.code == DAST_PRIVATE_IP_BLOCKED and pinned_ips:
            return OutboundCheck(
                False,
                DAST_DNS_REBINDING_BLOCKED,
                "Target DNS resolution changed to an unauthorized address.",
                check.normalized,
                check.resolved_ips,
            )
        return check
    if not pin_matches(pinned_ips, check.resolved_ips):
        return OutboundCheck(
            False,
            DAST_DNS_REBINDING_BLOCKED,
            "Target DNS resolution changed to an unauthorized address.",
            check.normalized,
            check.resolved_ips,
        )
    return check


def validate_redirect_hop(
    current_url: str,
    location: str,
    scope: DastScope,
    *,
    max_redirects: int,
    hop_index: int,
) -> OutboundCheck:
    if hop_index >= max_redirects:
        return OutboundCheck(False, DAST_REDIRECT_OUT_OF_SCOPE, "Too many redirects.")
    nxt = urljoin(current_url, str(location or "").strip())
    check = inspect_outbound_target(nxt)
    if not check.ok:
        if check.code == DAST_PRIVATE_IP_BLOCKED:
            return OutboundCheck(False, DAST_REDIRECT_OUT_OF_SCOPE, "Redirect target is not allowed.", check.normalized)
        return check
    if check.normalized and not scope.covers_url(check.normalized.url):
        return OutboundCheck(
            False,
            DAST_REDIRECT_OUT_OF_SCOPE,
            "Redirect target is outside the authorized scan scope.",
            check.normalized,
            check.resolved_ips,
        )
    return check
