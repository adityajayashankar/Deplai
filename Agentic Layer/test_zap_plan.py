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

from dast_agent.codes import PROFILE_API, PROFILE_BASELINE, PROFILE_FULL
from dast_agent.scope import DastScope
from dast_agent.zap_plan import build_zap_plan


def _scope() -> DastScope:
    return DastScope(
        hostname="api.example.com",
        scheme="https",
        scope_mode="VERIFIED_HOST",
        excluded_paths=[],
    )


class ZapPlanTests(unittest.TestCase):
    def test_baseline_is_passive(self):
        plan = build_zap_plan(
            target_url="https://api.example.com",
            report_filename="Dast.json",
            profile=PROFILE_BASELINE,
            scope=_scope(),
        )
        jobs = [job["type"] for job in plan["jobs"]]
        self.assertIn("spider", jobs)
        self.assertNotIn("activeScan", jobs)
        self.assertNotIn("openapi", jobs)

    def test_full_adds_active_scan(self):
        plan = build_zap_plan(
            target_url="https://api.example.com",
            report_filename="Dast.json",
            profile=PROFILE_FULL,
            scope=_scope(),
        )
        self.assertIn("activeScan", [job["type"] for job in plan["jobs"]])

    def test_api_profile_imports_spec_and_active_scans(self):
        plan = build_zap_plan(
            target_url="https://api.example.com",
            report_filename="Dast.json",
            profile=PROFILE_API,
            scope=_scope(),
            api_spec_url="https://api.example.com/openapi.json",
        )
        jobs = plan["jobs"]
        self.assertEqual(jobs[0]["type"], "openapi")
        self.assertEqual(jobs[0]["parameters"]["apiUrl"], "https://api.example.com/openapi.json")
        self.assertIn("activeScan", [job["type"] for job in jobs])


if __name__ == "__main__":
    unittest.main()
