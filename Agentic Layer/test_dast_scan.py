import os
import sys
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

if "docker" not in sys.modules:
    docker_stub = types.ModuleType("docker")

    class _NotFound(Exception):
        pass

    docker_stub.errors = types.SimpleNamespace(NotFound=_NotFound)
    docker_stub.DockerClient = object
    sys.modules["docker"] = docker_stub

from dast_scan import dast_should_run, is_dast_only_run, is_module_only_run, validate_dast_target


class DastTargetValidationTests(unittest.TestCase):
    def test_rejects_empty_and_non_http(self):
        ok, error = validate_dast_target("")
        self.assertFalse(ok)
        self.assertIn("required", error.lower())
        ok, error = validate_dast_target("file:///etc/passwd")
        self.assertFalse(ok)
        self.assertIn("http", error.lower())

    def test_rejects_credentials_and_localhost(self):
        ok, _ = validate_dast_target("https://user:pass@example.com")
        self.assertFalse(ok)
        ok, _ = validate_dast_target("http://127.0.0.1/")
        self.assertFalse(ok)
        ok, _ = validate_dast_target("http://169.254.169.254/latest/meta-data")
        self.assertFalse(ok)
        ok, _ = validate_dast_target("https://localhost/app")
        self.assertFalse(ok)

    def test_accepts_public_ip(self):
        ok, error = validate_dast_target("https://1.1.1.1/health")
        self.assertTrue(ok, error)

    def test_rejects_unresolved_or_private_hostname(self):
        with patch("dast_agent.ssrf.socket.getaddrinfo", side_effect=OSError("nxdomain")):
            ok, error = validate_dast_target("https://does-not-resolve.invalid")
            self.assertFalse(ok)
            self.assertIn("resolved", error.lower())
        with patch("dast_agent.ssrf.socket.getaddrinfo", return_value=[(0, 0, 0, "", ("10.0.0.8", 0))]):
            ok, error = validate_dast_target("https://internal.example.com")
            self.assertFalse(ok)
            self.assertIn("public", error.lower())


class DastRunSelectionTests(unittest.TestCase):
    def test_url_enables_dast_even_when_module_list_omits_it(self):
        self.assertTrue(dast_should_run("https://staging.example.com"))
        self.assertFalse(dast_should_run(""))
        self.assertFalse(dast_should_run(None))

    def test_dast_only_requires_explicit_module_list(self):
        self.assertTrue(is_dast_only_run(["dast"], "https://staging.example.com"))
        self.assertTrue(is_module_only_run(["cloud"], "cloud"))
        self.assertFalse(is_dast_only_run(["sast", "dast"], "https://staging.example.com"))
        self.assertFalse(is_dast_only_run(None, "https://staging.example.com"))
        self.assertFalse(is_dast_only_run(["dast"], ""))


if __name__ == "__main__":
    unittest.main()
