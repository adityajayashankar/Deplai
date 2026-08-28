"""Label-aware hostname/domain scope matching.

Never use hostname.endswith(domain). Compare DNS labels from the right.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from urllib.parse import urlparse

from dast_agent.codes import SCOPE_DOMAIN, SCOPE_HOST, SCOPE_PROJECT_ASSET
from dast_agent.normalize import hostname_from_url, normalize_target


def split_labels(hostname: str) -> list[str]:
    host = str(hostname or "").strip().rstrip(".").lower()
    if not host:
        return []
    return [part for part in host.split(".") if part]


def hosts_equal(left: str, right: str) -> bool:
    a = split_labels(left)
    b = split_labels(right)
    return bool(a) and a == b


def is_hostname_in_domain(hostname: str, domain: str) -> bool:
    """True when hostname equals domain or is a proper subdomain of domain."""
    host_labels = split_labels(hostname)
    domain_labels = split_labels(domain)
    if not host_labels or not domain_labels:
        return False
    if len(host_labels) < len(domain_labels):
        return False
    return host_labels[-len(domain_labels):] == domain_labels


def path_allowed(path: str, prefixes: list[str] | None) -> bool:
    current = path or "/"
    if not prefixes:
        return True
    for prefix in prefixes:
        allowed = prefix if str(prefix).startswith("/") else f"/{prefix}"
        if current == allowed or current.startswith(allowed.rstrip("/") + "/") or (allowed == "/" ):
            if allowed == "/":
                return True
            if current == allowed or current.startswith(allowed.rstrip("/") + "/"):
                return True
    return False


@dataclass
class DastScope:
    scheme: str
    hostname: str
    ports: list[int] = field(default_factory=list)
    allowed_subdomains: bool = False
    path_prefixes: list[str] = field(default_factory=list)
    excluded_paths: list[str] = field(default_factory=list)
    excluded_hosts: list[str] = field(default_factory=list)
    max_depth: int = 10
    max_urls: int = 200
    max_duration: int = 900
    max_concurrency: int = 1
    scope_mode: str = SCOPE_HOST

    def covers_hostname(self, hostname: str) -> bool:
        host = str(hostname or "").strip().rstrip(".").lower()
        if not host:
            return False
        if any(hosts_equal(host, blocked) or is_hostname_in_domain(host, blocked) for blocked in self.excluded_hosts):
            return False
        if self.scope_mode in {SCOPE_HOST, SCOPE_PROJECT_ASSET} and not self.allowed_subdomains:
            return hosts_equal(host, self.hostname)
        return is_hostname_in_domain(host, self.hostname)

    def covers_url(self, url: str, *, allow_http: bool = True) -> bool:
        target = normalize_target(url, allow_http=allow_http)
        if not target.ok:
            return False
        if target.scheme != self.scheme and not (self.scheme == "https" and target.scheme == "https"):
            if target.scheme != self.scheme:
                return False
        if not self.covers_hostname(target.hostname):
            return False
        if self.ports:
            effective = target.port
            if effective is None:
                effective = 443 if target.scheme == "https" else 80
            if effective not in self.ports:
                return False
        path = target.path or "/"
        if any(path == item or path.startswith(str(item).rstrip("/") + "/") for item in self.excluded_paths if item):
            return False
        return path_allowed(path, self.path_prefixes or None)


def scope_from_asset(
    *,
    hostname: str,
    scheme: str,
    scope_mode: str,
    path_prefix: str | None = None,
    port: int | None = None,
) -> DastScope:
    mode = str(scope_mode or SCOPE_HOST).upper()
    if mode not in {SCOPE_HOST, SCOPE_DOMAIN, SCOPE_PROJECT_ASSET}:
        mode = SCOPE_HOST
    prefixes = [path_prefix] if path_prefix else []
    ports = [port] if port else []
    return DastScope(
        scheme=scheme or "https",
        hostname=str(hostname or "").strip().rstrip(".").lower(),
        ports=ports,
        allowed_subdomains=mode == SCOPE_DOMAIN,
        path_prefixes=prefixes,
        scope_mode=mode,
    )


def discovered_url_in_scope(url: str, scope: DastScope) -> bool:
    host = hostname_from_url(url)
    if not host:
        parsed = urlparse(str(url or ""))
        if parsed.scheme in {"http", "https"}:
            return False
        return False
    return scope.covers_url(url)
