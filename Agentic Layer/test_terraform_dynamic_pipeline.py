from __future__ import annotations

import os
import sys
import unittest
import types
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
if "anthropic" not in sys.modules:
    stub = types.ModuleType("anthropic")
    stub.Anthropic = object
    sys.modules["anthropic"] = stub
if "dotenv" not in sys.modules:
    stub = types.ModuleType("dotenv")
    stub.load_dotenv = lambda *args, **kwargs: None
    sys.modules["dotenv"] = stub
if "architecture_decision.service" not in sys.modules:
    architecture_stub = types.ModuleType("architecture_decision.service")
    architecture_stub._profile_to_architecture_view = lambda payload: payload
    architecture_stub._profile_to_infra_plan = lambda payload: payload
    sys.modules["architecture_decision.service"] = architecture_stub
    architecture_pkg = types.ModuleType("architecture_decision")
    architecture_pkg.__path__ = []
    sys.modules["architecture_decision"] = architecture_pkg
if "deployment_planning_contract" not in sys.modules:
    contract_stub = types.ModuleType("deployment_planning_contract")

    class _StubProfile:
        def __init__(self, payload):
            self._payload = payload

        def model_dump(self, exclude_none=True):
            return dict(self._payload)

    contract_stub.ArchitectureAnswersDocument = dict
    contract_stub.ArchitectureQuestion = dict
    contract_stub.ArchitectureReviewPayload = dict
    contract_stub.ConflictItem = dict
    contract_stub.DeploymentProfileDocument = dict
    contract_stub.LowConfidenceItem = dict
    contract_stub.QuestionOption = dict
    contract_stub.RepositoryContextDocument = dict
    contract_stub.parse_deployment_profile = lambda payload: _StubProfile(payload)
    sys.modules["deployment_planning_contract"] = contract_stub
if "planning_runtime" not in sys.modules:
    runtime_stub = types.ModuleType("planning_runtime")
    runtime_stub.analyzer_context_md_path = lambda workspace: Path(workspace)
    runtime_stub.analyzer_context_path = lambda workspace: Path(workspace)
    runtime_stub.decision_answers_path = lambda workspace: Path(workspace)
    runtime_stub.decision_approval_payload_path = lambda workspace: Path(workspace)
    runtime_stub.decision_architecture_view_path = lambda workspace: Path(workspace)
    runtime_stub.decision_claude_usage_path = lambda workspace: Path(workspace)
    runtime_stub.decision_profile_path = lambda workspace: Path(workspace)
    runtime_stub.decision_review_payload_path = lambda workspace: Path(workspace)
    runtime_stub.read_json = lambda path: {}
    runtime_stub.runtime_paths_for_workspace = lambda workspace: {}
    runtime_stub.write_json = lambda path, payload: None
    sys.modules["planning_runtime"] = runtime_stub
if "repository_sources" not in sys.modules:
    repo_sources_stub = types.ModuleType("repository_sources")
    repo_sources_stub.resolve_repository_source = lambda *args, **kwargs: None
    sys.modules["repository_sources"] = repo_sources_stub
if "stage7_bridge" not in sys.modules:
    stage7_stub = types.ModuleType("stage7_bridge")
    stage7_stub.run_stage7_approval_payload = lambda *args, **kwargs: {}
    sys.modules["stage7_bridge"] = stage7_stub
if "terraform_agent.agent.engine.deployment_profile" not in sys.modules:
    terraform_agent_pkg = types.ModuleType("terraform_agent")
    terraform_agent_pkg.__path__ = []
    terraform_agent_agent_pkg = types.ModuleType("terraform_agent.agent")
    terraform_agent_agent_pkg.__path__ = []
    terraform_agent_engine_pkg = types.ModuleType("terraform_agent.agent.engine")
    terraform_agent_engine_pkg.__path__ = []
    deployment_profile_stub = types.ModuleType("terraform_agent.agent.engine.deployment_profile")
    cloudposse_stub = types.ModuleType("terraform_agent.agent.engine.cloudposse_atmos")
    runtime_stub = types.ModuleType("terraform_agent.agent.engine.runtime")

    def _stub_build_profile_manifest(payload):
        compute = payload.get("compute") if isinstance(payload.get("compute"), dict) else {}
        strategy = str(compute.get("strategy") or "ec2")
        return ([{"id": strategy, "type": "strategy"}], [strategy])

    def _stub_build_profile_bundle(**kwargs):
        return (
            {
                "README.md": "# stub\n",
                "terraform/providers.tf": 'provider "aws" {}\n',
                "terraform/backend.tf": "terraform {}\n",
                "terraform/variables.tf": 'variable "project_name" { type = string }\n',
                "terraform/main.tf": 'resource "aws_ecs_cluster" "main" { name = "stub" }\n',
                "terraform/outputs.tf": 'output "cluster" { value = "stub" }\n',
                "terraform/modules/compute/main.tf": 'resource "aws_ecs_service" "app" { name = "stub" }\n',
            },
            [],
        )

    deployment_profile_stub.build_profile_bundle = _stub_build_profile_bundle
    deployment_profile_stub.build_cloudposse_profile_bundle = lambda **kwargs: (
        {
            "atmos.yaml": "{}\n",
            "vendor.yaml": "{}\n",
            ".deplai/cloudposse-component-lock.json": '{"deploy_sequence":["s3_cloudfront"],"stack":"unit-test-dev","component_catalog_version":"test"}\n',
            "README.md": "# cloudposse\n",
        },
        ["Generated Cloud Posse/Atmos bundle without vendored component source; run atmos vendor pull before plan/apply."],
        {"deploy_sequence": ["s3_cloudfront"], "stack": "unit-test-dev", "component_catalog_version": "test"},
    )
    deployment_profile_stub.build_profile_manifest = _stub_build_profile_manifest
    cloudposse_stub.normalize_terraform_renderer = lambda value: value if value in {"auto", "cloudposse_atmos", "deplai_deterministic"} else "auto"
    cloudposse_stub.should_use_cloudposse_renderer = lambda payload, requested_renderer, workspace_has_prior_state=False: (
        requested_renderer != "deplai_deterministic"
        and payload.get("compute", {}).get("strategy") == "s3_cloudfront"
        and not workspace_has_prior_state,
        {
            "supported": payload.get("compute", {}).get("strategy") == "s3_cloudfront",
            "reasons": [] if payload.get("compute", {}).get("strategy") == "s3_cloudfront" else [f"unsupported compute.strategy '{payload.get('compute', {}).get('strategy')}'"],
            "deploy_sequence": ["s3_cloudfront"],
        },
    )
    runtime_stub.DEFAULT_PROVIDER_CONSTRAINT = "~> 5.54"
    sys.modules["terraform_agent"] = terraform_agent_pkg
    sys.modules["terraform_agent.agent"] = terraform_agent_agent_pkg
    sys.modules["terraform_agent.agent.engine"] = terraform_agent_engine_pkg
    sys.modules["terraform_agent.agent.engine.deployment_profile"] = deployment_profile_stub
    sys.modules["terraform_agent.agent.engine.cloudposse_atmos"] = cloudposse_stub
    sys.modules["terraform_agent.agent.engine.runtime"] = runtime_stub

from claude_deployment_pipeline import (
    _build_generation_context_summary,
    _cloudposse_compatible_profile_payload,
    _enrich_deployment_profile_for_deterministic_rendering,
    _fallback_structure_plan,
    _run_terraform_json_worker,
    generate_terraform_bundle,
)


def _profile(strategy: str) -> dict:
    services = []
    data_layer = []
    if strategy == "ecs_fargate":
        services = [
            {"id": "api", "process_type": "web", "cpu": 512, "memory": 1024, "port": 3000, "desired_count": 1, "command": "npm run start"},
        ]
        data_layer = [
            {"id": "postgres", "type": "postgresql", "engine_version": "15.4", "instance_class": "db.t3.small", "multi_az": True, "storage_gb": 20, "backup_retention_days": 7},
            {"id": "redis", "type": "redis", "node_type": "cache.t3.small"},
        ]
    elif strategy == "ec2":
        services = [
            {"id": "web", "process_type": "web", "cpu": 256, "memory": 512, "port": 3000, "desired_count": 1, "command": "npm run start"},
        ]
    return {
        "document_kind": "deployment_profile",
        "workspace": "unit-test",
        "project_name": "demo-app",
        "provider": "aws",
        "application_type": "web_app",
        "environment": "dev",
        "compute": {"strategy": strategy, "services": services},
        "networking": {"vpc": "new", "layout": "private_subnets", "nat_gateway": True, "load_balancer": {"public": True}, "ports_exposed": [3000]},
        "data_layer": data_layer,
        "build_pipeline": {"build_command": "npm run build", "start_command": "npm run start", "ecr_repository": "demo-app"},
        "runtime_config": {"required_secrets": ["DATABASE_URL"], "config_values": ["NODE_ENV"], "secrets_manager_prefix": "/demo/dev"},
        "dns_and_tls": {},
        "operational": {"health_check_path": "/", "log_group": "/deplai/demo", "log_retention_days": 30},
        "compliance": {"requirements": [], "encryption_at_rest": True, "encryption_in_transit": True},
        "warnings": [],
    }


class TerraformDynamicPipelineTests(unittest.TestCase):
    def test_deterministic_enrichment_applies_budget_security_and_frontend_context(self) -> None:
        profile = _profile("ecs_fargate")
        enriched = _enrich_deployment_profile_for_deterministic_rendering(
            profile_payload=profile,
            approval_payload_json={"budget_gate": {"cap_usd": 10, "status": "FAIL"}, "cost_estimate": {"total_monthly_usd": 120}},
            security_context_json={"criticalOrHighSupply": 1, "highCwe": ["CWE-79"]},
            website_asset_stats_json={},
            frontend_entrypoint_detection_json={},
            repository_context_json={},
        )

        self.assertEqual(enriched["compute"]["services"][0]["desired_count"], 1)
        self.assertEqual(enriched["data_layer"][0]["instance_class"], "db.t3.micro")
        self.assertFalse(enriched["data_layer"][0]["multi_az"])
        self.assertEqual(enriched["data_layer"][1]["node_type"], "cache.t3.micro")
        self.assertFalse(enriched["networking"]["load_balancer"]["public"])
        self.assertEqual(enriched["networking"]["ports_exposed"], [])
        self.assertTrue(enriched["networking"]["nat_gateway"])
        self.assertTrue(any("Stage7 budget gate constrained" in item for item in enriched["warnings"]))
        self.assertTrue(any("Security context contains critical/high findings" in item for item in enriched["warnings"]))

    def test_deterministic_enrichment_promotes_static_frontend_to_s3_cloudfront(self) -> None:
        profile = _profile("ec2")
        enriched = _enrich_deployment_profile_for_deterministic_rendering(
            profile_payload=profile,
            approval_payload_json={},
            security_context_json={},
            website_asset_stats_json={"asset_count": 3},
            frontend_entrypoint_detection_json={
                "detected": True,
                "framework": "vite",
                "entry_candidates": ["src/main.tsx"],
                "has_build_output": True,
            },
            repository_context_json={},
        )

        self.assertEqual(enriched["compute"]["strategy"], "s3_cloudfront")
        self.assertEqual(enriched["compute"]["services"], [])
        self.assertEqual(enriched["networking"]["load_balancer"], {})
        self.assertEqual(enriched["application_type"], "static_site")

    def test_cloudposse_adapter_strips_unsupported_fields_and_maps_ec2(self) -> None:
        profile = _profile("ec2")
        profile["networking"]["load_balancer"] = {"type": "alb", "public": True, "services": ["web"]}
        profile["dns_and_tls"] = {"acm_certificate": "new", "cloudfront": True}

        adapted, warnings = _cloudposse_compatible_profile_payload(profile, "cloudposse_atmos")

        self.assertEqual(adapted["compute"]["strategy"], "ecs_fargate")
        self.assertEqual(adapted["networking"]["load_balancer"], {"public": True})
        self.assertEqual(adapted["dns_and_tls"], {})
        self.assertTrue(any("mapped ec2 strategy to ecs_fargate" in item for item in warnings))
        self.assertTrue(any("stripped unsupported load_balancer fields" in item for item in warnings))

    def test_deterministic_enrichment_merges_repository_context_into_profile(self) -> None:
        profile = _profile("ecs_fargate")
        profile["build_pipeline"] = {"ecr_repository": "demo-app"}
        profile["runtime_config"] = {"required_secrets": [], "config_values": [], "secrets_manager_prefix": "/demo/dev"}
        profile["operational"] = {"health_check_path": None, "log_group": "/deplai/demo", "log_retention_days": 30}
        profile["compute"]["services"][0]["port"] = None
        profile["compute"]["services"][0]["command"] = None

        enriched = _enrich_deployment_profile_for_deterministic_rendering(
            profile_payload=profile,
            approval_payload_json={},
            security_context_json={},
            website_asset_stats_json={},
            frontend_entrypoint_detection_json={},
            repository_context_json={
                "summary": "Vite frontend with Dockerized API",
                "build": {"build_command": "npm run build", "start_command": "npm run preview", "dockerfile_port": 8080},
                "environment_variables": {"required_secrets": ["API_KEY"], "config_values": ["PUBLIC_BASE_URL"]},
                "health": {"endpoint": "/healthz"},
            },
        )

        self.assertEqual(enriched["build_pipeline"]["build_command"], "npm run build")
        self.assertEqual(enriched["build_pipeline"]["start_command"], "npm run preview")
        self.assertEqual(enriched["compute"]["services"][0]["port"], 8080)
        self.assertEqual(enriched["compute"]["services"][0]["command"], "npm run preview")
        self.assertEqual(enriched["runtime_config"]["required_secrets"], ["API_KEY"])
        self.assertEqual(enriched["runtime_config"]["config_values"], ["PUBLIC_BASE_URL"])
        self.assertEqual(enriched["operational"]["health_check_path"], "/healthz")
        self.assertTrue(any("Repository analysis supplemented runtime_config.required_secrets" in item for item in enriched["warnings"]))

    def test_generation_context_summary_includes_repo_and_operator_signals(self) -> None:
        profile = _profile("ecs_fargate")
        summary = _build_generation_context_summary(
            qa_summary="User approved ECS with a private load balancer.",
            repository_context_json={
                "summary": "Next.js app with a Docker build.",
                "build": {"build_command": "npm run build", "start_command": "npm run start"},
                "environment_variables": {"required_secrets": ["DATABASE_URL"]},
                "health": {"endpoint": "/api/health"},
            },
            approval_payload_json={"budget_gate": {"cap_usd": 25, "status": "PASS"}, "cost_estimate": {"total_monthly_usd": 18}},
            security_context_json={"criticalOrHighSupply": 2},
            website_asset_stats_json={"selected_root": "dist", "asset_count": 5, "entrypoint": "index.html"},
            frontend_entrypoint_detection_json={"framework": "nextjs"},
            profile_payload=profile,
        )

        self.assertIn("Repository Summary: Next.js app with a Docker build.", summary)
        self.assertIn("Operator Q/A: User approved ECS with a private load balancer.", summary)
        self.assertIn("Build Command: npm run build", summary)
        self.assertIn("Required Secrets: DATABASE_URL", summary)
        self.assertIn("Budget Context: cap=$25.00, estimate=$18.00, status=pass", summary)

    def test_worker_provider_failure_is_reported_as_fallback_not_failed_event(self) -> None:
        events: list[dict] = []

        with patch(
            "claude_deployment_pipeline._call_terraform_free_llm_json",
            side_effect=RuntimeError('openrouter worker call failed with HTTP 401: {"error":{"message":"Missing Authentication header","code":401}}'),
        ):
            with self.assertRaises(RuntimeError):
                _run_terraform_json_worker(
                    workspace="unit-test",
                    stage="terraform_repo_context",
                    model="unit",
                    llm_config={
                        "provider": "openrouter",
                        "model": "unit",
                        "api_key": "test",
                        "base_url": "https://example.com",
                    },
                    system_prompt="Return JSON.",
                    prompt_payload={"project": "demo"},
                    worker_id="repo-context-agent",
                    worker_role="Repository Context Agent",
                    progress_callback=events.append,
                    max_tokens=128,
                )

        self.assertFalse(any(event.get("type") == "error" for event in events))
        self.assertFalse(any(event.get("worker_status") == "failed" for event in events))
        self.assertTrue(
            any(
                "deterministic fallback will be used" in str(event.get("content") or "")
                and event.get("worker_status") == "running"
                for event in events
            )
        )

    def test_deployment_profile_json_is_the_generation_source_of_truth(self) -> None:
        architecture_profile = _profile("ec2")
        deployment_profile = _profile("ecs_fargate")

        with patch(
            "claude_deployment_pipeline._resolve_terraform_llm_config",
            return_value={"provider": "groq", "model": "unit", "api_key": "test", "base_url": "https://example.com"},
        ), patch(
            "claude_deployment_pipeline._run_terraform_json_worker",
            side_effect=AssertionError("LLM worker should not run in deterministic mode"),
        ):
            result = generate_terraform_bundle(
                architecture_json=architecture_profile,
                deployment_profile_json=deployment_profile,
                project_name="demo-app",
                workspace="unit-test",
                aws_region="us-east-1",
                iac_mode="deterministic",
                repository_context_json={"summary": "repo"},
                qa_summary="deploy ecs",
                terraform_renderer="deplai_deterministic",
            )

        self.assertEqual(result["details"]["compute_strategy"], "ecs_fargate")

    def test_auto_renderer_uses_cloudposse_for_supported_new_profile(self) -> None:
        profile = _profile("s3_cloudfront")
        result = generate_terraform_bundle(
            architecture_json=profile,
            deployment_profile_json=profile,
            project_name="demo-app",
            workspace="unit-test",
            aws_region="us-east-1",
            iac_mode="llm",
            llm_provider="groq",
            llm_api_key="test",
        )

        self.assertEqual(result["source"], "cloudposse_atmos")
        self.assertEqual(result["requested_renderer"], "auto")
        self.assertEqual(result["actual_renderer"], "cloudposse_atmos")
        self.assertEqual(result["llm_iac_calls"], 0)
        self.assertTrue(result["llm_iac_disabled"])
        self.assertTrue(any(item["path"] == ".deplai/cloudposse-component-lock.json" for item in result["files"]))

    def test_explicit_cloudposse_unsupported_reports_renderer_metadata(self) -> None:
        profile = _profile("lambda")
        result = generate_terraform_bundle(
            architecture_json=profile,
            deployment_profile_json=profile,
            project_name="demo-app",
            workspace="unit-test",
            aws_region="us-east-1",
            terraform_renderer="cloudposse_atmos",
        )

        self.assertEqual(result["requested_renderer"], "cloudposse_atmos")
        self.assertEqual(result["actual_renderer"], "deplai_deterministic")
        self.assertIn("unsupported compute.strategy", result["unsupported_reason"])

    def test_structure_plan_differs_by_strategy(self) -> None:
        ecs_plan = _fallback_structure_plan(_profile("ecs_fargate"))
        static_plan = _fallback_structure_plan(_profile("s3_cloudfront"))

        self.assertEqual(ecs_plan["bundle_strategy"], "ecs_fargate_bundle")
        self.assertIn("compute", ecs_plan["file_ownership_map"])
        self.assertEqual(static_plan["bundle_strategy"], "static_site_bundle")
        self.assertIn("storage", static_plan["file_ownership_map"])
        self.assertNotIn("compute", static_plan["file_ownership_map"])

    def test_dynamic_multi_worker_source_when_all_groups_render(self) -> None:
        profile = _profile("ecs_fargate")

        def fake_worker(**kwargs):
            stage = kwargs["stage"]
            if stage == "terraform_repo_context":
                return {"summary": "repo context", "application_shape": "api_service", "deployable_units": [], "commands": {}, "frontend": {}, "health": {}, "env": {}, "data_dependencies": [], "risk_items": []}
            if stage == "terraform_architecture_profile":
                return profile
            if stage == "terraform_structure":
                return {
                    "bundle_strategy": "ecs_fargate_bundle",
                    "surface_files": [
                        "README.md",
                        "terraform/versions.tf",
                        "terraform/providers.tf",
                        "terraform/backend.tf",
                        "terraform/locals.tf",
                        "terraform/main.tf",
                        "terraform/variables.tf",
                        "terraform/terraform.tfvars",
                        "terraform/outputs.tf",
                        "terraform/modules/compute/main.tf",
                    ],
                    "terraform_directories": ["terraform", "terraform/modules/compute"],
                    "file_tree": [
                        "README.md",
                        "terraform/versions.tf",
                        "terraform/providers.tf",
                        "terraform/backend.tf",
                        "terraform/locals.tf",
                        "terraform/main.tf",
                        "terraform/variables.tf",
                        "terraform/terraform.tfvars",
                        "terraform/outputs.tf",
                        "terraform/modules/compute/main.tf",
                    ],
                    "module_inventory": [{"id": "compute", "enabled": True, "files": ["terraform/modules/compute/main.tf"]}],
                    "file_ownership_map": {
                        "root": [
                            "README.md",
                            "terraform/versions.tf",
                            "terraform/providers.tf",
                            "terraform/backend.tf",
                            "terraform/locals.tf",
                            "terraform/main.tf",
                            "terraform/variables.tf",
                            "terraform/terraform.tfvars",
                            "terraform/outputs.tf",
                        ],
                        "compute": ["terraform/modules/compute/main.tf"],
                    },
                    "ordering": [
                        "README.md",
                        "terraform/versions.tf",
                        "terraform/providers.tf",
                        "terraform/backend.tf",
                        "terraform/locals.tf",
                        "terraform/variables.tf",
                        "terraform/main.tf",
                        "terraform/terraform.tfvars",
                        "terraform/modules/compute/main.tf",
                        "terraform/outputs.tf",
                    ],
                    "resource_focus": ["ecs", "alb", "ecr"],
                    "symbol_requirements": [],
                    "cross_file_dependencies": [],
                    "rendering_hints": [],
                    "validation_focus": [],
                    "summary": "custom tree",
                }
            if stage == "terraform_file_generation":
                group_id = kwargs["prompt_payload"]["current_group"]["id"]
                if group_id == "root":
                    return {
                        "group_id": "root",
                        "files": [
                            {"path": "README.md", "role": "readme", "content": "# demo\n", "references": [], "exports": []},
                            {"path": "terraform/versions.tf", "role": "versions", "content": "terraform {}\n", "references": [], "exports": []},
                            {"path": "terraform/providers.tf", "role": "provider", "content": 'provider "aws" {}\n', "references": [], "exports": []},
                            {"path": "terraform/backend.tf", "role": "backend", "content": "terraform {}\n", "references": [], "exports": []},
                            {"path": "terraform/locals.tf", "role": "locals", "content": "locals {}\n", "references": [], "exports": []},
                            {"path": "terraform/variables.tf", "role": "variables", "content": 'variable "project_name" { type = string }\n', "references": [], "exports": []},
                            {"path": "terraform/main.tf", "role": "root", "content": 'module "compute" { source = "./modules/compute" }\n', "references": ["module.compute"], "exports": []},
                            {"path": "terraform/terraform.tfvars", "role": "tfvars", "content": 'project_name = "demo"\n', "references": [], "exports": []},
                            {"path": "terraform/outputs.tf", "role": "outputs", "content": 'output "alb_dns_name" { value = null }\n', "references": [], "exports": ["output.alb_dns_name"]},
                        ],
                        "unresolved_dependencies": [],
                        "summary": "root generated",
                    }
                return {
                    "group_id": "compute",
                    "files": [
                        {"path": "terraform/modules/compute/main.tf", "role": "module", "content": 'resource "aws_ecs_cluster" "main" { name = "demo" }\n', "references": [], "exports": ["aws_ecs_cluster.main"]},
                    ],
                    "unresolved_dependencies": [],
                    "summary": "compute generated",
                }
            if stage == "terraform_validation":
                return {
                    "approved": True,
                    "warnings": [],
                    "missing_files": [],
                    "ordering_confirmed": kwargs["prompt_payload"]["structure_plan"]["ordering"],
                    "remediation_actions": [],
                    "unresolved_references": [],
                    "duplicate_resource_names": [],
                    "resource_profile_mismatches": [],
                    "summary": "validated",
                }
            raise AssertionError(f"Unexpected stage {stage}")

        with patch("claude_deployment_pipeline._resolve_terraform_llm_config", return_value={"provider": "groq", "model": "unit", "api_key": "test", "base_url": "https://example.com"}), patch(
            "claude_deployment_pipeline._run_terraform_json_worker",
            side_effect=fake_worker,
        ):
            result = generate_terraform_bundle(
                architecture_json=profile,
                deployment_profile_json=profile,
                project_name="demo-app",
                workspace="unit-test",
                aws_region="us-east-1",
                iac_mode="llm",
                repository_context_json={"summary": "repo"},
                approval_payload_json={"cost_estimate": {"total_monthly_usd": 123}},
                security_context_json={"critical": 0},
                website_asset_stats_json={"asset_count": 1},
                frontend_entrypoint_detection_json={"framework": "nextjs"},
                qa_summary="deploy ecs",
                llm_provider="groq",
                llm_api_key="test",
                terraform_renderer="deplai_deterministic",
            )

        self.assertIn(result["source"], {"terraform_agent_multi_worker_partial_fallback", "terraform_agent_full_fallback"})
        self.assertIn("terraform/modules/compute/main.tf", result["details"]["file_tree"])
        self.assertFalse(result["details"]["llm_workers_enabled"])
        self.assertEqual(result["details"]["bundle_strategy"], "ecs_fargate_bundle")

    def test_partial_fallback_when_one_group_fails(self) -> None:
        profile = _profile("ecs_fargate")

        def fake_worker(**kwargs):
            stage = kwargs["stage"]
            if stage == "terraform_repo_context":
                return {"summary": "repo context", "application_shape": "api_service", "deployable_units": [], "commands": {}, "frontend": {}, "health": {}, "env": {}, "data_dependencies": [], "risk_items": []}
            if stage == "terraform_architecture_profile":
                return profile
            if stage == "terraform_structure":
                return {
                    "bundle_strategy": "ecs_fargate_bundle",
                    "surface_files": [
                        "README.md",
                        "terraform/versions.tf",
                        "terraform/providers.tf",
                        "terraform/backend.tf",
                        "terraform/locals.tf",
                        "terraform/main.tf",
                        "terraform/variables.tf",
                        "terraform/terraform.tfvars",
                        "terraform/outputs.tf",
                        "terraform/modules/compute/main.tf",
                    ],
                    "terraform_directories": ["terraform", "terraform/modules/compute"],
                    "file_tree": [
                        "README.md",
                        "terraform/versions.tf",
                        "terraform/providers.tf",
                        "terraform/backend.tf",
                        "terraform/locals.tf",
                        "terraform/main.tf",
                        "terraform/variables.tf",
                        "terraform/terraform.tfvars",
                        "terraform/outputs.tf",
                        "terraform/modules/compute/main.tf",
                    ],
                    "module_inventory": [{"id": "compute", "enabled": True, "files": ["terraform/modules/compute/main.tf"]}],
                    "file_ownership_map": {
                        "root": [
                            "README.md",
                            "terraform/versions.tf",
                            "terraform/providers.tf",
                            "terraform/backend.tf",
                            "terraform/locals.tf",
                            "terraform/main.tf",
                            "terraform/variables.tf",
                            "terraform/terraform.tfvars",
                            "terraform/outputs.tf",
                        ],
                        "compute": ["terraform/modules/compute/main.tf"],
                    },
                    "ordering": [
                        "README.md",
                        "terraform/versions.tf",
                        "terraform/providers.tf",
                        "terraform/backend.tf",
                        "terraform/locals.tf",
                        "terraform/variables.tf",
                        "terraform/main.tf",
                        "terraform/terraform.tfvars",
                        "terraform/modules/compute/main.tf",
                        "terraform/outputs.tf",
                    ],
                    "resource_focus": ["ecs", "alb", "ecr"],
                    "symbol_requirements": [],
                    "cross_file_dependencies": [],
                    "rendering_hints": [],
                    "validation_focus": [],
                    "summary": "custom tree",
                }
            if stage == "terraform_file_generation":
                group_id = kwargs["prompt_payload"]["current_group"]["id"]
                if group_id == "root":
                    return {
                        "group_id": "root",
                        "files": [
                            {"path": "README.md", "role": "readme", "content": "# demo\n", "references": [], "exports": []},
                            {"path": "terraform/versions.tf", "role": "versions", "content": "terraform {}\n", "references": [], "exports": []},
                            {"path": "terraform/providers.tf", "role": "provider", "content": 'provider "aws" {}\n', "references": [], "exports": []},
                            {"path": "terraform/backend.tf", "role": "backend", "content": "terraform {}\n", "references": [], "exports": []},
                            {"path": "terraform/locals.tf", "role": "locals", "content": "locals {}\n", "references": [], "exports": []},
                            {"path": "terraform/variables.tf", "role": "variables", "content": 'variable "project_name" { type = string }\n', "references": [], "exports": []},
                            {"path": "terraform/main.tf", "role": "root", "content": 'module "compute" { source = "./modules/compute" }\n', "references": ["module.compute"], "exports": []},
                            {"path": "terraform/terraform.tfvars", "role": "tfvars", "content": 'project_name = "demo"\n', "references": [], "exports": []},
                            {"path": "terraform/outputs.tf", "role": "outputs", "content": 'output "alb_dns_name" { value = null }\n', "references": [], "exports": ["output.alb_dns_name"]},
                        ],
                        "unresolved_dependencies": [],
                        "summary": "root generated",
                    }
                raise RuntimeError("compute worker failed")
            if stage == "terraform_validation":
                return {
                    "approved": True,
                    "warnings": [],
                    "missing_files": [],
                    "ordering_confirmed": kwargs["prompt_payload"]["structure_plan"]["ordering"],
                    "remediation_actions": [],
                    "unresolved_references": [],
                    "duplicate_resource_names": [],
                    "resource_profile_mismatches": [],
                    "summary": "validated",
                }
            raise AssertionError(f"Unexpected stage {stage}")

        with patch("claude_deployment_pipeline._resolve_terraform_llm_config", return_value={"provider": "groq", "model": "unit", "api_key": "test", "base_url": "https://example.com"}), patch(
            "claude_deployment_pipeline._run_terraform_json_worker",
            side_effect=fake_worker,
        ):
            result = generate_terraform_bundle(
                architecture_json=profile,
                deployment_profile_json=profile,
                project_name="demo-app",
                workspace="unit-test",
                aws_region="us-east-1",
                iac_mode="llm",
                repository_context_json={"summary": "repo"},
                qa_summary="deploy ecs",
                llm_provider="groq",
                llm_api_key="test",
                terraform_renderer="deplai_deterministic",
            )

        self.assertEqual(result["source"], "terraform_agent_multi_worker_partial_fallback")
        self.assertFalse(result["details"]["llm_workers_enabled"])
        self.assertEqual(result["llm_iac_calls"], 0)
        self.assertTrue(any(file["path"] == "terraform/modules/compute/main.tf" for file in result["files"]))

    def test_deterministic_mode_ignores_available_llm_workers(self) -> None:
        profile = _profile("ecs_fargate")

        with patch(
            "claude_deployment_pipeline._resolve_terraform_llm_config",
            return_value={"provider": "groq", "model": "unit", "api_key": "test", "base_url": "https://example.com"},
        ), patch(
            "claude_deployment_pipeline._run_terraform_json_worker",
            side_effect=AssertionError("LLM worker should not run in deterministic mode"),
        ):
            result = generate_terraform_bundle(
                architecture_json=profile,
                deployment_profile_json=profile,
                project_name="demo-app",
                workspace="unit-test",
                aws_region="us-east-1",
                iac_mode="deterministic",
                repository_context_json={"summary": "repo"},
                qa_summary="deploy ecs",
                terraform_renderer="deplai_deterministic",
            )

        self.assertFalse(result["details"]["llm_workers_enabled"])
        self.assertEqual(result["details"]["requested_iac_mode"], "deterministic")
        self.assertIn(result["source"], {"terraform_agent_multi_worker_partial_fallback", "terraform_agent_full_fallback"})

    def test_generated_bundle_avoids_known_legacy_hcl_patterns(self) -> None:
        profile = _profile("ecs_fargate")

        with patch(
            "claude_deployment_pipeline._resolve_terraform_llm_config",
            return_value={"provider": "groq", "model": "unit", "api_key": "test", "base_url": "https://example.com"},
        ), patch(
            "claude_deployment_pipeline._run_terraform_json_worker",
            side_effect=AssertionError("LLM worker should not run in deterministic mode"),
        ):
            result = generate_terraform_bundle(
                architecture_json=profile,
                deployment_profile_json=profile,
                project_name="demo-app",
                workspace="unit-test",
                aws_region="us-east-1",
                iac_mode="deterministic",
                repository_context_json={"summary": "repo"},
                qa_summary="deploy ecs",
                terraform_renderer="deplai_deterministic",
            )

        by_path = {item["path"]: item["content"] for item in result["files"]}
        versions_tf = by_path.get("terraform/versions.tf", "")
        providers_tf = by_path.get("terraform/providers.tf", "")
        self.assertFalse('provider "aws"' in versions_tf and 'provider "aws"' in providers_tf)

        for path, content in by_path.items():
            if not path.endswith(".tf"):
                continue
            self.assertNotIn("{{", content)
            self.assertNotRegex(
                content,
                r'variable\s+"[^"]+"\s*\{\s*type\s*=\s*[^{}\n]+,\s*default\s*=\s*[^{}\n]+\s*\}',
            )
            self.assertNotRegex(content, r"depends_on\s*=\s*[^\n]*\?")


if __name__ == "__main__":
    unittest.main()
