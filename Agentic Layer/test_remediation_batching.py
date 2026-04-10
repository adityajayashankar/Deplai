from __future__ import annotations

import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(__file__))

if "agent" not in sys.modules:
    agent_stub = types.ModuleType("agent")
    agent_stub.run_analysis_agent = lambda *args, **kwargs: {}
    agent_stub.run_remediation_supervisor = lambda *args, **kwargs: (True, {})
    sys.modules["agent"] = agent_stub

if "Analysis" not in sys.modules:
    analysis_pkg = types.ModuleType("Analysis")
    analysis_pkg.__path__ = []
    sys.modules["Analysis"] = analysis_pkg

if "Analysis.dataingestor" not in sys.modules:
    dataingestor_stub = types.ModuleType("Analysis.dataingestor")
    dataingestor_stub.get_scan_results = lambda *args, **kwargs: {}
    sys.modules["Analysis.dataingestor"] = dataingestor_stub

if "bearer" not in sys.modules:
    bearer_stub = types.ModuleType("bearer")
    bearer_stub.run_bearer_scan = lambda *args, **kwargs: (True, "")
    sys.modules["bearer"] = bearer_stub

if "claude_remediator" not in sys.modules:
    claude_stub = types.ModuleType("claude_remediator")

    class ClaudeBudgetTracker:
        def __init__(self) -> None:
            self.total_usd = 0.0
            self.budget_cap_usd = 1.0

    claude_stub.ClaudeBudgetTracker = ClaudeBudgetTracker
    claude_stub.run_claude_remediation = lambda *args, **kwargs: (True, {})
    sys.modules["claude_remediator"] = claude_stub

if "models" not in sys.modules:
    models_stub = types.ModuleType("models")

    class RemediationRequest:  # pragma: no cover - import stub
        pass

    class StreamStatus:  # pragma: no cover - import stub
        running = "running"

    class WebSocketCommand:  # pragma: no cover - import stub
        action = ""

    models_stub.RemediationRequest = RemediationRequest
    models_stub.StreamStatus = StreamStatus
    models_stub.WebSocketCommand = WebSocketCommand
    sys.modules["models"] = models_stub

if "result_parser" not in sys.modules:
    result_parser_stub = types.ModuleType("result_parser")
    result_parser_stub.invalidate_cache = lambda *args, **kwargs: None
    sys.modules["result_parser"] = result_parser_stub

if "runner_base" not in sys.modules:
    runner_base_stub = types.ModuleType("runner_base")

    class RunnerBase:  # pragma: no cover - import stub
        def __init__(self, *args, **kwargs) -> None:
            pass

    runner_base_stub.RunnerBase = RunnerBase
    sys.modules["runner_base"] = runner_base_stub

if "sbom" not in sys.modules:
    sbom_stub = types.ModuleType("sbom")
    sbom_stub.run_grype_scan = lambda *args, **kwargs: (True, "")
    sbom_stub.run_syft_scan = lambda *args, **kwargs: (True, "")
    sys.modules["sbom"] = sbom_stub

if "utils" not in sys.modules:
    utils_stub = types.ModuleType("utils")
    utils_stub.CODEBASE_VOLUME = "codebase"
    utils_stub.LLM_OUTPUT_VOLUME = "llm-output"
    utils_stub.decode_output = lambda *args, **kwargs: ""
    utils_stub.get_docker_client = lambda *args, **kwargs: None
    utils_stub.redact_git_token = lambda value: value
    utils_stub.resolve_host_projects_dir = lambda: None
    utils_stub.set_current_project_id = lambda *args, **kwargs: None
    sys.modules["utils"] = utils_stub

import remediation


def _code_finding(index: int) -> dict:
    return {
        "cwe_id": str(100 + index),
        "severity": "high",
        "title": f"finding-{index}",
        "description": "test finding",
        "count": 1,
        "occurrences": [{"filename": f"src/file_{index}.py"}],
    }


def _supply_finding(index: int) -> dict:
    return {
        "cve_id": f"CVE-2026-{index:04d}",
        "severity": "high",
        "package": f"pkg-{index}",
        "installed_version": "1.0.0",
        "fix_version": "1.0.1",
    }


class RemediationBatchingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.old_code_batch = remediation.REMEDIATION_CODE_ROOT_CAUSES_PER_BATCH
        self.old_supply_batch = remediation.REMEDIATION_SUPPLY_ROOT_CAUSES_PER_BATCH
        self.old_max_batches = remediation.REMEDIATION_MAX_BATCHES_PER_CYCLE
        self.old_large_threshold = remediation.REMEDIATION_LARGE_FINDING_THRESHOLD

    def tearDown(self) -> None:
        remediation.REMEDIATION_CODE_ROOT_CAUSES_PER_BATCH = self.old_code_batch
        remediation.REMEDIATION_SUPPLY_ROOT_CAUSES_PER_BATCH = self.old_supply_batch
        remediation.REMEDIATION_MAX_BATCHES_PER_CYCLE = self.old_max_batches
        remediation.REMEDIATION_LARGE_FINDING_THRESHOLD = self.old_large_threshold

    def test_splits_large_root_cause_queue_into_multiple_batches(self) -> None:
        remediation.REMEDIATION_CODE_ROOT_CAUSES_PER_BATCH = 2
        remediation.REMEDIATION_SUPPLY_ROOT_CAUSES_PER_BATCH = 2
        remediation.REMEDIATION_MAX_BATCHES_PER_CYCLE = 4

        scan_data = {
            "code_security": [_code_finding(i) for i in range(5)],
            "supply_chain": [_supply_finding(i) for i in range(5)],
        }

        batches = remediation._build_remediation_batches(scan_data, "all")

        self.assertEqual(len(batches), 3)
        self.assertEqual(
            [len(batch["code_security"]) for batch, _ in batches],
            [2, 2, 1],
        )
        self.assertEqual(
            [len(batch["supply_chain"]) for batch, _ in batches],
            [2, 2, 1],
        )
        self.assertEqual(batches[0][1]["code_root_causes_selected"], 5)
        self.assertEqual(batches[0][1]["supply_root_causes_selected"], 5)
        self.assertEqual(batches[0][1]["batch_total"], 3)
        self.assertEqual(batches[0][1]["selection_mode"], "root_cause_deduped_chunked")

    def test_caps_number_of_batches_per_cycle(self) -> None:
        remediation.REMEDIATION_CODE_ROOT_CAUSES_PER_BATCH = 1
        remediation.REMEDIATION_SUPPLY_ROOT_CAUSES_PER_BATCH = 1
        remediation.REMEDIATION_MAX_BATCHES_PER_CYCLE = 2

        scan_data = {
            "code_security": [_code_finding(i) for i in range(5)],
            "supply_chain": [_supply_finding(i) for i in range(5)],
        }

        batches = remediation._build_remediation_batches(scan_data, "all")

        self.assertEqual(len(batches), 2)
        self.assertEqual(batches[-1][1]["batch_index"], 2)
        self.assertEqual(batches[-1][1]["batch_total"], 2)

    def test_large_repo_strategy_prefers_critical_findings_first(self) -> None:
        remediation.REMEDIATION_LARGE_FINDING_THRESHOLD = 1000

        scan_data = {
            "code_security": [
                {"cwe_id": "79", "severity": "critical", "count": 900, "occurrences": [{"filename": "src/a.ts"}]},
                {"cwe_id": "89", "severity": "high", "count": 250, "occurrences": [{"filename": "src/b.ts"}]},
            ],
            "supply_chain": [
                {"cve_id": "CVE-2026-0001", "severity": "critical", "package": "next", "installed_version": "1", "fix_version": "2"},
                {"cve_id": "CVE-2026-0002", "severity": "high", "package": "react", "installed_version": "1", "fix_version": "2"},
            ],
        }

        selected_scan, strategy = remediation._select_cycle_scan_strategy(scan_data, "all")

        self.assertEqual(strategy["mode"], "large_repo_severity_staged")
        self.assertEqual(strategy["stage_severity"], "critical")
        self.assertTrue(strategy["forced_claude_sdk"])
        self.assertEqual(len(selected_scan["code_security"]), 1)
        self.assertEqual(selected_scan["code_security"][0]["severity"], "critical")
        self.assertEqual(len(selected_scan["supply_chain"]), 1)
        self.assertEqual(selected_scan["supply_chain"][0]["severity"], "critical")

    def test_large_repo_strategy_falls_through_to_high_when_no_criticals_remain(self) -> None:
        remediation.REMEDIATION_LARGE_FINDING_THRESHOLD = 1000

        scan_data = {
            "code_security": [
                {"cwe_id": "89", "severity": "high", "count": 1001, "occurrences": [{"filename": "src/b.ts"}]},
            ],
            "supply_chain": [],
        }

        selected_scan, strategy = remediation._select_cycle_scan_strategy(scan_data, "major")

        self.assertEqual(strategy["stage_severity"], "high")
        self.assertEqual(strategy["stage_findings"], 1001)
        self.assertEqual(len(selected_scan["code_security"]), 1)
        self.assertEqual(selected_scan["code_security"][0]["severity"], "high")

    def test_large_repo_strategy_stops_when_major_findings_are_cleared(self) -> None:
        remediation.REMEDIATION_LARGE_FINDING_THRESHOLD = 1000

        scan_data = {
            "code_security": [
                {"cwe_id": "200", "severity": "medium", "count": 1001, "occurrences": [{"filename": "src/c.ts"}]},
            ],
            "supply_chain": [],
        }

        selected_scan, strategy = remediation._select_cycle_scan_strategy(scan_data, "all")

        self.assertEqual(strategy["mode"], "large_repo_major_complete")
        self.assertEqual(strategy["major_remaining"], 0)
        self.assertEqual(selected_scan["code_security"], [])
        self.assertEqual(selected_scan["supply_chain"], [])


if __name__ == "__main__":
    unittest.main()
