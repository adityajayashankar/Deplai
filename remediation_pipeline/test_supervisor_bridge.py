import asyncio
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from remediation_pipeline.generator import FixGenerator
from remediation_pipeline.models import Vulnerability
from remediation_pipeline.supervisor_bridge import (
    _is_context_limit_failure,
    run_supervised_remediation,
    supervisor_result_to_fixes,
)


class SafeManifestBumpTests(unittest.TestCase):
    def test_same_major_is_safe(self):
        self.assertTrue(FixGenerator._is_safe_manifest_bump("0.26.0", "0.32.0"))

    def test_major_jump_is_unsafe(self):
        self.assertFalse(FixGenerator._is_safe_manifest_bump("12.1.0", "15.5.21"))

    def test_package_json_skips_unsafe_major_bumps(self):
        source = '{\n  "dependencies": {\n    "next": "^12.1.0",\n    "axios": "^0.26.0"\n  }\n}\n'
        vulns = [
            Vulnerability(
                id="v1",
                file="package.json",
                line_start=1,
                line_end=1,
                rule_id="cve-next",
                severity="high",
                description="next CVE",
                package_name="next",
                installed_version="12.1.0",
                fix_version="15.5.21",
                type="sca",
            ),
            Vulnerability(
                id="v2",
                file="package.json",
                line_start=1,
                line_end=1,
                rule_id="cve-axios",
                severity="high",
                description="axios CVE",
                package_name="axios",
                installed_version="0.26.0",
                fix_version="0.32.0",
                type="sca",
            ),
        ]
        updated = FixGenerator._patch_package_json(source, vulns)
        self.assertIn('"axios": "^0.32.0"', updated)
        self.assertIn('"next": "^12.1.0"', updated)


class SupervisorBridgeTests(unittest.TestCase):
    def test_context_limit_isolated_from_other_remediation_packets(self):
        self.assertTrue(_is_context_limit_failure("ValueError: CONTEXT_LIMIT: source window exceeds packet budget"))
        self.assertFalse(_is_context_limit_failure("Provider authentication failed"))

    def test_context_limited_packet_does_not_stop_following_packets(self):
        scan_data = {
            "code_security": [
                {"severity": "critical", "root_cause_key": "first", "occurrences": [{"filename": "a.py", "line_number": 1}]},
                {"severity": "critical", "root_cause_key": "second", "occurrences": [{"filename": "b.py", "line_number": 1}]},
                {"severity": "medium", "root_cause_key": "ignored", "occurrences": [{"filename": "ignored.py", "line_number": 1}]},
            ],
            "supply_chain": [],
        }
        patch_result = {
            "summary": "Fixed the second packet.",
            "critic_verdict": "accept",
            "critic_score": 100,
            "changed_files": [{"path": "b.py", "diff": "--- a/b.py\n+++ b/b.py\n@@\n", "vulns_addressed": ["second"]}],
        }

        async def execute():
            with (
                patch("result_parser.get_scan_results", return_value=(True, scan_data)),
                patch(
                    "agent.run_remediation_workflow",
                    new=AsyncMock(side_effect=[
                        (False, "ValueError: CONTEXT_LIMIT: source window exceeds packet budget"),
                        (True, patch_result),
                    ]),
                ) as workflow,
            ):
                fixes = await run_supervised_remediation(
                    "context-limit-project",
                    "all",
                    remediation_run_id=f"context-limit-run-{uuid4()}",
                )
                self.assertEqual(workflow.await_count, 2)
                return fixes

        fixes = asyncio.run(execute())
        self.assertEqual([fix.filepath for fix in fixes], ["b.py"])

    def test_packet_environment_cannot_exceed_slice_limit(self):
        from unittest.mock import patch
        from remediation_pipeline.supervisor_bridge import _max_supervisor_batches
        with patch.dict('os.environ', {'REMEDIATION_SUPERVISOR_MAX_PACKETS': '100'}):
            self.assertEqual(_max_supervisor_batches(), 8)

    def test_patch_paths_reject_absolute_traversal_and_git_metadata(self):
        from remediation_pipeline.orchestrator import RemediationOrchestrator
        for path in ('/etc/passwd', '../app.py', 'C:/app.py', '.git/config', 'src/../../secret', 'src/evil\x00.py'):
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                RemediationOrchestrator._normalize_relative_path(path)
        self.assertEqual(RemediationOrchestrator._normalize_relative_path('src/auth.py'), 'src/auth.py')

    def test_supervisor_result_marks_low_quality_as_review(self):
        fixes = supervisor_result_to_fixes(
            {
                "summary": "test",
                "critic_verdict": "reject",
                "critic_score": 4,
                "changed_files": [
                    {"path": "package.json", "diff": "--- a/package.json\n+++ b/package.json\n@@\n", "reason": "sca"},
                ],
            },
            min_score=6,
        )
        self.assertEqual(len(fixes), 1)
        self.assertEqual(fixes[0].status, "needs_review")
        self.assertEqual(fixes[0].provider_used, "supervisor")

    def test_supervisor_result_accepts_high_quality(self):
        fixes = supervisor_result_to_fixes(
            {
                "summary": "ok",
                "critic_verdict": "accept",
                "critic_score": 8,
                "changed_files": [
                    {
                        "path": "src/auth.ts",
                        "diff": "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@\n",
                        "reason": "sast",
                        "vulns_addressed": ["CWE-79"],
                    },
                ],
            },
            min_score=6,
        )
        self.assertEqual(fixes[0].status, "auto")
        self.assertEqual(fixes[0].vulns_addressed, ["CWE-79"])


if __name__ == "__main__":
    unittest.main()
