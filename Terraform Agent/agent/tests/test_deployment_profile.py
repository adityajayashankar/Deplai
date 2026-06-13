from __future__ import annotations

import unittest

from terraform_agent.agent.engine.deployment_profile import (
    build_profile_bundle,
    build_profile_manifest,
    is_deployment_profile_payload,
    validate_deployment_profile_payload,
)


class DeploymentProfileTests(unittest.TestCase):
    def test_detects_profile_shape(self) -> None:
        payload = {
            "document_kind": "deployment_profile",
            "workspace": "demo",
            "project_name": "demo",
            "compute": {"strategy": "ecs_fargate", "services": []},
            "networking": {"vpc": "new"},
        }
        self.assertTrue(is_deployment_profile_payload(payload))
        self.assertEqual(validate_deployment_profile_payload(payload), [])

    def test_build_profile_manifest_for_ecs(self) -> None:
        manifest, dag_order = build_profile_manifest(
            {
                "document_kind": "deployment_profile",
                "workspace": "demo",
                "project_name": "demo",
                "compute": {
                    "strategy": "ecs_fargate",
                    "services": [
                        {"id": "api", "process_type": "web", "port": 3000},
                        {"id": "worker", "process_type": "worker"},
                    ],
                },
                "networking": {"load_balancer": {"public": True}},
                "data_layer": [
                    {"id": "primary_db", "type": "postgresql"},
                    {"id": "cache", "type": "redis"},
                ],
            }
        )
        self.assertIn("api", dag_order)
        self.assertIn("worker", dag_order)
        self.assertTrue(any(component["type"] == "aws_db_instance" for component in manifest))
        self.assertTrue(any(component["type"] == "aws_elasticache_cluster" for component in manifest))

    def test_build_profile_bundle_canonicalizes_environment_and_strategy_aliases(self) -> None:
        files, warnings = build_profile_bundle(
            payload={
                "document_kind": "deployment_profile",
                "workspace": "demo",
                "project_name": "demo",
                "environment": "production",
                "compute": {"strategy": "ec2-instance", "services": [{"id": "app", "process_type": "web", "port": 3000}]},
                "runtime_config": {},
            },
            provider_version="~> 5.0",
            state_bucket="",
            lock_table="",
            aws_region="eu-north-1",
            context_summary="demo",
            website_index_html="<html></html>",
        )

        self.assertTrue(isinstance(warnings, list))
        self.assertIn('environment = "prod"', files["terraform/terraform.tfvars"])
        self.assertIn('compute_strategy = "ec2"', files["terraform/terraform.tfvars"])
        self.assertIn('name_prefix        = substr("${var.project_name}-${var.environment}-ec2-role-", 0, 38)', files["terraform/modules/iam/main.tf"])
        self.assertIn("from_port   = 80", files["terraform/modules/compute/main.tf"])
        self.assertIn("to_port     = 80", files["terraform/modules/compute/main.tf"])
