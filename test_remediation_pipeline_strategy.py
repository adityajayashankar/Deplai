from __future__ import annotations

import os
import sys
import types
import unittest
from unittest.mock import patch


claude_stub = types.ModuleType("claude_remediator")
claude_stub._call_claude_sdk = lambda *args, **kwargs: (True, "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b")
sys.modules.setdefault("claude_remediator", claude_stub)

sys.path.insert(0, os.path.join(os.getcwd(), "Agentic Layer"))

from remediation_pipeline.models import FileGroup, Vulnerability
from remediation_pipeline.orchestrator import RemediationOrchestrator


def make_vuln(vuln_id: str, severity: str, filepath: str, line: int) -> Vulnerability:
    return Vulnerability(
        id=vuln_id,
        file=filepath,
        line_start=line,
        line_end=line,
        rule_id=f"RULE-{vuln_id}",
        severity=severity,
        description=f"{severity} finding",
        type="sast",
    )


def make_group(filepath: str, severity: str, vulns: list[Vulnerability]) -> FileGroup:
    return FileGroup(
        filepath=filepath,
        language="Python",
        vulns=vulns,
        max_severity=severity,
    )


class RemediationPipelineStrategyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.orchestrator = RemediationOrchestrator.__new__(RemediationOrchestrator)

    def test_large_repo_processes_critical_before_high(self) -> None:
        critical = make_vuln("c1", "critical", "a.py", 10)
        high = make_vuln("h1", "high", "b.py", 20)
        medium = make_vuln("m1", "medium", "c.py", 30)
        groups = [
            make_group("a.py", "critical", [critical]),
            make_group("b.py", "high", [high]),
            make_group("c.py", "medium", [medium]),
        ]

        with patch.dict(os.environ, {"REMEDIATION_LARGE_FINDING_THRESHOLD": "2"}, clear=False):
            snapshot = self.orchestrator._build_snapshot(
                [critical, high, medium],
                groups,
                remediation_scope="all",
            )

        self.assertEqual(snapshot["strategy_mode"], "critical_only")
        self.assertEqual(snapshot["strategy_reason"], "large_repo")
        self.assertEqual(snapshot["selected_groups"], 1)
        self.assertEqual(snapshot["selected_findings"], 1)
        self.assertEqual(snapshot["selected_severity"], "critical")
        self.assertTrue(snapshot["stop_after_major"])
        self.assertTrue(snapshot["force_claude"])

    def test_large_repo_falls_back_to_high_after_critical_is_clear(self) -> None:
        high_a = make_vuln("h1", "high", "a.py", 10)
        high_b = make_vuln("h2", "high", "b.py", 20)
        low = make_vuln("l1", "low", "c.py", 30)
        groups = [
            make_group("a.py", "high", [high_a]),
            make_group("b.py", "high", [high_b]),
            make_group("c.py", "low", [low]),
        ]

        with patch.dict(os.environ, {"REMEDIATION_LARGE_FINDING_THRESHOLD": "2"}, clear=False):
            snapshot = self.orchestrator._build_snapshot(
                [high_a, high_b, low],
                groups,
                remediation_scope="all",
            )

        self.assertEqual(snapshot["strategy_mode"], "high_only")
        self.assertEqual(snapshot["selected_groups"], 2)
        self.assertEqual(snapshot["selected_findings"], 2)
        self.assertEqual(snapshot["selected_severity"], "high")
        self.assertTrue(snapshot["force_claude"])

    def test_major_scope_stops_when_only_medium_and_low_remain(self) -> None:
        medium = make_vuln("m1", "medium", "a.py", 10)
        low = make_vuln("l1", "low", "b.py", 20)
        groups = [
            make_group("a.py", "medium", [medium]),
            make_group("b.py", "low", [low]),
        ]

        with patch.dict(os.environ, {"REMEDIATION_LARGE_FINDING_THRESHOLD": "1000"}, clear=False):
            snapshot = self.orchestrator._build_snapshot(
                [medium, low],
                groups,
                remediation_scope="major",
            )

        self.assertEqual(snapshot["strategy_mode"], "major_complete")
        self.assertEqual(snapshot["strategy_reason"], "scope_major")
        self.assertEqual(snapshot["selected_groups"], 0)
        self.assertEqual(snapshot["selected_findings"], 0)
        self.assertTrue(snapshot["stop_after_major"])
        self.assertFalse(snapshot["force_claude"])

    def test_select_groups_for_run_matches_active_stage(self) -> None:
        critical = make_group("a.py", "critical", [make_vuln("c1", "critical", "a.py", 10)])
        high = make_group("b.py", "high", [make_vuln("h1", "high", "b.py", 10)])
        medium = make_group("c.py", "medium", [make_vuln("m1", "medium", "c.py", 10)])
        groups = [critical, high, medium]

        critical_selected = self.orchestrator._select_groups_for_run(groups, {"strategy_mode": "critical_only"})
        high_selected = self.orchestrator._select_groups_for_run(groups, {"strategy_mode": "high_only"})
        default_selected = self.orchestrator._select_groups_for_run(groups, {"strategy_mode": "default"})

        self.assertEqual([group.filepath for group in critical_selected], ["a.py"])
        self.assertEqual([group.filepath for group in high_selected], ["b.py"])
        self.assertEqual([group.filepath for group in default_selected], ["a.py", "b.py", "c.py"])


if __name__ == "__main__":
    unittest.main()
