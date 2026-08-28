import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(__file__))

if "docker" not in sys.modules:
    docker_stub = types.ModuleType("docker")

    class _NotFound(Exception):
        pass

    docker_stub.errors = types.SimpleNamespace(NotFound=_NotFound)
    docker_stub.DockerClient = object
    sys.modules["docker"] = docker_stub

from cloud_scan import is_cloud_only_run, validate_cloud_scan_request


class CloudScanRequestTests(unittest.TestCase):
    def test_requires_keys_and_valid_region(self):
        ok, error, region = validate_cloud_scan_request("", "secret", "eu-north-1")
        self.assertFalse(ok)
        self.assertIn("credential", error.lower())
        ok, error, region = validate_cloud_scan_request("AKIA", "secret", "not-a-region")
        self.assertFalse(ok)
        ok, error, region = validate_cloud_scan_request("AKIA", "secret", "eu-north-1")
        self.assertTrue(ok, error)
        self.assertEqual(region, "eu-north-1")

    def test_prowler_uses_ocsf_json_not_removed_json_format(self):
        import inspect
        import cloud_scan as module
        source = inspect.getsource(module.run_cloud_scan)
        self.assertIn("json-ocsf", source)
        self.assertNotIn('--output-formats", "json"', source)
        self.assertIn("${STEM}.json", source)

    def test_cloud_only_requires_module_and_credentials(self):
        self.assertTrue(is_cloud_only_run(["cloud"], "AKIA", "secret"))
        self.assertFalse(is_cloud_only_run(["cloud"], "AKIA", ""))
        self.assertFalse(is_cloud_only_run(["sast", "cloud"], "AKIA", "secret"))


if __name__ == "__main__":
    unittest.main()
