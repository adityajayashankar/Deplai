from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from claude_remediator import ClaudeBudgetTracker
from agent.remediation_workflow import (
    RemediationWorkflowState,
    _implementor_prompt,
    _json_prompt,
    _implementor_node,
    _master_node,
    _planner_node,
    _render_contexts,
    _reviewer_node,
    _search_replace_to_unified_diff,
    _synthesizer_node,
    _stage_max_tokens,
    collect_remediation_contexts,
)


PROJECT_ID = "project-123"
SOURCE_PATHS = [
    "backend/api/auth/auth.controller.js",
    "backend/api/expert/expert.controller.js",
    "backend/api/partner/partner.controller.js",
    "backend/api/user/user.controller.js",
]


def _base_state() -> RemediationWorkflowState:
    source = "dangerous(user)\n"
    return {
        "project_id": PROJECT_ID,
        "remediation_run_id": "run-1",
        "scan_data": {
            "code_security": [
                {
                    "cwe_id": "79",
                    "severity": "critical",
                    "title": "Unsafe output",
                    "description": "User input reaches an unsafe sink.",
                    "primary_path": "app.py",
                    "occurrences": [{"filename": "app.py", "line_number": 1}],
                }
            ],
            "supply_chain": [],
        },
        "contexts": {"app.py": source},
        "allowed_paths": ["app.py"],
        "llm_provider": "glm",
        "llm_api_key": "",
        "llm_model": "glm-5.2-free",
        "user_id": "user-1",
        "organization_id": "org-1",
        "llm_access_mode": "platform",
        "llm_credential_id": "",
        "budget_tracker": ClaudeBudgetTracker(),
        "persist_changes": False,
        "round": 0,
        "plan": {},
        "planner_warning": "",
        "proposal": {},
        "proposer_parse_warning": "",
        "critique": {},
        "attempt_history": [],
        "final_result": {},
        "error": "",
    }


class RemediationContextTests(unittest.TestCase):
    def test_large_source_keeps_exact_finding_window_within_packet_budget(self) -> None:
        state = _base_state()
        source = [f"value_{index} = {index}" for index in range(240)]
        source[149] = "dangerous(user)"
        state["contexts"] = {"app.py": "\n".join(source)}
        state["scan_data"]["code_security"][0]["occurrences"] = [{"filename": "app.py", "line_number": 150}]

        contexts = _render_contexts(state, max_chars=600)

        self.assertEqual(len(contexts), 1)
        self.assertLessEqual(len(contexts[0]["excerpt"]), 600)
        self.assertIn("dangerous(user)", contexts[0]["excerpt"])
        self.assertTrue(contexts[0]["line_ranges"])
        self.assertLessEqual(len(_implementor_prompt(state)), 4_600)

    def test_oversized_single_source_line_is_not_partially_sent(self) -> None:
        state = _base_state()
        state["contexts"] = {"app.py": "dangerous(" + "x" * 2_000 + ")"}

        contexts = _render_contexts(state, max_chars=300)

        self.assertNotIn("x" * 100, contexts[0]["excerpt"])
        self.assertIn("requires manual source review", contexts[0]["excerpt"])

    def test_code_only_batch_does_not_spend_context_budget_on_manifests(self) -> None:
        contents = {
            "app.py": "dangerous(user)\n",
            "package.json": '{"dependencies":{"next":"12.3.4"}}',
        }
        scan_data = {
            "code_security": [
                {
                    "cwe_id": "79",
                    "severity": "critical",
                    "primary_path": "app.py",
                    "occurrences": [{"filename": "app.py", "line_number": 1}],
                }
            ],
            "supply_chain": [],
        }

        with (
            patch(
                "agent.remediation_workflow._list_candidate_files",
                return_value=["package.json", "app.py"],
            ),
            patch("agent.remediation_workflow._read_context_candidates", return_value=contents),
        ):
            contexts = collect_remediation_contexts(scan_data)

        self.assertEqual(contexts, {"app.py": "dangerous(user)\n"})

    def test_vulnerable_sources_are_selected_before_manifests(self) -> None:
        manifests = [
            "package.json",
            "backend/package.json",
            "frontend/package.json",
            "admin-frontend/package.json",
        ]
        scan_data = {
            "code_security": [
                {
                    "cwe_id": "79",
                    "severity": "critical",
                    "primary_path": path,
                    "occurrences": [{"filename": path, "line_number": 20}],
                }
                for path in SOURCE_PATHS
            ],
            "supply_chain": [{"name": "next", "severity": "critical", "fix_version": "12.3.5"}],
        }
        contents = {
            **{path: "const next = require('next');\n" for path in SOURCE_PATHS},
            **{path: '{"dependencies":{"next":"12.3.4"}}' for path in manifests},
        }

        with (
            patch("agent.remediation_workflow._list_candidate_files", return_value=[*manifests, *SOURCE_PATHS]),
            patch("agent.remediation_workflow._read_context_candidates", return_value=contents),
        ):
            contexts = collect_remediation_contexts(scan_data)

        self.assertEqual(list(contexts)[: len(SOURCE_PATHS)], SOURCE_PATHS)
        self.assertTrue(set(SOURCE_PATHS).issubset(contexts))


class RemediationGraphTests(unittest.TestCase):
    def test_low_quota_openrouter_models_have_a_bounded_prompt_and_completion(self) -> None:
        state = _base_state()
        state["llm_provider"] = "minimax"
        state["llm_model"] = "MiniMax-M3"
        state["contexts"] = {"app.py": "x" * 1000}
        state["allowed_paths"] = ["app.py"]

        prompt = _implementor_prompt(state)
        self.assertNotIn("[truncated]", prompt)
        self.assertEqual(json.loads(prompt)["stage"], "implementor")
        self.assertEqual(_stage_max_tokens(state, "implementor"), 3072)
        self.assertEqual(_stage_max_tokens(state, "planner"), 1024)

    def test_oversized_context_is_not_silently_removed(self):
        with self.assertRaisesRegex(ValueError, "CONTEXT_LIMIT"):
            _json_prompt({"input": {"repository_context": [{"excerpt": "x" * 1000}]}}, max_chars=50)

    def test_search_replace_is_converted_to_a_valid_unified_diff(self) -> None:
        diff = _search_replace_to_unified_diff(
            "app.py",
            "dangerous(user)\n",
            "<<<<<<< SEARCH\ndangerous(user)\n=======\nsafe(user)\n>>>>>>> REPLACE",
        )
        self.assertIn("--- a/app.py", diff)
        self.assertIn("+safe(user)", diff)
        deletion = _search_replace_to_unified_diff(
            "app.py",
            "remove_me\nkeep_me\n",
            "<<<<<<< SEARCH\nremove_me\n=======\n>>>>>>> REPLACE",
        )
        self.assertIn("-remove_me", deletion)

    def test_graph_uses_two_json_llm_calls_and_a_local_reviewer(self) -> None:
        diff = "\n".join(
            [
                "--- a/app.py",
                "+++ b/app.py",
                "@@ -1,1 +1,1 @@",
                "-dangerous(user)",
                "+safe(user)",
            ]
        )
        calls: list[tuple[str, dict, dict]] = []

        def fake_dispatch(prompt: str, *args, stage: str = "", **kwargs):
            calls.append((stage, json.loads(prompt), kwargs.get("response_format") or {}))
            if stage == "workflow_planner":
                return True, json.dumps(
                    {
                        "summary": "Replace the unsafe sink.",
                        "targets": [
                            {
                                "path": "app.py",
                                "findings": ["CWE-79"],
                                "approach": "Use the safe sink.",
                                "verification": "Patch applies.",
                            }
                        ],
                        "constraints": [],
                    }
                )
            if "implementor" in stage:
                return True, json.dumps(
                    {
                        "summary": "Use the safe sink.",
                        "changes": [
                            {
                                "path": "app.py",
                                "reason": "Fix CWE-79",
                                "format": "unified_diff",
                                "content": diff,
                            }
                        ],
                    }
                )
            raise AssertionError(f"Unexpected stage: {stage}")

        with (
            patch("agent.remediation_workflow._dispatch_llm", side_effect=fake_dispatch),
            patch("agent.remediation_workflow.set_current_project_id"),
        ):
            final = _base_state()
            for node in (_master_node, _planner_node, _implementor_node, _reviewer_node, _synthesizer_node):
                final = node(final)

        self.assertEqual(final["round"], 0)
        self.assertEqual(len(final["attempt_history"]), 1)
        self.assertEqual(final["critique"]["verdict"], "accept")
        self.assertEqual(final["critique"]["quality_score"], 100)
        self.assertEqual(final["final_result"]["applied_change_count"], 1)
        self.assertEqual(final["final_result"]["changed_files"][0]["vulns_addressed"], ["CWE-79"])
        self.assertEqual([stage for stage, _, _ in calls], ["workflow_planner", "workflow_implementor"])
        self.assertTrue(all(payload["schema_version"] == "remediation.request.v2" for _, payload, _ in calls))
        self.assertTrue(all(response_format == {} for _, _, response_format in calls))


if __name__ == "__main__":
    unittest.main()
