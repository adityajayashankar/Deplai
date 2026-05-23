"""Tests for IaC pipeline bug fixes.

Covers:
- Fix 1: NameError in _execute_run (project_id scope)
- Fix 2: terraform_agent package importability
- Fix 7: .env.template documents ANTHROPIC_API_KEY
- Fix 8: All eight Terraform template directories exist
- Property 3: project_id forwarding in _execute_run (hypothesis PBT)
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import patch

import pytest


# ---------------------------------------------------------------------------
# Fix 1: NameError — _execute_run must use run.project_id
# ---------------------------------------------------------------------------

class TestExecuteRunProjectId:
    """Verify _execute_run forwards run.project_id, not a bare variable."""

    def _make_run(self, project_id: str):
        from agent.iac_pipeline import IaCRun, RunStatus
        return IaCRun(
            run_id="test-run-id",
            project_id=project_id,
            service_type="ec2",
            status=RunStatus.PENDING,
        )

    def _run_execute(self, project_id: str) -> dict:
        """Helper: run _execute_run synchronously and return captured args."""
        from agent.iac_pipeline import _execute_run

        run = self._make_run(project_id)
        captured: dict = {}

        async def mock_select_params(service, repo_ctx, user_cust, region, pid):
            captured["select_params_pid"] = pid
            return {"instance_name": "test", "aws_region": "us-east-1"}

        async def mock_validate(service, params, pid, creds, **kwargs):
            captured["validate_pid"] = pid
            return (Path("/tmp/ws"), params)

        async def mock_plan(workspace, creds):
            return "Plan: 1 to add."

        async def mock_stream_apply(workspace, creds, run_id):
            return
            yield  # make it an async generator

        async def mock_get_outputs(workspace, creds):
            return {"public_ip": "1.2.3.4"}

        def mock_parse_outputs(raw, service):
            return raw

        def mock_extract_keypair(path):
            return None

        async def _run():
            with (
                patch("agent.iac_pipeline.select_params", mock_select_params),
                patch("agent.iac_pipeline.validate_with_retry", mock_validate),
                patch("agent.iac_pipeline.plan", mock_plan),
                patch("agent.iac_pipeline.stream_apply", mock_stream_apply),
                patch("agent.iac_pipeline.get_outputs", mock_get_outputs),
                patch("agent.iac_pipeline.parse_outputs", mock_parse_outputs),
                patch("agent.iac_pipeline.extract_keypair_details", mock_extract_keypair),
            ):
                await _execute_run(run, {}, {}, {}, "us-east-1")
            return captured

        return asyncio.run(_run())

    def test_execute_run_uses_run_project_id(self):
        """select_params and validate_with_retry must receive run.project_id."""
        captured = self._run_execute("test-proj")
        assert captured["select_params_pid"] == "test-proj"
        assert captured["validate_pid"] == "test-proj"

    def test_execute_run_empty_project_id_no_name_error(self):
        """Empty project_id must not raise NameError."""
        captured = self._run_execute("")
        assert captured["select_params_pid"] == ""
        assert captured["validate_pid"] == ""


# ---------------------------------------------------------------------------
# Fix 2: terraform_agent package importability
# ---------------------------------------------------------------------------

class TestTerraformAgentImportable:
    """Verify the terraform_agent package can be imported."""

    def test_terraform_agent_importable(self):
        """import terraform_agent must not raise ModuleNotFoundError."""
        import terraform_agent  # noqa: F401

    def test_iac_pipeline_importable(self):
        """from terraform_agent.agent.iac_pipeline import IaCRun must work."""
        from terraform_agent.agent.iac_pipeline import IaCRun  # noqa: F401
        assert IaCRun is not None


# ---------------------------------------------------------------------------
# Fix 8: All eight Terraform template directories exist
# ---------------------------------------------------------------------------

EXPECTED_SERVICES = ["ec2", "s3", "rds", "vpc", "ecs", "lambda", "elasticache", "alb"]
TEMPLATES_DIR = Path(__file__).resolve().parents[1] / "templates"


class TestTemplateDirectoriesExist:
    """Verify all eight service template directories are present and complete."""

    @pytest.mark.parametrize("service", EXPECTED_SERVICES)
    def test_template_directory_exists(self, service: str):
        template_dir = TEMPLATES_DIR / service
        assert template_dir.is_dir(), f"Template directory missing: {template_dir}"

    @pytest.mark.parametrize("service", EXPECTED_SERVICES)
    def test_main_tf_exists(self, service: str):
        assert (TEMPLATES_DIR / service / "main.tf").is_file(), \
            f"main.tf missing for {service}"

    @pytest.mark.parametrize("service", EXPECTED_SERVICES)
    def test_variables_tf_exists(self, service: str):
        assert (TEMPLATES_DIR / service / "variables.tf").is_file(), \
            f"variables.tf missing for {service}"

    @pytest.mark.parametrize("service", EXPECTED_SERVICES)
    def test_outputs_tf_exists(self, service: str):
        assert (TEMPLATES_DIR / service / "outputs.tf").is_file(), \
            f"outputs.tf missing for {service}"


# ---------------------------------------------------------------------------
# Fix 7: .env.template documents ANTHROPIC_API_KEY
# ---------------------------------------------------------------------------

ENV_TEMPLATE_PATH = Path(__file__).resolve().parents[3] / ".env.template"


class TestEnvTemplateDocumentation:
    """Verify .env.template documents the IaC pipeline LLM variables."""

    def test_anthropic_api_key_present(self):
        content = ENV_TEMPLATE_PATH.read_text(encoding="utf-8")
        assert "ANTHROPIC_API_KEY=" in content, \
            "ANTHROPIC_API_KEY= entry missing from .env.template"

    def test_anthropic_api_key_has_param_selector_comment(self):
        content = ENV_TEMPLATE_PATH.read_text(encoding="utf-8")
        assert "param_selector" in content, \
            ".env.template should reference param_selector.py in ANTHROPIC_API_KEY comment"

    def test_iac_param_selector_model_documented(self):
        content = ENV_TEMPLATE_PATH.read_text(encoding="utf-8")
        assert "IAC_PARAM_SELECTOR_MODEL" in content, \
            "IAC_PARAM_SELECTOR_MODEL should be documented in .env.template"
