import unittest

from remediation_pipeline.generator import FixGenerator
from remediation_pipeline.models import Vulnerability
from remediation_pipeline.supervisor_bridge import supervisor_result_to_fixes


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
