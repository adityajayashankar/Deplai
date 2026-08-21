"""Unit tests for customer AWS Secrets Manager app-secrets helpers."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app_secrets import (
    key_from_full_name,
    list_app_secrets,
    normalize_secret_key,
    normalize_secrets_prefix,
    secret_full_name,
    upsert_app_secrets,
)


class AppSecretsHelpersTests(unittest.TestCase):
    def test_normalize_prefix_defaults(self) -> None:
        self.assertEqual(normalize_secrets_prefix("", project_name="My App!", environment="Dev"), "/my-app/dev")
        self.assertEqual(normalize_secrets_prefix("acme/prod"), "/acme/prod")

    def test_secret_full_name(self) -> None:
        self.assertEqual(secret_full_name("/acme/prod", "GOOGLE_CLIENT_SECRET"), "/acme/prod/GOOGLE_CLIENT_SECRET")

    def test_invalid_key_rejected(self) -> None:
        with self.assertRaises(ValueError):
            normalize_secret_key("bad-key")

    def test_key_from_full_name(self) -> None:
        self.assertEqual(key_from_full_name("/acme/prod", "/acme/prod/API_KEY"), "API_KEY")
        self.assertIsNone(key_from_full_name("/acme/prod", "/other/prod/API_KEY"))

    def test_list_app_secrets_filters_prefix(self) -> None:
        fake = mock.MagicMock()
        fake.list_secrets.return_value = {
            "SecretList": [
                {"Name": "/acme/prod/GOOGLE_CLIENT_ID", "ARN": "arn:1", "LastChangedDate": "2026-01-01"},
                {"Name": "/other/prod/SKIP", "ARN": "arn:2"},
            ]
        }

        with mock.patch("app_secrets._client", return_value=fake):
            rows = list_app_secrets(
                aws_access_key_id="AKIA",
                aws_secret_access_key="secret",
                aws_session_token=None,
                aws_region="eu-north-1",
                prefix="/acme/prod",
            )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["key"], "GOOGLE_CLIENT_ID")
        self.assertTrue(rows[0]["is_set"])
        self.assertNotIn("value", rows[0])
        filters = fake.list_secrets.call_args.kwargs.get("Filters") or []
        self.assertEqual(filters[0]["Values"], ["/acme/prod"])

    def test_upsert_create_then_update(self) -> None:
        fake = mock.MagicMock()
        fake.create_secret.side_effect = Exception("ResourceExistsException already exists")
        fake.describe_secret.return_value = {"ARN": "arn:updated"}

        with mock.patch("app_secrets._client", return_value=fake):
            rows = upsert_app_secrets(
                aws_access_key_id="AKIA",
                aws_secret_access_key="secret",
                aws_session_token=None,
                aws_region="eu-north-1",
                prefix="/acme/prod",
                secrets=[{"key": "GOOGLE_CLIENT_SECRET", "value": "super-secret-value"}],
            )

        fake.put_secret_value.assert_called_once()
        self.assertEqual(rows[0]["key"], "GOOGLE_CLIENT_SECRET")
        self.assertTrue(rows[0]["is_set"])
        self.assertNotIn("value", rows[0])
        self.assertNotIn("super-secret-value", str(rows))


if __name__ == "__main__":
    unittest.main()
