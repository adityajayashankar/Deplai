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
    def test_invalid_middle_packet_preserves_previous_and_following_patches(self):
        scan_data = {'code_security': [
            {'severity': 'critical', 'root_cause_key': path,
             'occurrences': [{'filename': path, 'line_number': 1}]}
            for path in ('a.py', 'b.py', 'c.py')], 'supply_chain': []}
        def accepted(path):
            return {'critic_verdict': 'accept', 'critic_score': 100,
                    'changed_files': [{'path': path, 'diff': f'--- a/{path}\n+++ b/{path}\n@@\n',
                                       'vulns_addressed': [path]}]}
        failure = 'Planner local JSON contract failed: Planner target findings must be strings'
        async def execute():
            with patch('result_parser.get_scan_results', return_value=(True, scan_data)), \
                 patch('remediation_pipeline.remediation_store.remediation_runs') as journal, \
                 patch('agent.run_remediation_workflow', new=AsyncMock(side_effect=[
                     (True, accepted('a.py')), (False, failure), (True, accepted('c.py'))])) as worker:
                journal.packet_result.return_value = None
                journal.token_limit.return_value = 2_000_000
                fixes = await run_supervised_remediation('packet-test', 'all', remediation_run_id='test-run')
                self.assertEqual(worker.await_count, 3)
                saved = [call.args[2] for call in journal.packet_result.call_args_list if len(call.args) == 3]
                self.assertEqual(saved[1]['status'], 'unresolved')
                self.assertIn('findings must be strings', saved[1]['error'])
                return fixes
        self.assertEqual([fix.filepath for fix in asyncio.run(execute())], ['a.py', 'c.py'])

    def test_context_limit_isolated_from_other_remediation_packets(self):
        self.assertTrue(_is_context_limit_failure("ValueError: CONTEXT_LIMIT: source window exceeds packet budget"))
        self.assertFalse(_is_context_limit_failure("Provider authentication failed"))

    def test_capacity_pause_waits_then_retries_same_packet(self):
        raw = {'code_security': [{'severity': 'high', 'root_cause_key': 'one',
               'occurrences': [{'filename': 'app.py', 'line_number': 1}]}]}
        limited = 'AI gateway HTTP 429: {"code":"RATE_LIMIT","detail":{"quotaScope":"account","retryAfterSeconds":125}}'
        async def execute(cancel=False):
            with patch('result_parser.get_scan_results', return_value=(True, raw)), \
                 patch('remediation_pipeline.remediation_store.remediation_runs') as journal, \
                 patch('remediation_pipeline.supervisor_bridge.asyncio.sleep', new=AsyncMock()) as sleep, \
                 patch('agent.run_remediation_workflow', new=AsyncMock(side_effect=[(False, limited), (True, {})])) as worker:
                journal.packet_result.return_value = None
                journal.token_limit.return_value = 2_000_000
                if cancel:
                    sleep.side_effect = asyncio.CancelledError
                    with self.assertRaises(asyncio.CancelledError):
                        await run_supervised_remediation('pause-test', 'major', remediation_run_id='pause-run')
                    self.assertEqual(worker.await_count, 1)
                else:
                    await run_supervised_remediation('pause-test', 'major', remediation_run_id='pause-run')
                    self.assertEqual([call.args[0] for call in sleep.call_args_list], [60, 60, 5])
                    self.assertEqual(worker.await_count, 2)
                    self.assertEqual(worker.call_args_list[0].args, worker.call_args_list[1].args)
                saved = [c.args[2] for c in journal.packet_result.call_args_list if len(c.args) == 3]
                self.assertEqual(saved[0]['status'], 'waiting_for_capacity')
                self.assertIn('retry_at', saved[0])
        asyncio.run(execute())
        asyncio.run(execute(cancel=True))

    def test_capacity_retry_needs_explicit_bounded_retry_time(self):
        from remediation_pipeline.supervisor_bridge import _capacity_retry_after
        self.assertEqual(_capacity_retry_after('AI gateway HTTP 429: {"retryAfterSeconds":3070}'), 3070)
        self.assertIsNone(_capacity_retry_after('AI gateway HTTP 429: quota unavailable'))
        self.assertIsNone(_capacity_retry_after('AI gateway HTTP 403: {"retryAfterSeconds":30}'))
        self.assertIsNone(_capacity_retry_after('AI gateway HTTP 429: {"retryAfterSeconds":999999999}'))

    def test_selected_findings_are_grouped_without_reintroducing_raw_noise(self):
        selected = [Vulnerability(id=str(i), file='src/app.py', line_start=i + 1,
            line_end=i + 1, rule_id='CWE-89', severity='high', description='SQL injection', type='sast')
            for i in range(9)]
        selected += [selected[0].model_copy(update={'id': 'other', 'file': 'src/other.py'}),
                     selected[0].model_copy(update={'id': 'medium', 'severity': 'medium'}),
                     selected[0].model_copy(update={'id': 'low', 'severity': 'low'}),
                     selected[0].model_copy(update={'id': 'manual', 'remediation_capability': 'manual_action'}),
                     selected[0].model_copy(update={'id': 'noise', 'triage_action': 'ignore'})]
        raw = {'code_security': [{'severity': 'critical', 'root_cause_key': 'raw-noise',
               'occurrences': [{'filename': 'ignored.py', 'line_number': 1}]}]}
        async def execute():
            with patch('result_parser.get_scan_results', return_value=(True, raw)), \
                 patch('remediation_pipeline.remediation_store.remediation_runs') as journal, \
                 patch('agent.run_remediation_workflow', new=AsyncMock(return_value=(True, {}))) as worker:
                journal.packet_result.return_value = None
                journal.token_limit.return_value = 2_000_000
                await run_supervised_remediation('group-test', 'all',
                    selected_vulnerabilities=selected, remediation_run_id='group-run')
                packets = [call.args[0] for call in worker.call_args_list]
                self.assertEqual(len(packets), 2)
                items = [item for p in packets for item in p['code_security']]
                self.assertEqual({item['root_cause_key'] for item in items}, {str(i) for i in range(9)} | {'other'})
                self.assertEqual(sorted(len(p['code_security']) for p in packets), [1, 9])
        asyncio.run(execute())

    def test_organization_gateway_failure_stops_dispatch_and_retains_patches(self):
        scan = {'code_security': [
            {'severity': 'critical', 'root_cause_key': path,
             'occurrences': [{'filename': path, 'line_number': 1}]}
            for path in ('a.py', 'b.py', 'c.py')], 'supply_chain': []}
        accepted = {'critic_verdict': 'accept', 'critic_score': 100,
                    'changed_files': [{'path': 'a.py', 'diff': '--- a/a.py\n+++ b/a.py\n@@\n',
                                       'vulns_addressed': ['a.py']}]}
        for failure in (
            'AI gateway HTTP 500: {"error":"Organization not found","code":"UNKNOWN_PROVIDER_ERROR"}',
            'AI gateway HTTP 404: {"code":"organization_not_found"}',
            'AI gateway HTTP 403: Forbidden',
        ):
            async def execute():
                with patch('result_parser.get_scan_results', return_value=(True, scan)), \
                     patch('remediation_pipeline.remediation_store.remediation_runs') as journal, \
                     patch('agent.run_remediation_workflow', new=AsyncMock(side_effect=[
                         (True, accepted), (False, failure)])) as worker:
                    journal.packet_result.return_value = None
                    journal.token_limit.return_value = 2_000_000
                    fixes = await run_supervised_remediation('auth-test', 'all', remediation_run_id='auth-run')
                    self.assertEqual(worker.await_count, 2)
                    self.assertEqual([fix.filepath for fix in fixes], ['a.py'])
            with self.subTest(failure=failure):
                asyncio.run(execute())

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
            self.assertEqual(_max_supervisor_batches(), 100)

    def test_manifest_findings_share_one_plan(self):
        scan = {'code_security': [
            {'severity':'high', 'root_cause_key':str(i), 'occurrences':[{'filename':'frontend/package.json','line_number':1}]}
            for i in range(17)], 'supply_chain':[]}
        async def execute():
            with patch('result_parser.get_scan_results', return_value=(True, scan)), \
                 patch('agent.run_remediation_workflow', new=AsyncMock(return_value=(True, {'changed_files':[]}))) as worker, \
                 patch('remediation_pipeline.remediation_store.remediation_runs') as journal:
                journal.packet_result.return_value = None
                journal.token_limit.return_value = 2_000_000
                await run_supervised_remediation('manifest-test', 'major', remediation_run_id='manifest-test')
                self.assertEqual(worker.await_count, 1)
        asyncio.run(execute())

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
