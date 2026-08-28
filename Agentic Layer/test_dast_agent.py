"""Security tests for the DAST authorization, SSRF, scope, and LangGraph gates."""

from __future__ import annotations

import os
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(__file__))

os.environ.setdefault("DAST_AUTHZ_SECRET", "test-dast-authz-secret")
os.environ.setdefault("DEPLAI_SERVICE_KEY", "test-dast-authz-secret")

if "docker" not in sys.modules:
    docker_stub = types.ModuleType("docker")

    class _NotFound(Exception):
        pass

    docker_stub.errors = types.SimpleNamespace(NotFound=_NotFound)
    docker_stub.DockerClient = object
    sys.modules["docker"] = docker_stub

from dast_agent.authorization import authorize_target, sign_grant
from dast_agent.codes import (
    DAST_DNS_REBINDING_BLOCKED,
    DAST_DOMAIN_NOT_VERIFIED,
    DAST_PRIVATE_IP_BLOCKED,
    DAST_REDIRECT_OUT_OF_SCOPE,
    DAST_TARGET_NOT_AUTHORIZED,
    DAST_TARGET_OUTSIDE_SCOPE,
    DAST_VERIFICATION_REVOKED,
    SCOPE_DOMAIN,
    SCOPE_HOST,
)
from dast_agent.normalize import normalize_target
from dast_agent.ownership import token_hash, verify_dns, verify_http
from dast_agent.scope import is_hostname_in_domain, scope_from_asset
from dast_agent.ssrf import inspect_outbound_target, revalidate_resolution, validate_redirect_hop
from dast_scan import run_dast_scan, validate_dast_target


def _grant(**overrides):
    now = datetime.now(timezone.utc)
    payload = {
        "asset_id": "asset-1",
        "project_id": "proj-1",
        "hostname": "app.example.com",
        "scope_mode": SCOPE_HOST,
        "status": "VERIFIED",
        "verification_expires_at": (now + timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "issued_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "grant_expires_at": (now + timedelta(minutes=15)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "policy_version": "2026.08.1",
        "verification_method": "DNS_TXT",
        "scheme": "https",
    }
    payload.update(overrides)
    payload["signature"] = sign_grant(payload)
    return payload


def _public_dns(host="1.1.1.1"):
    return [(0, 0, 0, "", (host, 0))]


class NormalizeTests(unittest.TestCase):
    def test_rejects_credentials_and_schemes(self):
        self.assertFalse(normalize_target("https://user:pass@example.com").ok)
        self.assertFalse(normalize_target("file:///etc/passwd").ok)
        self.assertFalse(normalize_target("javascript:alert(1)").ok)

    def test_idna_and_lowercase(self):
        target = normalize_target("https://APP.EXAMPLE.COM/Login")
        self.assertTrue(target.ok)
        self.assertEqual(target.hostname, "app.example.com")


class ScopeTests(unittest.TestCase):
    def test_label_aware_domain_match(self):
        self.assertTrue(is_hostname_in_domain("app.example.com", "example.com"))
        self.assertTrue(is_hostname_in_domain("example.com", "example.com"))
        self.assertFalse(is_hostname_in_domain("evil-example.com", "example.com"))
        self.assertFalse(is_hostname_in_domain("example.com.attacker.com", "example.com"))

    def test_verified_host_does_not_authorize_siblings(self):
        scope = scope_from_asset(hostname="app.example.com", scheme="https", scope_mode=SCOPE_HOST)
        self.assertTrue(scope.covers_url("https://app.example.com/login"))
        self.assertFalse(scope.covers_url("https://admin.example.com/"))
        self.assertFalse(scope.covers_url("https://example.com/"))
        self.assertFalse(scope.covers_url("https://other-domain.com/"))

    def test_verified_domain_allows_subdomains_only(self):
        scope = scope_from_asset(hostname="example.com", scheme="https", scope_mode=SCOPE_DOMAIN)
        self.assertTrue(scope.covers_url("https://app.example.com/"))
        self.assertTrue(scope.covers_url("https://api.example.com/users"))
        self.assertFalse(scope.covers_url("https://evil-example.com/"))
        self.assertFalse(scope.covers_url("https://example.com.attacker.com/"))


class SsrfTests(unittest.TestCase):
    def test_blocks_private_and_metadata(self):
        self.assertFalse(validate_dast_target("http://127.0.0.1/")[0])
        self.assertFalse(validate_dast_target("http://169.254.169.254/latest/meta-data")[0])
        self.assertFalse(validate_dast_target("https://localhost/app")[0])
        self.assertIn("DAST_PRIVATE_IP_BLOCKED", inspect_outbound_target("https://10.0.0.5/").code)

    def test_blocks_decimal_loopback(self):
        check = inspect_outbound_target("https://2130706433/")
        self.assertFalse(check.ok)
        self.assertEqual(check.code, DAST_PRIVATE_IP_BLOCKED)

    def test_http_blocked_unless_enabled(self):
        with patch.dict(os.environ, {"DAST_ALLOW_HTTP": "false"}):
            check = inspect_outbound_target("http://1.1.1.1/")
            self.assertFalse(check.ok)
        with patch.dict(os.environ, {"DAST_ALLOW_HTTP": "true"}):
            check = inspect_outbound_target("http://1.1.1.1/")
            self.assertTrue(check.ok)

    def test_accepts_public_ip(self):
        ok, error = validate_dast_target("https://1.1.1.1/health")
        self.assertTrue(ok, error)

    def test_dns_rebinding_pin(self):
        with patch("dast_agent.ssrf.socket.getaddrinfo", return_value=_public_dns("1.1.1.1")):
            first = inspect_outbound_target("https://app.example.com")
            self.assertTrue(first.ok)
        with patch("dast_agent.ssrf.socket.getaddrinfo", return_value=_public_dns("10.0.0.8")):
            later = revalidate_resolution("https://app.example.com", first.resolved_ips)
            self.assertFalse(later.ok)
            self.assertEqual(later.code, DAST_DNS_REBINDING_BLOCKED)

    def test_redirect_to_loopback_blocked(self):
        scope = scope_from_asset(hostname="app.example.com", scheme="https", scope_mode=SCOPE_HOST)
        with patch("dast_agent.ssrf.socket.getaddrinfo", return_value=_public_dns()):
            hop = validate_redirect_hop(
                "https://app.example.com/",
                "https://127.0.0.1/",
                scope,
                max_redirects=3,
                hop_index=0,
            )
        self.assertFalse(hop.ok)
        self.assertEqual(hop.code, DAST_REDIRECT_OUT_OF_SCOPE)


class AuthorizationTests(unittest.TestCase):
    def test_google_blocked_without_grant(self):
        with patch("dast_agent.ssrf.socket.getaddrinfo", return_value=_public_dns("8.8.8.8")):
            result = authorize_target(project_id="proj-1", requested_target="https://google.com", grant=None)
        self.assertFalse(result.authorized)
        self.assertEqual(result.code, DAST_TARGET_NOT_AUTHORIZED)

    def test_unverified_domain_blocked(self):
        grant = _grant(status="PENDING", hostname="mycompany.example")
        with patch("dast_agent.ssrf.socket.getaddrinfo", return_value=_public_dns()):
            result = authorize_target(
                project_id="proj-1",
                requested_target="https://mycompany.example",
                grant=grant,
            )
        self.assertFalse(result.authorized)
        self.assertEqual(result.code, DAST_DOMAIN_NOT_VERIFIED)

    def test_verified_host_allows_exact_target(self):
        grant = _grant()
        with patch("dast_agent.ssrf.socket.getaddrinfo", return_value=_public_dns()):
            result = authorize_target(
                project_id="proj-1",
                requested_target="https://app.example.com/login",
                grant=grant,
            )
        self.assertTrue(result.authorized, result.message)

    def test_verified_domain_allows_subdomain(self):
        grant = _grant(hostname="mycompany.example", scope_mode=SCOPE_DOMAIN)
        with patch("dast_agent.ssrf.socket.getaddrinfo", return_value=_public_dns()):
            result = authorize_target(
                project_id="proj-1",
                requested_target="https://app.mycompany.example",
                grant=grant,
            )
        self.assertTrue(result.authorized, result.message)

    def test_revocation_blocks_next_scan(self):
        grant = _grant()
        with patch("dast_agent.ssrf.socket.getaddrinfo", return_value=_public_dns()):
            result = authorize_target(
                project_id="proj-1",
                requested_target="https://app.example.com",
                grant=grant,
                live_asset={"status": "REVOKED", "revoked_at": "2026-08-27T00:00:00Z", "hostname": "app.example.com", "scope_mode": SCOPE_HOST},
            )
        self.assertFalse(result.authorized)
        self.assertEqual(result.code, DAST_VERIFICATION_REVOKED)

    def test_out_of_scope_sibling_blocked(self):
        grant = _grant()
        with patch("dast_agent.ssrf.socket.getaddrinfo", return_value=_public_dns()):
            result = authorize_target(
                project_id="proj-1",
                requested_target="https://other-domain.com",
                grant=grant,
            )
        self.assertFalse(result.authorized)
        self.assertEqual(result.code, DAST_TARGET_OUTSIDE_SCOPE)

    def test_discovered_cdn_url_is_out_of_host_scope(self):
        from dast_agent.scope import discovered_url_in_scope, scope_from_asset
        scope = scope_from_asset(hostname="app.example.com", scheme="https", scope_mode=SCOPE_HOST)
        self.assertFalse(discovered_url_in_scope("https://other-domain.com/app.js", scope))
        self.assertTrue(discovered_url_in_scope("https://app.example.com/login", scope))


class OwnershipTests(unittest.TestCase):
    def test_dns_txt_match(self):
        token = "abc123token"
        with patch("dast_agent.ownership.inspect_outbound_target") as inspect:
            inspect.return_value.ok = True
            inspect.return_value.code = ""
            inspect.return_value.message = ""
            with patch("dast_agent.ownership.query_txt_records", return_value=[f"deplai-domain-verification={token}"]):
                result = verify_dns("example.com", token_hash(token))
        self.assertTrue(result.ok)

    def test_http_body_match(self):
        token = "abc123token"
        response = MagicMock()
        response.status_code = 200
        response.headers = {}
        response.text = f"deplai-domain-verification={token}"
        with patch("dast_agent.ownership.inspect_outbound_target") as inspect:
            inspect.return_value.ok = True
            inspect.return_value.code = ""
            inspect.return_value.message = ""
            inspect.return_value.normalized.url = "https://app.example.com/.well-known/deplai-verification/abc123token"
            inspect.return_value.normalized.hostname = "app.example.com"
            inspect.return_value.normalized.scheme = "https"
            with patch("dast_agent.ownership._http_get_no_follow", return_value=response):
                result = verify_http("app.example.com", token, token_hash(token))
        self.assertTrue(result.ok, result.message)


class ZapNeverStartsUnauthorizedTests(unittest.TestCase):
    def test_run_dast_scan_does_not_start_zap_for_google(self):
        with patch("dast_agent.ssrf.socket.getaddrinfo", return_value=_public_dns("8.8.8.8")):
            with patch("dast_agent.scanner.get_docker_client") as docker:
                ok, error = run_dast_scan("demo", "proj-1", "https://google.com")
        self.assertFalse(ok)
        self.assertIn(DAST_TARGET_NOT_AUTHORIZED, error)
        docker.assert_not_called()

    def test_authorized_path_invokes_graph_not_raw_url(self):
        grant = _grant()
        context = types.SimpleNamespace(
            project_id="proj-1",
            project_name="demo",
            user_id="user-1",
            dast_authorization=grant,
            dast_scan_id="scan-1",
            dast_scan_profile="BASELINE",
            dast_scan_intent="PASSIVE",
            dast_api_spec_url="",
        )
        with patch("dast_agent.ssrf.socket.getaddrinfo", return_value=_public_dns()):
            with patch("dast_agent.service.fetch_live_asset", return_value={"status": "VERIFIED", "hostname": "app.example.com", "scope_mode": SCOPE_HOST, "scheme": "https"}):
                with patch("dast_agent.scanner.ZapScanner.start", return_value=(True, "")):
                    with patch("dast_agent.scanner.ZapScanner.collect_results", return_value=(True, "")):
                        with patch("dast_agent.scanner.ZapScanner.cleanup"):
                            with patch("dast_agent.nodes.find_volume_file", return_value=None):
                                with patch("dast_agent.nodes.read_volume_file", return_value=None):
                                    ok, error = run_dast_scan("demo", "proj-1", "https://app.example.com", context=context)
        self.assertTrue(ok, error)


if __name__ == "__main__":
    unittest.main()
