from __future__ import annotations

import os
import sys
import unittest
import types
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
if "terraform_agent.agent.engine.deployment_profile" not in sys.modules:
    terraform_agent_pkg = types.ModuleType("terraform_agent")
    terraform_agent_pkg.__path__ = []
    terraform_agent_agent_pkg = types.ModuleType("terraform_agent.agent")
    terraform_agent_agent_pkg.__path__ = []
    terraform_agent_engine_pkg = types.ModuleType("terraform_agent.agent.engine")
    terraform_agent_engine_pkg.__path__ = []
    deployment_profile_stub = types.ModuleType("terraform_agent.agent.engine.deployment_profile")
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
    deployment_profile_stub.build_profile_manifest = _stub_build_profile_manifest
    runtime_stub.DEFAULT_PROVIDER_CONSTRAINT = "~> 5.54"
    sys.modules["terraform_agent"] = terraform_agent_pkg
    sys.modules["terraform_agent.agent"] = terraform_agent_agent_pkg
    sys.modules["terraform_agent.agent.engine"] = terraform_agent_engine_pkg
    sys.modules["terraform_agent.agent.engine.deployment_profile"] = deployment_profile_stub
    sys.modules["terraform_agent.agent.engine.runtime"] = runtime_stub

from claude_deployment_pipeline import _fallback_structure_plan, _run_terraform_json_worker, generate_terraform_bundle


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
            )

        self.assertEqual(result["details"]["compute_strategy"], "ecs_fargate")

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
            )

        self.assertEqual(result["source"], "terraform_agent_multi_worker_dynamic")
        self.assertIn("terraform/modules/compute/main.tf", result["details"]["file_tree"])
        self.assertFalse(result["details"]["fallback_report"]["file_groups"])
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
            )

        self.assertEqual(result["source"], "terraform_agent_multi_worker_partial_fallback")
        self.assertEqual(result["details"]["fallback_report"]["file_groups"][0]["group_id"], "compute")
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
