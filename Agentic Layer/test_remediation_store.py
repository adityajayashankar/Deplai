import os
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

_STORE_PATH = Path(__file__).resolve().parents[1] / "remediation_pipeline" / "remediation_store.py"
_SPEC = importlib.util.spec_from_file_location("deplai_test_remediation_store", _STORE_PATH)
assert _SPEC and _SPEC.loader
remediation_store = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = remediation_store
_SPEC.loader.exec_module(remediation_store)
RemediationRunStore = remediation_store.RemediationRunStore
bind_remediation_run = remediation_store.bind_remediation_run
record_llm_dispatch = remediation_store.record_llm_dispatch


class RemediationRunStoreTests(unittest.TestCase):
    def test_in_memory_journal_redacts_diff_and_token(self):
        with patch.dict(os.environ, {"MONGODB_URI": ""}, clear=False):
            store = RemediationRunStore()
            run_id = store.begin_run(project_id="project-1", user_id="user-1", organization_id=None, scope="major")
            store.append_event(
                run_id,
                project_id="project-1",
                message_type="changed_files",
                content='[{"path":"src/auth.ts", "diff":"secret=sk-123456789012345678"}]',
            )
            snapshot = store.latest_for_project("project-1")

        self.assertEqual(snapshot["run"]["status"], "queued")
        event = snapshot["events"][0]
        self.assertIn("src/auth.ts", event["content"])
        self.assertNotIn("secret=", event["content"])
        self.assertNotIn("sk-123", event["content"])

    def test_latest_status_and_events_stay_project_scoped(self):
        with patch.dict(os.environ, {"MONGODB_URI": ""}, clear=False):
            store = RemediationRunStore()
            alpha = store.begin_run(project_id="alpha", user_id="user", organization_id=None, scope="major")
            beta = store.begin_run(project_id="beta", user_id="user", organization_id=None, scope="all")
            store.mark_status(alpha, "running")
            store.append_event(beta, project_id="beta", message_type="info", content="separate run")

            snapshot = store.latest_for_project("alpha")

        self.assertEqual(snapshot["run"]["run_id"], alpha)
        self.assertEqual(snapshot["run"]["status"], "running")
        self.assertEqual(snapshot["events"], [])

    def test_llm_event_uses_bound_run_project(self):
        with patch.dict(os.environ, {"MONGODB_URI": ""}, clear=False):
            # Exercise the current-context binding contract used by LangGraph nodes.
            prior = remediation_store.remediation_runs
            remediation_store.remediation_runs = RemediationRunStore()
            try:
                run_id = remediation_store.remediation_runs.begin_run(
                    project_id="project-1", user_id="user-1", organization_id=None, scope="major"
                )
                bind_remediation_run(run_id)
                record_llm_dispatch(
                    stage="workflow_planner",
                    provider="openrouter",
                    model="nvidia/nemotron",
                    access_mode="platform",
                )
                snapshot = remediation_store.remediation_runs.latest_for_project("project-1")
            finally:
                remediation_store.remediation_runs = prior
                bind_remediation_run(None)

        self.assertEqual(snapshot["events"][0]["project_id"], "project-1")
        self.assertEqual(snapshot["events"][0]["type"], "llm_dispatch")


if __name__ == "__main__":
    unittest.main()
