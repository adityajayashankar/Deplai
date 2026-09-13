import asyncio
import unittest
from scan_jobs import ScanJobs


class Socket:
    def __init__(self):
        self.events = []

    async def send_json(self, event):
        self.events.append(event)


class ScanJobsTests(unittest.IsolatedAsyncioTestCase):
    async def test_swallowed_event_persistence_failure_cannot_complete_successfully(self):
        from unittest.mock import Mock
        jobs = ScanJobs()
        jobs.store = Mock()
        jobs.store.event.side_effect = [RuntimeError('ledger unavailable'), None]

        class Runner:
            def __init__(self, progress):
                self.progress = progress

            async def run(self):
                try:
                    await self.progress.send_json({'type': 'message', 'data': {'content': 'scanner started'}})
                except RuntimeError:
                    pass  # Simulate legacy RunnerBase swallowing socket exceptions.
                return True

        job = jobs.start('project', 'user', Runner, lambda: None)
        await job.task
        self.assertEqual(job.status, 'error')
        jobs.store.finish.assert_called_once_with('project', job.run_id, 'error')

    async def test_http_start_runs_without_socket_and_duplicate_does_not_restart(self):
        jobs = ScanJobs()
        gate = asyncio.Event()
        started = []
        started_event = asyncio.Event()
        completed = []

        class Runner:
            async def run(self):
                started.append(True)
                started_event.set()
                await gate.wait()
                return True

        job = jobs.start('project', 'user', lambda _: Runner(), lambda: completed.append(True))
        self.assertIs(job, jobs.start('project', 'user', lambda _: self.fail('duplicate'), lambda: None))
        with self.assertRaises(PermissionError):
            jobs.start('project', 'other-user', lambda _: Runner(), lambda: None)
        await asyncio.wait_for(started_event.wait(), timeout=1)
        self.assertEqual(started, [True])
        gate.set()
        await job.task
        self.assertEqual(job.status, 'completed')
        self.assertEqual(completed, [True])
        socket = Socket()
        await job.attach(socket)
        self.assertEqual(socket.events[-1], {'type': 'status', 'status': 'completed'})

    async def test_disconnect_does_not_abort_and_failed_worker_is_not_success(self):
        jobs = ScanJobs()

        class BrokenSocket:
            async def send_json(self, _):
                raise ConnectionError('gone')

        class Runner:
            def __init__(self, progress):
                self.progress = progress

            async def run(self):
                self.progress.subscribers.add(BrokenSocket())
                await self.progress.send_json({'type': 'message', 'data': {'content': 'scanning'}})
                return False

        job = jobs.start('project', 'user', Runner, lambda: None)
        await job.task
        self.assertEqual(job.status, 'error')
        self.assertFalse(job.subscribers)
        socket = Socket()
        await job.attach(socket)
        self.assertEqual(socket.events[0]['data']['content'], 'scanning')
        self.assertEqual(socket.events[-1]['status'], 'error')

    async def test_settlement_receives_the_final_reported_outcome(self):
        jobs = ScanJobs()
        settled = []

        class Runner:
            async def run(self):
                return True

        async def on_settled(success, _runner, job):
            settled.append((success, job.run_id))

        job = jobs.start('metered-project', 'user', lambda _: Runner(), lambda: None, on_settled)
        await job.task
        self.assertEqual(job.status, 'completed')
        self.assertEqual(settled, [(True, job.run_id)])


if __name__ == '__main__':
    unittest.main()
