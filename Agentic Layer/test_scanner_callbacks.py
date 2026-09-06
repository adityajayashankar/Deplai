import asyncio
import unittest

from environment import scanner_log_callback


class ScannerLogCallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_worker_thread_log_is_delivered_without_needing_a_worker_event_loop(self):
        received = []
        delivered = asyncio.Event()

        async def send(message_type, content):
            received.append((message_type, content))
            delivered.set()

        callback = scanner_log_callback(asyncio.get_running_loop(), send, "Commit / source")
        await asyncio.to_thread(callback, "Gitleaks: container started")
        await asyncio.wait_for(delivered.wait(), timeout=1)

        self.assertEqual(received, [("info", "[Commit / source] Gitleaks: container started")])


if __name__ == "__main__":
    unittest.main()
