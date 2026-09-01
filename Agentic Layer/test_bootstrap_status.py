from __future__ import annotations

import json
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

from bootstrap_status import _parse_status, read_bootstrap_status_once


class BootstrapStatusTests(unittest.TestCase):
    def test_parse_status_allows_only_public_lifecycle_fields(self) -> None:
        payload = _parse_status(json.dumps({
            "phase": "COMPLETED",
            "status": "SUCCESS",
            "exit_code": 0,
            "timestamp": "2026-08-31T00:00:00Z",
            "DATABASE_URL": "postgresql://user:secret@db/app",
            "password": "secret",
        }))
        self.assertEqual("COMPLETED", payload["phase"])
        self.assertNotIn("DATABASE_URL", payload)
        self.assertNotIn("password", payload)

    def test_invalid_status_does_not_echo_raw_content(self) -> None:
        payload = _parse_status("DATABASE_URL=postgresql://user:secret@db/app")
        self.assertEqual({}, payload)

    @patch("bootstrap_status.SSMExecutionAdapter")
    def test_completed_status_is_success(self, adapter_type) -> None:
        adapter = adapter_type.return_value
        adapter.ping.return_value = True
        adapter.execute.return_value = SimpleNamespace(
            stdout='{"phase":"COMPLETED","status":"SUCCESS","exit_code":0}',
            stderr="",
        )
        result = read_bootstrap_status_once(
            instance_id="i-12345678",
            credentials={"aws_region": "eu-north-1"},
        )
        self.assertTrue(result["ok"])
        self.assertEqual("completed", result["status"])

    @patch("bootstrap_status.SSMExecutionAdapter")
    def test_failed_status_is_failure(self, adapter_type) -> None:
        adapter = adapter_type.return_value
        adapter.ping.return_value = True
        adapter.execute.return_value = SimpleNamespace(
            stdout='{"phase":"FAILED","status":"FAILED","error_code":"BUILD_FAILED"}',
            stderr="",
        )
        result = read_bootstrap_status_once(
            instance_id="i-12345678",
            credentials={"aws_region": "eu-north-1"},
        )
        self.assertFalse(result["ok"])
        self.assertEqual("failed", result["status"])


if __name__ == "__main__":
    unittest.main()
