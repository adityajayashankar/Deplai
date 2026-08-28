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

    def test_need_alb_and_eip_emit_registry_modules_and_endpoint_outputs(self) -> None:
        files, warnings = build_profile_bundle(
            payload={
                "document_kind": "deployment_profile",
                "workspace": "demo",
                "project_name": "demo",
                "environment": "dev",
                "need_alb": True,
                "need_eip": True,
                "compute": {
                    "strategy": "ec2",
                    "services": [{"id": "app", "process_type": "web", "port": 3000}],
                },
                "networking": {
                    "vpc": "new",
                    "load_balancer": {"public": True, "type": "application", "enabled": True},
                    "elastic_ip": {"enabled": True},
                },
                "runtime_config": {},
                "consultant_decision": {
                    "need_alb": True,
                    "need_eip": True,
                    "components": ["ec2", "alb", "eip"],
                    "stack_config": {"alb": {"enabled": True}, "eip": {"enabled": True}},
                },
            },
            provider_version="~> 5.0",
            state_bucket="",
            lock_table="",
            aws_region="eu-north-1",
            context_summary="alb-eip golden",
            website_index_html="<html></html>",
        )

        compute_hcl = files["terraform/modules/compute/main.tf"]
        outputs_hcl = files["terraform/outputs.tf"]
        networking_hcl = files["terraform/modules/networking/main.tf"]

        self.assertTrue(any("module alb" in line or 'module "alb"' in line for line in compute_hcl.splitlines()) or "module \"alb\"" in compute_hcl)
        self.assertIn('module "alb"', compute_hcl)
        self.assertIn("terraform-aws-modules/alb/aws", compute_hcl)
        self.assertIn("terraform-aws-modules/ec2-instance/aws", compute_hcl)
        self.assertIn("terraform-aws-modules/vpc/aws", networking_hcl)
        self.assertIn('resource "aws_eip" "app"', compute_hcl)
        self.assertIn('output "alb_dns_name"', outputs_hcl)
        self.assertNotIn('output "alb_dns_name" {\n  value = null\n}', outputs_hcl)
        self.assertIn('output "elastic_ip"', outputs_hcl)
        self.assertIn('output "app_url"', outputs_hcl)
        self.assertIn('output "instance_id"', outputs_hcl)
        self.assertIn('output "vpc_id"', outputs_hcl)
        self.assertIn('variable "enable_alb"', files["terraform/variables.tf"])
        self.assertIn("default = true", files["terraform/variables.tf"])
        self.assertIn("enable_alb                  = local.enable_alb", files["terraform/main.tf"])
        self.assertTrue(any("ALB enabled" in item or "Elastic IP enabled" in item for item in warnings))

    def test_alb_request_on_static_strategy_fails_clearly(self) -> None:
        with self.assertRaises(ValueError) as raised:
            build_profile_bundle(
                payload={
                    "document_kind": "deployment_profile",
                    "workspace": "demo",
                    "project_name": "demo",
                    "environment": "dev",
                    "need_alb": True,
                    "compute": {"strategy": "s3_cloudfront", "services": []},
                    "networking": {"load_balancer": {"public": True}},
                    "runtime_config": {},
                },
                provider_version="~> 5.0",
                state_bucket="",
                lock_table="",
                aws_region="eu-north-1",
                context_summary="should fail",
                website_index_html="<html></html>",
            )
        self.assertIn("Refusing silent EC2-only downgrade", str(raised.exception))

    def test_postgres_latest_tag_is_not_emitted_as_rds_engine_version(self) -> None:
        files, _warnings = build_profile_bundle(
            payload={
                "document_kind": "deployment_profile",
                "workspace": "demo",
                "project_name": "demo",
                "environment": "prod",
                "compute": {"strategy": "ec2", "services": [{"id": "app", "process_type": "web", "port": 3000}]},
                "networking": {"vpc": "new", "nat_gateway": False, "load_balancer": {}, "ports_exposed": [3000]},
                "data_layer": [{"id": "primary_db", "type": "postgresql", "engine_version": "latest"}],
                "runtime_config": {},
            },
            provider_version="~> 5.0",
            state_bucket="",
            lock_table="",
            aws_region="eu-north-1",
            context_summary="demo",
            website_index_html="<html></html>",
        )
        variables = files["terraform/variables.tf"]
        data_main = files["terraform/modules/data/main.tf"]
        tfvars = files["terraform/terraform.tfvars"]
        self.assertIn('variable "postgres_engine_version"', variables)
        self.assertIn('default = "15.17"', variables)
        self.assertNotIn('default = "latest"', variables)
        self.assertIn("local.postgres_engine_version", data_main)
        self.assertIn("postgres_engine_sentinels", data_main)
        self.assertIn('postgres_engine_version = "15.17"', tfvars)
        self.assertNotIn('postgres_engine_version = "latest"', tfvars)
