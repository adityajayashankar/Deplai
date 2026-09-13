import asyncio
import difflib
import json
import unittest
from unittest.mock import AsyncMock, Mock, patch

from models import RemediationRequest
from remediation_pipeline.track_runner import RemediationTrackRunner
from remediation_pipeline.models import Fix
from remediation_pipeline.orchestrator import RemediationOrchestrator
from remediation_pipeline.validator import DiffValidator


class PublicationRecoveryTests(unittest.IsolatedAsyncioTestCase):
    def runner(self):
        context = RemediationRequest(project_id='project', project_name='project', project_type='github',
            user_id='user', organization_id='org', remediation_run_id='saved', resume_publication=True)
        orchestrator = RemediationOrchestrator.__new__(RemediationOrchestrator)
        orchestrator.validator = DiffValidator()
        runner = RemediationTrackRunner(Mock(), context, orchestrator)
        runner._send_message = AsyncMock()
        return runner

    async def test_resume_never_enters_generation(self):
        runner = self.runner()
        runner._resume_publication = AsyncMock(return_value=True)
        with patch.object(runner.orchestrator, 'run', new=AsyncMock()) as generation:
            self.assertTrue(await runner._run_pipeline())
            generation.assert_not_called()
            runner._resume_publication.assert_awaited_once()

    async def test_verification_wait_reports_pending_then_returns_result(self):
        runner = self.runner()
        async def delayed(_):
            await asyncio.sleep(.03)
            return True, ''
        runner._run_step = delayed
        self.assertEqual(await runner._await_verification('Bearer', lambda: None, interval=.01), (True, ''))
        self.assertTrue(any('result is pending' in call.args[1] for call in runner._send_message.call_args_list))

    async def test_approval_received_before_wait_is_not_lost(self):
        runner = self.runner()
        runner._pending_action = 'approve_push'
        runner._command_event.set()
        self.assertEqual(await asyncio.wait_for(runner._wait_for_action(), .1), 'approve_push')
        self.assertIsNone(runner._pending_action)

    async def test_conflicting_file_is_explicitly_excluded_before_review(self):
        runner = self.runner()
        def fix(path, target):
            diff = ''.join(difflib.unified_diff(['old\n'], [target+'\n'], fromfile='a/'+path, tofile='b/'+path))
            return Fix(filepath=path,diff=diff,vulns_addressed=['high'],provider_used='test',tokens_used=0,status='auto')
        runner._latest_fixes = [fix('auth.js','one'), fix('auth.js','two'), fix('safe.js','fixed')]
        with patch.object(runner.orchestrator.validator, '_read_repo_file', return_value='old\n'), \
             patch('remediation_pipeline.track_runner.remediation_runs') as journal:
            self.assertTrue(await runner._prepare_publication_review())
            self.assertEqual([f.filepath for f in runner._latest_fixes], ['safe.js'])
            record = journal.packet_result.call_args.args[2]
            self.assertEqual(len(record['fixes']), 3)
            self.assertEqual(record['excluded_files'], ['auth.js'])
            messages = runner._send_message.call_args_list
            self.assertTrue(any(call.args[0]=='warning' and 'auth.js' in call.args[1] for call in messages))
            self.assertEqual([f['path'] for f in json.loads(messages[-1].args[1])], ['safe.js'])

    async def test_missing_archive_cannot_fall_back_to_generation(self):
        runner = self.runner()
        runner._terminate = AsyncMock(return_value=False)
        with patch('remediation_pipeline.track_runner.remediation_runs') as journal:
            journal.archive_for_run.return_value = None
            self.assertFalse(await runner._resume_publication())
            journal.archive_for_run.assert_called_once_with('saved',project_id='project',user_id='user',organization_id='org')


if __name__ == '__main__':
    unittest.main()
