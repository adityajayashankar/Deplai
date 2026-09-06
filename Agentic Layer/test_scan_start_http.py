"""Exercise the actual FastAPI start/status/WS routes with scanner work mocked."""
import asyncio
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import main
from scan_jobs import ScanJobs, ScanJob


class ScanStartHttpTests(unittest.IsolatedAsyncioTestCase):
    async def test_authenticated_post_starts_once_without_browser_socket(self):
        jobs = ScanJobs()
        gate = asyncio.Event()
        started = []
        started_event = asyncio.Event()

        class Runner:
            def __init__(self, progress, request):
                self.progress = progress

            async def run(self):
                started.append(True)
                started_event.set()
                await gate.wait()
                return False

        payload = {'project_id': 'http-scan-test', 'project_name': 'test',
                   'project_type': 'local', 'user_id': 'test-user', 'scan_type': 'sast'}
        with patch.object(main, 'scan_jobs', jobs), patch.object(main, 'EnvironmentInitializer', Runner), \
             patch.object(main, 'API_KEY', 'test-service'), patch.object(main, 'invalidate_cache'):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
                denied = await client.post('/api/scan/start', json=payload)
                self.assertEqual(denied.status_code, 401)
                self.assertFalse(jobs.jobs)
                headers = {'X-API-Key': 'test-service'}
                accepted = await client.post('/api/scan/start', json=payload, headers=headers)
                self.assertEqual(accepted.status_code, 200, accepted.text)
                await asyncio.wait_for(started_event.wait(), timeout=1)
                self.assertEqual(started, [True])
                repeated = await client.post('/api/scan/start', json=payload, headers=headers)
                self.assertEqual(repeated.status_code, 200)
                self.assertEqual(started, [True])
                running = await client.get('/api/scan/status/http-scan-test', headers=headers)
                self.assertEqual(running.json()['status'], 'running')
                gate.set()
                await jobs.jobs['http-scan-test'].task
                failed = await client.get('/api/scan/status/http-scan-test', headers=headers)
                self.assertEqual(failed.json()['status'], 'error')


class ScanReconnectTests(unittest.TestCase):
    def test_terminal_replay_and_owner_authorization(self):
        jobs = ScanJobs()
        job = ScanJob('owner', status='completed')
        job.events.append({'type': 'message', 'data': {'content': 'scan finished'}})
        jobs.jobs['ws-test'] = job
        with patch.object(main, 'scan_jobs', jobs), patch.object(main, 'API_KEY', 'test-service'), \
             patch.object(main, '_verify_ws_token', return_value=True), \
             patch.object(main, '_extract_ws_token_sub', return_value='owner'), \
             patch.object(main.app.router, 'on_startup', []):
            with TestClient(main.app) as client:
                with client.websocket_connect('/ws/scan/ws-test?token=test') as socket:
                    socket.send_json({'action': 'start'})
                    self.assertEqual(socket.receive_json()['data']['content'], 'scan finished')
                    self.assertEqual(socket.receive_json()['status'], 'completed')
                with patch.object(main, '_extract_ws_token_sub', return_value='other-user'):
                    with client.websocket_connect('/ws/scan/ws-test?token=test') as socket:
                        socket.send_json({'action': 'start'})
                        with self.assertRaises(WebSocketDisconnect) as denied:
                            socket.receive_json()
                        self.assertEqual(denied.exception.code, 1008)


if __name__ == '__main__':
    unittest.main()
