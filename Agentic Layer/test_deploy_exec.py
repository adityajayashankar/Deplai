"""Unit tests for the deterministic deployment execution platform."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

os.environ.setdefault("DEPLAI_SERVICE_KEY", "test-deploy-exec-secret")
os.environ.setdefault("DEPLOY_EXEC_SKIP_TAG_CHECK", "1")

from deploy_exec import artifacts, codes, lock, store
from deploy_exec.adapters.fake import FakeAdapter
from deploy_exec.adapters.ssh import SSHExecutionAdapter
from deploy_exec.blueprint import contract_to_blueprint, validate_blueprint
from deploy_exec.contract import DeploymentContract
from deploy_exec.errors import DeployError
from deploy_exec.operations import render_operation
from deploy_exec.redact import redact
from deploy_exec.resolve import validate_identity, validate_instance
from deploy_exec.retry import should_retry
from deploy_exec.service import create_deployment, preflight, resume_deployment

DIGEST_A = "sha256:" + ("a" * 64)
DIGEST_B = "sha256:" + ("b" * 64)
IMAGE = "123456789012.dkr.ecr.eu-north-1.amazonaws.com/myapp"


def _contract_payload(**overrides) -> dict:
    payload = {
        "metadata": {
            "project_id": "proj-ifca",
            "environment_id": "production",
            "requested_by": "user-1",
            "source_commit": "abc1234",
        },
        "artifact": {
            "artifact_id": "art-1",
            "repository": "myapp",
            "image": IMAGE,
            "digest": DIGEST_B,
            "status": "PROMOTED",
            "build_id": "build-9",
        },
        "target": {
            "account_id": "123456789012",
            "region": "eu-north-1",
            "environment": "production",
            "target_id": "ec2-prod",
            "instance_id": "i-0fc3be0c728b953fa",
        },
        "application": {"name": "ifca", "container_name": "ifca"},
        "network": {
            "container_port": 3000,
            "host_port": 80,
            "health_endpoint": "/health",
            "public_endpoint": "http://203.0.113.10",
        },
        "verification": {"retries": 1, "interval_seconds": 1, "timeout_seconds": 10},
        "rollback": {
            "enabled": True,
            "previous_artifact": {
                "artifact_id": "art-0",
                "repository": "myapp",
                "image": IMAGE,
                "digest": DIGEST_A,
                "status": "PROMOTED",
            },
        },
    }
    payload.update(overrides)
    return payload


class ContractBlueprintTests(unittest.TestCase):
    def test_requires_immutable_digest(self) -> None:
        payload = _contract_payload()
        payload["artifact"]["digest"] = "latest"
        with self.assertRaises(Exception):
            DeploymentContract.model_validate(payload)

    def test_rejects_unverified_artifact(self) -> None:
        payload = _contract_payload()
        payload["artifact"]["status"] = "BUILD"
        contract = DeploymentContract.model_validate(payload)
        with self.assertRaises(DeployError) as ctx:
            contract_to_blueprint(contract)
        self.assertEqual(ctx.exception.code, "UNVERIFIED_ARTIFACT")

    def test_blueprint_is_desired_state_not_shell(self) -> None:
        blueprint = contract_to_blueprint(DeploymentContract.model_validate(_contract_payload()))
        validate_blueprint(blueprint)
        preview = blueprint.plan_preview()
        self.assertEqual(preview["runtime"], "Docker")
        self.assertEqual(preview["execution"], "AWS SSM")
        self.assertIn(DIGEST_B, preview["artifact"])
        self.assertNotIn("docker run", str(preview))

    def test_rejects_arbitrary_strategy(self) -> None:
        payload = _contract_payload()
        payload["strategy"] = {"deployment_type": "canary"}
        with self.assertRaises(Exception):
            DeploymentContract.model_validate(payload)


class OperationSecurityTests(unittest.TestCase):
    def test_unknown_operation_rejected(self) -> None:
        with self.assertRaises(DeployError):
            render_operation("run_any_shell_command", {})

    def test_pull_requires_digest(self) -> None:
        with self.assertRaises(DeployError):
            render_operation("pull_artifact", {"image": IMAGE, "digest": "latest"})

    def test_parses_ecr_image_uri(self) -> None:
        parsed = artifacts.parse_ecr_image(f"{IMAGE}:latest")
        self.assertEqual(parsed["account"], "123456789012")
        self.assertEqual(parsed["region"], "eu-north-1")
        self.assertEqual(parsed["repository"], "myapp")

    def test_latest_ecr_digest_uses_newest_image(self) -> None:
        class FakeEcr:
            def describe_images(self, **kwargs):
                del kwargs
                return {"imageDetails": [
                    {"imageDigest": DIGEST_A, "imagePushedAt": "2026-01-01"},
                    {"imageDigest": DIGEST_B, "imagePushedAt": "2026-08-01"},
                ]}

        self.assertEqual(artifacts.latest_ecr_digest(IMAGE, client=FakeEcr()), DIGEST_B)

    def test_commands_do_not_interpolate_metacharacters(self) -> None:
        with self.assertRaises(DeployError):
            render_operation("start_application", {
                "container_name": "app; rm -rf /",
                "image": IMAGE,
                "digest": DIGEST_B,
            })


class RedactionLockRetryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.patcher = patch.object(store, "STORE_ROOT", Path(self.tmp.name))
        self.patcher.start()
        store._ENV_LOCKS.clear()

    def tearDown(self) -> None:
        self.patcher.stop()
        self.tmp.cleanup()
        store._ENV_LOCKS.clear()

    def test_redacts_secrets(self) -> None:
        cleaned = redact({"password": "hunter2", "note": "ok", "aws_secret_access_key": "wJal"})
        self.assertEqual(cleaned["password"], "[REDACTED]")
        self.assertEqual(cleaned["aws_secret_access_key"], "[REDACTED]")
        self.assertEqual(cleaned["note"], "ok")

    def test_redact_preserves_secret_reference_metadata(self) -> None:
        cleaned = redact({
            "secret_references": [{"name": "db", "arn": "arn:aws:secretsmanager:eu-north-1:123456789012:secret:app"}],
            "password": "hunter2",
        })
        self.assertIsInstance(cleaned["secret_references"], list)
        self.assertEqual(cleaned["secret_references"][0]["name"], "db")
        self.assertEqual(cleaned["password"], "[REDACTED]")

    def test_environment_lock_conflict(self) -> None:
        key = "proj-ifca:production-lock-test"
        self.assertTrue(store.acquire_env_lock(key, "dep-1"))
        with self.assertRaises(DeployError) as ctx:
            lock.acquire(key, "dep-2")
        self.assertEqual(ctx.exception.code, "ENVIRONMENT_LOCKED")
        lock.release(key, "dep-1")
        lock.acquire(key, "dep-2")
        lock.release(key, "dep-2")

    def test_durable_lock_survives_memory_clear(self) -> None:
        key = "proj-ifca:durable-lock"
        self.assertTrue(store.acquire_env_lock(key, "dep-1"))
        store._ENV_LOCKS.clear()
        self.assertFalse(store.acquire_env_lock(key, "dep-2"))
        self.assertTrue(store.acquire_env_lock(key, "dep-1"))
        store.release_env_lock(key, "dep-1")
        self.assertTrue(store.acquire_env_lock(key, "dep-2"))
        store.release_env_lock(key, "dep-2")

    def test_retry_classification(self) -> None:
        self.assertTrue(should_retry(DeployError(code="SSM_TIMEOUT"), 1, 3))
        self.assertFalse(should_retry(DeployError(code="IAM_PERMISSION_DENIED"), 1, 3))
        self.assertEqual(codes.result_class("COMPLETED"), "SUCCESS")
        self.assertEqual(codes.result_class("ROLLED_BACK"), "ROLLED_BACK")
        self.assertEqual(codes.result_class("CANCELLED"), "CANCELLED")
        self.assertEqual(codes.result_class("FAILED", "ROLLBACK_FAILED"), "ROLLBACK_FAILED")
        self.assertEqual(codes.result_class("FAILED", "UNVERIFIED_ARTIFACT"), "SECURITY_BLOCKED")
        self.assertEqual(codes.result_class("CREATED"), "PENDING")

    def test_identity_and_ownership(self) -> None:
        contract = DeploymentContract.model_validate(_contract_payload())
        with self.assertRaises(DeployError) as ctx:
            validate_identity(contract, "999999999999", "eu-north-1")
        self.assertEqual(ctx.exception.code, "WRONG_ACCOUNT")
        with self.assertRaises(DeployError) as ctx:
            validate_identity(contract, "123456789012", "us-east-1")
        self.assertEqual(ctx.exception.code, "WRONG_REGION")
        with self.assertRaises(DeployError) as ctx:
            validate_instance(contract, {"InstanceId": "i-0fc3be0c728b953fa", "Tags": [{"Key": "Name", "Value": "other-app"}]})
        self.assertEqual(ctx.exception.code, "TARGET_UNAUTHORIZED")


class ExecutorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.store_root = Path(self.tmp.name)
        self.patcher = patch.object(store, "STORE_ROOT", self.store_root)
        self.patcher.start()
        store._ENV_LOCKS.clear()

    def tearDown(self) -> None:
        self.patcher.stop()
        self.tmp.cleanup()
        store._ENV_LOCKS.clear()

    def test_happy_path_fake_adapter(self) -> None:
        adapter = FakeAdapter()
        result = create_deployment(
            _contract_payload(),
            adapter=adapter,
            background=False,
            skip_tag_check=True,
            credentials={"account_id": "123456789012", "aws_region": "eu-north-1"},
        )
        self.assertEqual(result["status"], "COMPLETED")
        self.assertEqual(result["result"], "SUCCESS")
        operations = [item["operation"] for item in adapter.calls]
        self.assertIn("pull_artifact", operations)
        self.assertIn("start_application", operations)
        self.assertIn("health_check", operations)
        self.assertIn("inspect_digest", operations)
        self.assertTrue(result["snapshot_hash"])
        self.assertTrue(any("already_running" in cmd for item in adapter.calls if item["operation"] == "start_application" for cmd in item["commands"]))
        self.assertTrue(any(item.get("snapshot_hash") for item in result["events"] or []))
        self.assertTrue(any(cmd.startswith("docker pull ") and DIGEST_B in cmd for item in adapter.calls for cmd in item["commands"]))

    def test_health_failure_rolls_back(self) -> None:
        adapter = FakeAdapter()
        adapter.fail_counts["health_check"] = 3
        adapter.fail_on["health_check"] = DeployError(code="HEALTH_CHECK_FAILED")
        result = create_deployment(
            _contract_payload(),
            adapter=adapter,
            background=False,
            skip_tag_check=True,
            credentials={"account_id": "123456789012", "aws_region": "eu-north-1"},
        )
        self.assertEqual(result["status"], "ROLLED_BACK")
        self.assertEqual(result["result"], "ROLLED_BACK")
        pull_commands = [cmd for item in adapter.calls if item["operation"] == "pull_artifact" for cmd in item["commands"]]
        self.assertTrue(any(DIGEST_A in cmd for cmd in pull_commands))

    def test_dry_run_does_not_mutate(self) -> None:
        adapter = FakeAdapter()
        result = preflight(
            _contract_payload(),
            adapter=adapter,
            credentials={"account_id": "123456789012", "aws_region": "eu-north-1"},
        )
        self.assertEqual(result["status"], "COMPLETED")
        operations = [item["operation"] for item in adapter.calls]
        self.assertIn("discover_host", operations)
        self.assertNotIn("pull_artifact", operations)
        self.assertNotIn("start_application", operations)

    def test_ssh_disabled_by_default(self) -> None:
        adapter = SSHExecutionAdapter()
        with self.assertRaises(DeployError):
            adapter.ping("i-0fc3be0c728b953fa")

    def test_artifact_promotion_gate(self) -> None:
        with self.assertRaises(DeployError) as ctx:
            artifacts.validate_artifact({
                "artifact_id": "x",
                "repository": "myapp",
                "image": IMAGE,
                "digest": DIGEST_B,
                "status": "SOURCE",
            })
        self.assertEqual(ctx.exception.code, "UNVERIFIED_ARTIFACT")

    def _run(self, adapter, payload=None, **kwargs):
        return create_deployment(
            payload or _contract_payload(),
            adapter=adapter,
            background=False,
            skip_tag_check=True,
            credentials={"account_id": "123456789012", "aws_region": "eu-north-1"},
            **kwargs,
        )

    def test_digest_mismatch_blocks_deploy(self) -> None:
        adapter = FakeAdapter()
        adapter.inspect_digest = "sha256:" + ("c" * 64)
        result = self._run(adapter)
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual((result.get("error") or {}).get("code"), "ARTIFACT_INTEGRITY_FAILED")
        self.assertNotIn("start_application", [item["operation"] for item in adapter.calls])

    def test_ssm_offline(self) -> None:
        adapter = FakeAdapter()
        adapter.ping_ok = False
        result = self._run(adapter)
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual((result.get("error") or {}).get("code"), "SSM_OFFLINE")

    def test_docker_not_available(self) -> None:
        adapter = FakeAdapter()
        adapter.capabilities["docker_installed"] = False
        adapter.capabilities["docker_running"] = False
        result = self._run(adapter)
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual((result.get("error") or {}).get("code"), "DOCKER_NOT_AVAILABLE")

    def test_environment_lock_conflict_during_deploy(self) -> None:
        lock.acquire("proj-ifca:production", "other-dep")
        try:
            result = self._run(FakeAdapter())
            self.assertEqual(result["status"], "FAILED")
            self.assertEqual((result.get("error") or {}).get("code"), "ENVIRONMENT_LOCKED")
        finally:
            lock.release("proj-ifca:production", "other-dep")

    def test_cancel_before_start(self) -> None:
        adapter = FakeAdapter()
        adapter.cancel_on = "discover_host"
        result = self._run(adapter)
        self.assertEqual(result["status"], "CANCELLED")
        self.assertEqual(result["result"], "CANCELLED")
        self.assertNotIn("start_application", [item["operation"] for item in adapter.calls])

    def test_cancel_after_start_rolls_back(self) -> None:
        adapter = FakeAdapter()
        adapter.cancel_on = "start_application"
        result = self._run(adapter)
        self.assertEqual(result["status"], "ROLLED_BACK")
        self.assertEqual(result["result"], "ROLLED_BACK")

    def test_worker_crash_then_resume(self) -> None:
        adapter = FakeAdapter()
        with self.assertRaises(KeyboardInterrupt):
            self._run(adapter, crash_after="pull_artifact")
        inflight = store.list_inflight()
        self.assertEqual(len(inflight), 1)
        resumed = FakeAdapter()
        result = resume_deployment(
            inflight[0],
            adapter=resumed,
            background=False,
            skip_tag_check=True,
            credentials={"account_id": "123456789012", "aws_region": "eu-north-1"},
        )
        self.assertEqual(result["status"], "COMPLETED")
        self.assertNotIn("pull_artifact", [item["operation"] for item in resumed.calls])
        self.assertIn("start_application", [item["operation"] for item in resumed.calls])

    def test_pending_ssm_command_is_reconciled(self) -> None:
        adapter = FakeAdapter()
        adapter.write_pending_then_crash = "pull_artifact"
        with self.assertRaises(KeyboardInterrupt):
            self._run(adapter)
        inflight = store.list_inflight()
        self.assertEqual(len(inflight), 1)
        resumed = FakeAdapter()
        result = resume_deployment(
            inflight[0],
            adapter=resumed,
            background=False,
            skip_tag_check=True,
            credentials={"account_id": "123456789012", "aws_region": "eu-north-1"},
        )
        self.assertEqual(result["status"], "COMPLETED")
        self.assertTrue(resumed.reconciled)
        self.assertEqual(resumed.reconciled[0]["operation"], "pull_artifact")

    def test_rollback_failure_is_not_reported_as_rolled_back(self) -> None:
        adapter = FakeAdapter()
        adapter.fail_counts["health_check"] = 100
        adapter.fail_on["health_check"] = DeployError(code="HEALTH_CHECK_FAILED")
        result = self._run(adapter)
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["result"], "ROLLBACK_FAILED")
        self.assertEqual((result.get("error") or {}).get("code"), "ROLLBACK_FAILED")

    def test_external_endpoint_failure_rolls_back(self) -> None:
        adapter = FakeAdapter()
        result = self._run(adapter, fail_external=True)
        self.assertEqual(result["status"], "ROLLED_BACK")
        self.assertEqual((result.get("error") or {}).get("code"), "EXTERNAL_ENDPOINT_FAILED")

    def test_previous_version_captured_from_host(self) -> None:
        adapter = FakeAdapter()
        adapter.capabilities["current_digest"] = f"{IMAGE}@{DIGEST_A}"
        adapter.capabilities["current_running"] = "true"
        adapter.fail_counts["health_check"] = 3
        adapter.fail_on["health_check"] = DeployError(code="HEALTH_CHECK_FAILED")
        payload = _contract_payload()
        payload["rollback"] = {"enabled": True}
        result = self._run(adapter, payload)
        self.assertEqual(result["status"], "ROLLED_BACK")
        pull_commands = [cmd for item in adapter.calls if item["operation"] == "pull_artifact" for cmd in item["commands"]]
        self.assertTrue(any(DIGEST_A in cmd for cmd in pull_commands))

    def test_docker_daemon_stopped(self) -> None:
        adapter = FakeAdapter()
        adapter.capabilities["docker_installed"] = True
        adapter.capabilities["docker_running"] = False
        result = self._run(adapter)
        self.assertEqual((result.get("error") or {}).get("code"), "DOCKER_NOT_AVAILABLE")

    def test_ecr_auth_failure(self) -> None:
        adapter = FakeAdapter()
        adapter.fail_on["authenticate_registry"] = DeployError(code="ECR_AUTH_FAILED")
        result = self._run(adapter)
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual((result.get("error") or {}).get("code"), "ECR_AUTH_FAILED")

    def test_artifact_missing(self) -> None:
        adapter = FakeAdapter()
        adapter.fail_on["pull_artifact"] = DeployError(code="ARTIFACT_NOT_FOUND")
        result = self._run(adapter)
        self.assertEqual((result.get("error") or {}).get("code"), "ARTIFACT_NOT_FOUND")

    def test_smoke_failure_rolls_back(self) -> None:
        adapter = FakeAdapter()
        adapter.fail_on["smoke_test"] = DeployError(code="SMOKE_TEST_FAILED")
        result = self._run(adapter)
        self.assertEqual(result["status"], "ROLLED_BACK")

    def test_insufficient_disk(self) -> None:
        adapter = FakeAdapter()
        adapter.capabilities["disk_kb"] = 1024
        result = self._run(adapter)
        self.assertEqual((result.get("error") or {}).get("code"), "CONFIGURATION_ERROR")

    def test_port_conflict_rolls_back(self) -> None:
        adapter = FakeAdapter()
        adapter.fail_counts["start_application"] = 1
        adapter.fail_on["start_application"] = DeployError(code="PORT_CONFLICT")
        result = self._run(adapter)
        self.assertEqual(result["status"], "ROLLED_BACK")

    def test_snapshot_is_immutable(self) -> None:
        from deploy_exec.snapshot import freeze
        from deploy_exec.blueprint import contract_to_blueprint
        from deploy_exec.contract import DeploymentContract

        adapter = FakeAdapter()
        result = self._run(adapter)
        first = store.read_snapshot(result["deployment_id"])
        self.assertIsNotNone(first)
        contract = DeploymentContract.model_validate(_contract_payload())
        second = freeze(result["deployment_id"], contract, contract_to_blueprint(contract))
        self.assertEqual(first["blueprint_hash"], second["blueprint_hash"])


class DastHandoffTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.patcher = patch.object(store, "STORE_ROOT", Path(self.tmp.name))
        self.patcher.start()

    def tearDown(self) -> None:
        self.patcher.stop()
        self.tmp.cleanup()

    def test_production_does_not_trigger(self) -> None:
        from deploy_exec.dast_hook import maybe_start, should_trigger

        self.assertFalse(should_trigger("production", None))
        result = maybe_start({
            "environment_id": "production",
            "deployed_url": "http://203.0.113.10",
            "authorization": {"asset_id": "a1"},
            "deployment_id": "dep-1",
            "project_id": "proj-1",
        })
        self.assertFalse(result["started"])
        self.assertEqual(result["reason"], "policy")

    def test_staging_requires_authorization(self) -> None:
        from deploy_exec.dast_hook import maybe_start

        result = maybe_start({
            "environment_id": "staging",
            "deployed_url": "http://203.0.113.10",
            "deployment_id": "dep-1",
            "project_id": "proj-1",
        })
        self.assertFalse(result["started"])
        self.assertEqual(result["reason"], "no_authorization")

    def test_staging_starts_existing_dast_agent(self) -> None:
        from deploy_exec.dast_hook import maybe_start

        seen: list[tuple] = []

        def runner(project_name, project_id, target_url, *, context=None):
            seen.append((project_name, project_id, target_url, getattr(context, "dast_authorization", None)))
            return True, ""

        result = maybe_start({
            "environment_id": "staging",
            "deployed_url": "http://203.0.113.10",
            "authorization": {"asset_id": "asset-1", "project_id": "proj-1"},
            "deployment_id": "dep-1",
            "project_id": "proj-1",
        }, runner=runner)
        self.assertTrue(result["started"])
        for _ in range(50):
            if seen:
                break
            import time
            time.sleep(0.01)
        self.assertEqual(seen[0][2], "http://203.0.113.10")
        self.assertEqual(seen[0][3]["asset_id"], "asset-1")


if __name__ == "__main__":
    unittest.main()
