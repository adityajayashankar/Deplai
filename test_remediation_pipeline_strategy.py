from __future__ import annotations

import os
import sys
import types
import unittest
from unittest.mock import patch


claude_stub = types.ModuleType("claude_remediator")
claude_stub._call_claude_sdk = lambda *args, **kwargs: (True, "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b")
sys.modules.setdefault("claude_remediator", claude_stub)

utils_stub = types.ModuleType("utils")
utils_stub.CODEBASE_VOLUME = "codebase"
utils_stub.decode_output = lambda value: value.decode() if isinstance(value, bytes) else str(value)
utils_stub.find_volume_file = lambda *args, **kwargs: None
utils_stub.get_docker_client = lambda *args, **kwargs: None
utils_stub.read_volume_file = lambda *args, **kwargs: None
utils_stub.resolve_host_projects_dir = lambda: None
utils_stub.set_current_project_id = lambda *args, **kwargs: None
sys.modules.setdefault("utils", utils_stub)

sys.path.insert(0, os.path.join(os.getcwd(), "Agentic Layer"))

from remediation_pipeline.models import FileGroup, Vulnerability
from remediation_pipeline.ingester import VulnIngester
from remediation_pipeline.orchestrator import RemediationOrchestrator


def make_vuln(vuln_id: str, severity: str, filepath: str, line: int, vuln_type: str = "sast") -> Vulnerability:
    return Vulnerability(
        id=vuln_id,
        file=filepath,
        line_start=line,
        line_end=line,
        rule_id=f"RULE-{vuln_id}",
        severity=severity,
        description=f"{severity} finding",
        package_name="lodash" if vuln_type == "sca" else None,
        fix_version="4.17.21" if vuln_type == "sca" else None,
        type=vuln_type,
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

    def test_large_repo_selection_skips_unsupported_lockfiles_and_caps_work(self) -> None:
        package_json = make_group(
            "package.json",
            "critical",
            [make_vuln(f"pkg-{idx}", "critical", "package.json", idx + 1) for idx in range(12)],
        )
        lockfile = make_group(
            "package-lock.json",
            "critical",
            [make_vuln(f"lock-{idx}", "critical", "package-lock.json", idx + 1, "sca") for idx in range(12)],
        )
        code_a = make_group(
            "src/a.py",
            "critical",
            [make_vuln(f"a-{idx}", "critical", "src/a.py", idx + 1) for idx in range(12)],
        )
        code_b = make_group(
            "src/b.py",
            "critical",
            [make_vuln(f"b-{idx}", "critical", "src/b.py", idx + 1) for idx in range(12)],
        )

        with patch.dict(os.environ, {
            "REMEDIATION_PIPELINE_MAX_GROUPS_LARGE": "2",
            "REMEDIATION_PIPELINE_MAX_VULNS_PER_GROUP_LARGE": "3",
        }, clear=False):
            selected = self.orchestrator._select_groups_for_run(
                [lockfile, code_b, package_json, code_a],
                {"strategy_mode": "critical_only", "strategy_reason": "large_repo"},
            )

        self.assertEqual([group.filepath for group in selected], ["package.json", "src/a.py"])
        self.assertEqual([len(group.vulns) for group in selected], [3, 3])

    def test_sca_lockfile_location_remaps_to_editable_package_manifest(self) -> None:
        ingester = VulnIngester()
        files = {
            "web/package.json": '{\n  "dependencies": {\n    "lodash": "^4.17.20"\n  }\n}\n',
            "web/package-lock.json": "{}\n",
        }
        ingester._read_repo_file = lambda _project_id, rel_path: files.get(rel_path, "")  # type: ignore[method-assign]

        path, line = ingester._infer_manifest_location(
            "project",
            {
                "artifact": {
                    "name": "lodash",
                    "type": "npm",
                    "locations": [{"path": "/repo/project/web/package-lock.json", "lineNumber": 1}],
                },
            },
            "lodash",
        )

        self.assertEqual(path, "web/package.json")
        self.assertEqual(line, 3)


if __name__ == "__main__":
    unittest.main()
