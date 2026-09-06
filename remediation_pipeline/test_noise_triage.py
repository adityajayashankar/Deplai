from __future__ import annotations

import unittest

from remediation_pipeline.models import Vulnerability
from remediation_pipeline.noise_triage import apply_heuristic_noise_triage, filter_by_remediation_scope


def _vuln(**kwargs) -> Vulnerability:
    defaults = {
        "id": "v1",
        "file": "src/app.py",
        "line_start": 1,
        "line_end": 1,
        "rule_id": "sql-injection",
        "severity": "high",
        "description": "SQL injection risk",
        "type": "sast",
    }
    defaults.update(kwargs)
    return Vulnerability(**defaults)


class NoiseTriageTests(unittest.TestCase):
    def test_critical_high_policy_ignores_medium_low_even_for_legacy_all_scope(self) -> None:
        kept, ignored = filter_by_remediation_scope([
            _vuln(id="critical", severity="critical"),
            _vuln(id="high", severity="high"),
            _vuln(id="medium", severity="medium"),
            _vuln(id="low", severity="low"),
        ], "all")
        self.assertEqual([vuln.id for vuln in kept], ["critical", "high"])
        self.assertEqual(ignored, 2)

    def test_ignores_node_modules_findings(self) -> None:
        result = apply_heuristic_noise_triage([
            _vuln(file="node_modules/lodash/index.js", severity="high"),
            _vuln(file="src/db.py"),
        ])
        self.assertEqual(len(result.keep), 1)
        self.assertEqual(result.keep[0].file, "src/db.py")
        self.assertEqual(result.heuristic_ignored, 1)

    def test_ignores_test_paths(self) -> None:
        result = apply_heuristic_noise_triage([
            _vuln(file="tests/test_auth.py", severity="medium"),
            _vuln(file="src/auth.py", severity="medium"),
        ])
        self.assertEqual(len(result.keep), 1)
        self.assertEqual(result.keep[0].file, "src/auth.py")

    def test_ignores_scanner_self_packages(self) -> None:
        result = apply_heuristic_noise_triage([
            _vuln(
                id="sca-grype",
                file="package-lock.json",
                rule_id="CVE-TEST",
                severity="medium",
                description="grype",
                type="sca",
                package_name="grype",
            ),
            _vuln(
                id="sca-app",
                file="package.json",
                rule_id="CVE-REAL",
                severity="high",
                description="real vuln",
                type="sca",
                package_name="express",
                fix_version="4.21.0",
            ),
        ])
        self.assertEqual(len(result.keep), 1)
        self.assertEqual(result.keep[0].id, "sca-app")

    def test_keeps_critical_even_in_docs(self) -> None:
        result = apply_heuristic_noise_triage([
            _vuln(file="docs/README.md", severity="critical", description="hardcoded secret"),
        ])
        self.assertEqual(len(result.keep), 1)


if __name__ == "__main__":
    unittest.main()
