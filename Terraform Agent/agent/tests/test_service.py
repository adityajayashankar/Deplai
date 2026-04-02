from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
import shutil

from terraform_agent.agent.engine.service import _put_secret, _split_outputs
from terraform_agent.agent.engine.storage import cleanup_local_runs, resolve_execution_credentials
from terraform_agent.agent.engine.runtime import run_dir


class ServiceTests(unittest.TestCase):
    def tearDown(self) -> None:
        shutil.rmtree(run_dir("cleanup-test", "old-run").parent, ignore_errors=True)

    def test_split_outputs_separates_sensitive_values(self) -> None:
        public, sensitive = _split_outputs(
            {
                "cloudfront_url": {"value": "https://example.com", "sensitive": False},
                "generated_ec2_private_key_pem": {"value": "secret", "sensitive": True},
            }
        )
        self.assertEqual(public["cloudfront_url"], "https://example.com")
        self.assertEqual(sensitive["generated_ec2_private_key_pem"], "secret")

    def test_put_secret_updates_existing_secret(self) -> None:
        class ResourceExistsException(Exception):
            pass

        class FakeExceptions:
            pass

        FakeExceptions.ResourceExistsException = ResourceExistsException

        class FakeSecretsClient:
            exceptions = FakeExceptions

            def __init__(self) -> None:
                self.updated = False

            def create_secret(self, **_: str) -> dict[str, str]:
                raise ResourceExistsException("exists")

            def describe_secret(self, **_: str) -> dict[str, str]:
                return {"ARN": "arn:aws:secretsmanager:example"}

            def put_secret_value(self, **_: str) -> None:
                self.updated = True

        fake = FakeSecretsClient()
        arn = _put_secret(fake, "/deplai/dev/key", "value")
        self.assertEqual(arn, "arn:aws:secretsmanager:example")
        self.assertTrue(fake.updated)

    def test_resolve_execution_credentials_uses_supplied_values(self) -> None:
        creds = resolve_execution_credentials(
            aws_region="eu-north-1",
            aws_access_key_id="AKIAEXAMPLE",
            aws_secret_access_key="secret",
            aws_session_token="token",
        )
        self.assertEqual(creds["AWS_ACCESS_KEY_ID"], "AKIAEXAMPLE")
        self.assertEqual(creds["AWS_SECRET_ACCESS_KEY"], "secret")
        self.assertEqual(creds["AWS_SESSION_TOKEN"], "token")

    def test_cleanup_local_runs_removes_expired_directories(self) -> None:
        old_run = run_dir("cleanup-test", "old-run")
        old_run.mkdir(parents=True, exist_ok=True)
        stale_time = (datetime.now(timezone.utc) - timedelta(days=10)).timestamp()
        import os
        os.utime(str(old_run), (stale_time, stale_time))
        cleanup_local_runs(retention_days=7)
        self.assertFalse(old_run.exists())
