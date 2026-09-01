from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))

from database_env import (
    build_database_env_lines,
    database_env_from_secret,
    database_url_has_empty_host,
    resolve_database_host,
    validate_customer_database_configuration,
    validate_provisioned_rds_preflight,
)
from database_preflight import run_database_preflight


class DatabaseEnvTests(unittest.TestCase):
    def test_secret_with_host_uses_secret_host(self) -> None:
        lines, error = build_database_env_lines(
            {
                "username": "app",
                "password": "secret",
                "host": "db.internal",
                "port": 5432,
                "dbname": "appdb",
            }
        )
        self.assertIsNone(error)
        joined = "\n".join(lines)
        self.assertIn("DATABASE_URL=postgresql://app:secret@db.internal:5432/appdb", joined)

    def test_secret_without_host_uses_rds_endpoint(self) -> None:
        lines, error = build_database_env_lines(
            {"username": "app", "password": "secret", "dbname": "appdb"},
            rds_endpoint="postgres.example.amazonaws.com",
        )
        self.assertIsNone(error)
        joined = "\n".join(lines)
        self.assertIn("@postgres.example.amazonaws.com:5432/appdb", joined)

    def test_secret_without_host_and_no_endpoint_fails(self) -> None:
        lines, error = build_database_env_lines(
            {"username": "app", "password": "secret"},
            rds_endpoint="",
        )
        self.assertEqual([], lines)
        self.assertEqual("MISSING_DATABASE_HOST", error)

    def test_empty_host_fails(self) -> None:
        self.assertTrue(database_url_has_empty_host("postgresql://app:pw@:5432/appdb"))

    def test_undefined_host_fails(self) -> None:
        self.assertTrue(database_url_has_empty_host("postgresql://app:pw@undefined:5432/appdb"))

    def test_malformed_database_url_fails(self) -> None:
        _, error = build_database_env_lines(None, explicit_database_url="postgresql://app:pw@:5432/appdb")
        self.assertEqual("INVALID_DATABASE_CONFIGURATION", error)

    def test_non_url_database_value_fails(self) -> None:
        self.assertTrue(database_url_has_empty_host("not-a-database-url"))

    def test_invalid_database_port_fails(self) -> None:
        lines, error = build_database_env_lines(
            {"username": "app", "password": "secret", "host": "db.internal", "port": "70000"}
        )
        self.assertEqual([], lines)
        self.assertEqual("INVALID_DATABASE_PORT", error)

    def test_control_characters_in_credentials_fail(self) -> None:
        lines, error = build_database_env_lines(
            {"username": "app", "password": "secret\nINJECTED=yes", "host": "db.internal"}
        )
        self.assertEqual([], lines)
        self.assertEqual("INVALID_DATABASE_CONFIGURATION", error)

    def test_resolve_database_host_prefers_secret(self) -> None:
        host = resolve_database_host(
            {"host": "db.internal"},
            rds_endpoint="rds.example.com",
        )
        self.assertEqual("db.internal", host)

    def test_database_env_from_secret_with_endpoint_fallback(self) -> None:
        env = database_env_from_secret(
            {"username": "admin", "password": "pw"},
            rds_endpoint="rds.aws.com",
        )
        self.assertIn("DATABASE_URL=postgresql://admin:pw@rds.aws.com:5432/appdb", env)

    def test_customer_database_url_validation(self) -> None:
        ok = validate_customer_database_configuration(
            database_url="postgresql://user:pass@db.example.com:5432/app",
        )
        self.assertTrue(ok["ok"])
        bad = validate_customer_database_configuration(database_url="postgresql://user:pass@:5432/app")
        self.assertFalse(bad["ok"])
        self.assertEqual("INVALID_DATABASE_CONFIGURATION", bad["code"])

    def test_provisioned_rds_preflight(self) -> None:
        result = validate_provisioned_rds_preflight(database_required=True)
        self.assertTrue(result["ok"])


class DatabasePreflightTests(unittest.TestCase):
    def test_rds_bundle_passes_static_preflight(self) -> None:
        text = 'resource "aws_db_instance" "postgres" {}'
        result = run_database_preflight(terraform_text=text)
        self.assertTrue(result["ok"])

    def test_customer_db_without_config_fails(self) -> None:
        text = 'npx prisma migrate deploy'
        result = run_database_preflight(terraform_text=text, database_required=True)
        self.assertFalse(result["ok"])

    def test_disabled_rds_template_does_not_claim_to_provision_database(self) -> None:
        text = '''
variable "enable_postgres" {
  type = bool
  default = false
}
resource "aws_db_instance" "postgres" {
  count = var.enable_postgres ? 1 : 0
}
'''
        result = run_database_preflight(terraform_text=text)
        self.assertTrue(result["ok"])
        self.assertTrue(result["skipped"])

    def test_customer_database_fields_pass_when_database_is_required(self) -> None:
        result = run_database_preflight(
            database_required=True,
            customer_host="customer.db.example",
            customer_port="5432",
            customer_database_name="app",
            customer_username="app",
            customer_password="secret",
        )
        self.assertTrue(result["ok"])


class BootstrapTemplateTests(unittest.TestCase):
    def test_enterprise_template_uses_rds_endpoint_fallback(self) -> None:
        root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "Terraform Agent"))
        path = os.path.join(
            root,
            "agent",
            "internal_registry",
            "snippets",
            "ec2_module.tf.tmpl",
        )
        text = Path(path).read_text(encoding="utf-8")
        self.assertIn("DEPLAI_RDS_ENDPOINT", text)
        self.assertIn("PostgreSQL hostname is unavailable", text)
        self.assertNotIn("npx prisma migrate deploy || true", text)
        self.assertIn("BOOTSTRAP_STATUS_FILE", text)
        self.assertIn('> "$status_tmp" <<\'PY\'', text)
        self.assertNotIn('\n  > "$BOOTSTRAP_STATUS_FILE"', text)
        self.assertIn("verify_local_http", text)
        self.assertIn("trap bootstrap_exit_trap EXIT", text)
        self.assertNotIn('bash -lc "$BUILD_COMMAND" || true', text)

    def test_alternate_renderer_disables_secret_tracing_and_prisma_suppression(self) -> None:
        path = Path(__file__).with_name("ec2_app_renderer.py")
        text = path.read_text(encoding="utf-8")
        self.assertNotIn("set -euxo pipefail", text)
        self.assertNotIn("npx prisma migrate deploy || true", text)
        self.assertNotIn("npx prisma db push || true", text)
        self.assertIn("trap bootstrap_exit_trap EXIT", text)
        self.assertIn('write_status "ready"', text)

    def test_bootstrap_status_json_has_no_secret_keys(self) -> None:
        sample = {
            "phase": "COMPLETED",
            "status": "SUCCESS",
            "exit_code": 0,
            "timestamp": "2026-01-01T00:00:00Z",
        }
        encoded = json.dumps(sample)
        self.assertNotIn("password", encoded.lower())
        self.assertNotIn("DATABASE_URL", encoded)


if __name__ == "__main__":
    unittest.main()
