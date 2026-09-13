import os
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch, MagicMock

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
    def test_rest_recovery_returns_latest_events_in_order(self):
        db = MagicMock()
        db.remediation_runs.find_one.return_value = {'run_id':'run','project_id':'project'}
        db.remediation_events.find.return_value.sort.return_value.limit.return_value = [
            {'sequence':452,'content':'PR created'}, {'sequence':451,'content':'Verification complete'}]
        store = RemediationRunStore()
        with patch.object(store, '_mongo_db', return_value=db):
            result = store.latest_for_project('project', limit=2)
        db.remediation_events.find.return_value.sort.assert_called_once_with('sequence', -1)
        self.assertEqual([event['sequence'] for event in result['events']], [451,452])

    def test_retention_has_thirty_day_floor(self):
        for configured, expected in [('1', 30), ('60', 60), ('bad', 30)]:
            with patch.dict(os.environ, {'REMEDIATION_MONGODB_RETENTION_DAYS': configured}):
                self.assertEqual(remediation_store._retention_days(), expected)

    def test_completion_extends_every_archive_collection(self):
        db = MagicMock()
        store = RemediationRunStore()
        with patch.object(store, '_mongo_db', return_value=db):
            store.mark_status('run', 'completed')
        update = db.remediation_runs.update_one.call_args.args[1]['$set']
        self.assertGreaterEqual((update['expire_at'] - update['completed_at']).days, 30)
        db.remediation_events.update_many.assert_called_once()
        db.remediation_packets.update_many.assert_called_once()
        self.assertEqual(db.remediation_token_budgets.update_many.call_args.args[0], {'_id': 'run'})

    def test_archive_is_scoped_complete_and_redacted(self):
        db = MagicMock()
        db.remediation_runs.find_one.return_value = {'run_id': 'run', 'status': 'completed'}
        db.remediation_events.find.return_value.sort.return_value = [
            {'sequence': i, 'content': 'event'} for i in range(301)]
        db.remediation_packets.find.return_value = [
            {'_id': 'run:packet', 'result': {'github_token': 'private', 'summary': 'sk-123456789012345678'}}]
        store = RemediationRunStore()
        with patch.object(store, '_mongo_db', return_value=db):
            archive = store.archive_for_run('run', project_id='project', user_id='user', organization_id='org')
            self.assertEqual(len(archive['events']), 301)
            self.assertNotIn('github_token', archive['packets'][0]['result'])
            self.assertIn('[redacted]', archive['packets'][0]['result']['summary'])
            self.assertEqual(db.remediation_runs.find_one.call_args.args[0], {
                'run_id': 'run', 'project_id': 'project', 'user_id': 'user', 'organization_id': 'org'})
            db.remediation_runs.find_one.return_value = None
            self.assertIsNone(store.archive_for_run('run', project_id='other', user_id='user', organization_id='org'))

    def test_shared_token_budget_reconciles_usage_and_keeps_unknown_attempts(self):
        with patch.dict(os.environ, {"MONGODB_URI": "", "REMEDIATION_RUN_TOKEN_BUDGET": "2000000"}):
            store = RemediationRunStore()
            store.reserve_tokens('run', 1_200_000)
            store.reconcile_tokens('run', 1_200_000, 1_000_000)
            store.reserve_tokens('run', 700_000)
            store.reconcile_tokens('run', 700_000, None)
            store.reserve_tokens('run', 300_000)
            with self.assertRaisesRegex(RuntimeError, 'RUN_TOKEN_BUDGET'):
                store.reserve_tokens('run', 1)
            # A different run never shares or resets this run's allowance.
            store.reserve_tokens('another-run', 2_000_000)
            with self.assertRaisesRegex(RuntimeError, 'RUN_TOKEN_BUDGET'):
                store.reserve_tokens('run', 1)

    def test_concurrent_packets_cannot_over_reserve_shared_allowance(self):
        from concurrent.futures import ThreadPoolExecutor
        with patch.dict(os.environ, {"MONGODB_URI": "", "REMEDIATION_RUN_TOKEN_BUDGET": "2000000"}):
            store = RemediationRunStore()
            def reserve(_):
                try:
                    store.reserve_tokens('run', 200_000)
                    return True
                except RuntimeError:
                    return False
            with ThreadPoolExecutor(max_workers=8) as executor:
                self.assertEqual(sum(executor.map(reserve, range(20))), 10)

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

    def test_agent_artifacts_are_embedded_and_secrets_are_redacted(self):
        with patch.dict(os.environ, {"MONGODB_URI": ""}, clear=False):
            store = RemediationRunStore()
            run_id = store.begin_run(project_id="project-1", user_id="user-1", organization_id=None, scope="major")
            store.store_agent_artifact(
                run_id,
                "planner",
                {
                    "summary": "Use key sk-123456789012345678",
                    "targets": [{"path": "src/auth.ts"}],
                    "contexts": {"src/auth.ts": "complete source must not be stored"},
                },
                count_llm_call=True,
            )
            snapshot = store.latest_for_project("project-1")

        context = snapshot["run"]["agent_context"]
        self.assertEqual(context["calls_used"], 1)
        self.assertIn("[redacted]", context["planner"]["summary"])
        self.assertNotIn("contexts", context["planner"])

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

    def test_record_usage_accepts_gateway_token_shapes_and_accumulates(self):
        """The AI gateway must not fail after a successful model response."""
        with patch.dict(os.environ, {"MONGODB_URI": ""}, clear=False):
            store = RemediationRunStore()
            run_id = store.begin_run(project_id="project-1", user_id="user-1", organization_id=None, scope="major")

            # OpenRouter/Connector returns camelCase, while some adapters
            # return snake_case or prompt/completion token names.
            store.record_usage(run_id, {"inputTokens": 120, "outputTokens": 30})
            store.record_usage(run_id, {"prompt_tokens": 80, "completion_tokens": 20})
            store.record_usage(run_id, {"total_tokens": 50})

        self.assertEqual(
            store.usage_for_run(run_id),
            {"requests": 3, "input_tokens": 250, "output_tokens": 50},
        )


if __name__ == "__main__":
    unittest.main()
