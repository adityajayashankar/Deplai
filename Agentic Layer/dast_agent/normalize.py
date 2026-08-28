"""Standards-based DAST target URL normalization.

Parse with urllib (not regex). Reject credentials, exotic schemes, and
unexpected components before any network access.
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse, urlunparse

from dast_agent.codes import DAST_INVALID_TARGET, DAST_UNSAFE_TARGET

_ALLOWED_SCHEMES = {"https", "http"}
_BLOCKED_SCHEMES = {
    "file", "ftp", "gopher", "data", "javascript", "dict", "smb",
    "jar", "ws", "wss", "chrome", "about",
}
_MAX_URL_LEN = 2048
_BLOCKED_PORTS = {22, 25, 3306, 5432, 6379, 27017, 2375, 2376, 6443, 10250}


@dataclass(frozen=True)
class NormalizedTarget:
    raw: str
    url: str
    scheme: str
    hostname: str
    port: int | None
    path: str
    ok: bool
    code: str
    message: str


def _idna_hostname(host: str) -> str | None:
    cleaned = str(host or "").strip().rstrip(".").lower()
    if not cleaned:
        return None
    try:
        return cleaned.encode("idna").decode("ascii")
    except (UnicodeError, ValueError):
        return None


def normalize_target(url: str, *, allow_http: bool = True) -> NormalizedTarget:
    raw = str(url or "").strip()
    if not raw:
        return NormalizedTarget(raw, "", "", "", None, "", False, DAST_INVALID_TARGET, "A target URL is required for dynamic testing.")
    if len(raw) > _MAX_URL_LEN:
        return NormalizedTarget(raw, "", "", "", None, "", False, DAST_INVALID_TARGET, "Target URL is too long.")
    if "\\" in raw or raw.startswith("//"):
        return NormalizedTarget(raw, "", "", "", None, "", False, DAST_INVALID_TARGET, "Target URL is malformed.")

    parsed = urlparse(raw)
    scheme = (parsed.scheme or "").lower()
    if scheme in _BLOCKED_SCHEMES or (scheme and scheme not in _ALLOWED_SCHEMES):
        return NormalizedTarget(raw, "", scheme, "", None, "", False, DAST_INVALID_TARGET, "Dynamic testing only accepts http or https targets.")
    if scheme == "http" and not allow_http:
        return NormalizedTarget(raw, "", scheme, "", None, "", False, DAST_INVALID_TARGET, "HTTP targets are disabled. Use https.")
    if scheme not in _ALLOWED_SCHEMES:
        return NormalizedTarget(raw, "", scheme, "", None, "", False, DAST_INVALID_TARGET, "Dynamic testing only accepts http or https targets.")
    if parsed.username or parsed.password:
        return NormalizedTarget(raw, "", scheme, "", None, "", False, DAST_UNSAFE_TARGET, "Target URL must not include credentials.")
    if parsed.params:
        return NormalizedTarget(raw, "", scheme, "", None, "", False, DAST_INVALID_TARGET, "Target URL contains unsupported components.")

    host = _idna_hostname(parsed.hostname or "")
    if not host:
        return NormalizedTarget(raw, "", scheme, "", None, "", False, DAST_INVALID_TARGET, "Target URL is missing a hostname.")

    port = parsed.port
    if port in _BLOCKED_PORTS:
        return NormalizedTarget(raw, "", scheme, host, port, "", False, DAST_UNSAFE_TARGET, "Target port is not allowed for dynamic testing.")
    if port is not None and (port < 1 or port > 65535):
        return NormalizedTarget(raw, "", scheme, host, port, "", False, DAST_INVALID_TARGET, "Target port is invalid.")

    path = parsed.path or "/"
    normalized = urlunparse((scheme, parsed.netloc.lower(), path, "", parsed.query, ""))
    return NormalizedTarget(
        raw=raw,
        url=normalized,
        scheme=scheme,
        hostname=host,
        port=port,
        path=path,
        ok=True,
        code="",
        message="",
    )


def hostname_from_url(url: str) -> str:
    parsed = urlparse(str(url or "").strip())
    return _idna_hostname(parsed.hostname or "") or ""
