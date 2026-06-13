from __future__ import annotations

import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(__file__))

if "boto3" not in sys.modules:
    boto3_stub = types.ModuleType("boto3")
    boto3_stub.session = types.SimpleNamespace(Session=object)
    sys.modules["boto3"] = boto3_stub

if "botocore.config" not in sys.modules:
    botocore_config_stub = types.ModuleType("botocore.config")

    class Config:  # pragma: no cover - import stub
        def __init__(self, *args, **kwargs) -> None:
            pass

    botocore_config_stub.Config = Config
    sys.modules["botocore.config"] = botocore_config_stub

if "botocore.exceptions" not in sys.modules:
    botocore_exceptions_stub = types.ModuleType("botocore.exceptions")

    class ClientError(Exception):
        pass

    botocore_exceptions_stub.ClientError = ClientError
    sys.modules["botocore.exceptions"] = botocore_exceptions_stub

if "docker" not in sys.modules:
    docker_stub = types.ModuleType("docker")

    class DockerClient:  # pragma: no cover - import stub
        pass

    docker_stub.DockerClient = DockerClient
    docker_stub.from_env = lambda: None
    sys.modules["docker"] = docker_stub

if "docker.errors" not in sys.modules:
    docker_errors_stub = types.ModuleType("docker.errors")

    class ContainerError(Exception):
        pass

    docker_errors_stub.ContainerError = ContainerError
    sys.modules["docker.errors"] = docker_errors_stub

from terraform_apply import (
    _discover_existing_ec2_key_pair_name,
    _legacy_runtime_bundle_needs_remediation,
    _remediate_legacy_runtime_bundle,
    _summarize_ec2_plan_changes,
)


class TerraformApplyKeyPairDiscoveryTests(unittest.TestCase):
    def test_summarizes_ec2_create_and_replace_plan_changes(self) -> None:
        summary = _summarize_ec2_plan_changes(
            {
                "resource_changes": [
                    {
                        "address": "module.compute.aws_instance.app",
                        "type": "aws_instance",
                        "change": {"actions": ["create"]},
                    },
                    {
                        "address": "module.compute.aws_instance.replaced",
                        "type": "aws_instance",
                        "change": {"actions": ["delete", "create"]},
                    },
                    {
                        "address": "aws_security_group.app",
                        "type": "aws_security_group",
                        "change": {"actions": ["create"]},
                    },
                ]
            }
        )

        self.assertTrue(summary["has_managed_ec2"])
        self.assertTrue(summary["expects_ec2_create_or_replace"])
        self.assertEqual(summary["add"], 1)
        self.assertEqual(summary["replace"], 1)
        self.assertEqual(len(summary["resources"]), 2)

    def test_summarizes_ec2_noop_plan_changes_without_create_expectation(self) -> None:
        summary = _summarize_ec2_plan_changes(
            {
                "resource_changes": [
                    {
                        "address": "aws_instance.app",
                        "type": "aws_instance",
                        "change": {"actions": ["no-op"]},
                    },
                ]
            }
        )

        self.assertTrue(summary["has_managed_ec2"])
        self.assertFalse(summary["expects_ec2_create_or_replace"])
        self.assertEqual(summary["no_op"], 1)

    def test_discovers_project_environment_key_name_from_tfvars(self) -> None:
        files = [
            {
                "path": "terraform/modules/compute/main.tf",
                "content": '\n'.join(
                    [
                        'resource "aws_key_pair" "generated" {',
                        '  key_name   = "${var.project_name}-${var.environment}-key"',
                        '  public_key = tls_private_key.generated[0].public_key_openssh',
                        '}',
                    ]
                ),
            },
            {
                "path": "terraform/terraform.tfvars",
                "content": 'project_name = "deplai-smoke-test"\nenvironment = "dev"\n',
            },
        ]

        self.assertEqual(
            _discover_existing_ec2_key_pair_name(files, "ignored-project"),
            "deplai-smoke-test-dev-key",
        )

    def test_discovers_project_only_key_name_from_tfvars(self) -> None:
        files = [
            {
                "path": "terraform/modules/compute/main.tf",
                "content": '\n'.join(
                    [
                        'resource "aws_key_pair" "generated" {',
                        '  key_name   = "${var.project_name}-key"',
                        '  public_key = tls_private_key.generated[0].public_key_openssh',
                        '}',
                    ]
                ),
            },
            {
                "path": "terraform/terraform.tfvars",
                "content": 'project_name = "demo-app"\n',
            },
        ]

        self.assertEqual(
            _discover_existing_ec2_key_pair_name(files, "ignored-project"),
            "demo-app-key",
        )

    def test_prefers_explicit_existing_key_pair_name(self) -> None:
        files = [
            {
                "path": "terraform/modules/compute/main.tf",
                "content": 'variable "existing_ec2_key_pair_name" { type = string default = "" }\n',
            },
            {
                "path": "terraform/terraform.tfvars",
                "content": 'existing_ec2_key_pair_name = "shared-team-key"\nproject_name = "demo-app"\nenvironment = "dev"\n',
            },
        ]

        self.assertEqual(
            _discover_existing_ec2_key_pair_name(files, "ignored-project"),
            "shared-team-key",
        )

    def test_remediates_legacy_hcl_runtime_syntax_issues(self) -> None:
        files = [
            {
                "path": "terraform/versions.tf",
                "content": 'provider "aws" {\n  region = var.aws_region\n}\n',
            },
            {
                "path": "terraform/providers.tf",
                "content": 'provider "aws" {\n  region = var.aws_region\n}\n',
            },
            {
                "path": "terraform/modules/compute/variables.tf",
                "content": '\n'.join(
                    [
                        'variable "desired_log_group_name" { type = string, default = null }',
                        'variable "log_group_override" { type = string, default = null }',
                    ]
                ),
            },
            {
                "path": "terraform/modules/compute/main.tf",
                "content": 'resource "aws_ecs_service" "service" {\n  depends_on = var.load_balancer_enabled ? [aws_lb_listener.http[0]] : []\n}\n',
            },
        ]

        patched_files, remediation = _remediate_legacy_runtime_bundle(files, None)
        patched_by_path = {item["path"]: item["content"] for item in patched_files}

        self.assertTrue(remediation["legacy_versions_provider_deduped"])
        self.assertTrue(remediation["legacy_single_line_variable_blocks_rewritten"])
        self.assertTrue(remediation["legacy_conditional_depends_on_rewritten"])
        self.assertNotIn('provider "aws"', patched_by_path["terraform/versions.tf"])
        self.assertIn('default = null', patched_by_path["terraform/modules/compute/variables.tf"])
        self.assertIn('depends_on = [aws_lb_listener.http]', patched_by_path["terraform/modules/compute/main.tf"])

    def test_remediates_double_brace_variable_blocks(self) -> None:
        files = [
            {
                "path": "terraform/modules/compute/variables.tf",
                "content": '\n'.join(
                    [
                        'variable "desired_log_group_name" {{',
                        "  type    = string",
                        "  default = null",
                        "}}",
                        'variable "log_group_override" {{',
                        "  type    = string",
                        "  default = null",
                        "}}",
                    ]
                ),
            },
        ]

        patched_files, remediation = _remediate_legacy_runtime_bundle(files, None)
        patched = patched_files[0]["content"]

        self.assertTrue(remediation["legacy_single_line_variable_blocks_rewritten"])
        self.assertNotIn("{{", patched)
        self.assertIn('variable "desired_log_group_name" {', patched)
        self.assertIn('variable "log_group_override" {', patched)

    def test_remediates_legacy_provider_region_variable_reference(self) -> None:
        files = [
            {
                "path": "terraform/providers.tf",
                "content": 'provider "aws" {\n  region = var.region\n}\n',
            },
            {
                "path": "terraform/variables.tf",
                "content": 'variable "aws_region" {\n  type = string\n}\n',
            },
        ]

        patched_files, remediation = _remediate_legacy_runtime_bundle(files, None)
        patched_by_path = {item["path"]: item["content"] for item in patched_files}

        self.assertTrue(remediation["legacy_provider_region_var_rewritten"])
        self.assertIn("var.aws_region", patched_by_path["terraform/providers.tf"])
        self.assertNotIn("var.region", patched_by_path["terraform/providers.tf"])

    def test_detects_missing_al2023_ami_data_for_remediation(self) -> None:
        files = [
            {
                "path": "terraform/main.tf",
                "content": '\n'.join(
                    [
                        'module "compute" {',
                        '  source = "./modules/compute"',
                        "  ami_id = data.aws_ami.al2023.id",
                        "}",
                    ]
                ),
            },
            {
                "path": "terraform/providers.tf",
                "content": 'provider "aws" {\n  region = var.aws_region\n}\n',
            },
        ]

        self.assertTrue(_legacy_runtime_bundle_needs_remediation(files))

        patched_files, remediation = _remediate_legacy_runtime_bundle(files, None)
        patched_by_path = {item["path"]: item["content"] for item in patched_files}

        self.assertTrue(remediation["legacy_al2023_ami_data_added"])
        self.assertIn('data "aws_ami" "al2023"', patched_by_path["terraform/main.tf"])

    def test_canonicalizes_tfvars_environment_and_compute_strategy_aliases(self) -> None:
        files = [
            {
                "path": "terraform/main.tf",
                "content": 'module "compute" {\n  source = "./modules/compute"\n}\n',
            },
            {
                "path": "terraform/terraform.tfvars",
                "content": '\n'.join(
                    [
                        'project_name = "demo"',
                        'environment = "production"',
                        'compute_strategy = "ec2-instance"',
                    ]
                ),
            },
        ]

        self.assertTrue(_legacy_runtime_bundle_needs_remediation(files))

        patched_files, remediation = _remediate_legacy_runtime_bundle(files, None)
        patched_by_path = {item["path"]: item["content"] for item in patched_files}

        self.assertTrue(remediation["legacy_tfvars_environment_canonicalized"])
        self.assertTrue(remediation["legacy_tfvars_compute_strategy_canonicalized"])
        self.assertIn('environment = "prod"', patched_by_path["terraform/terraform.tfvars"])
        self.assertIn('compute_strategy = "ec2"', patched_by_path["terraform/terraform.tfvars"])

    def test_rewrites_long_iam_name_prefixes_to_bounded_substr(self) -> None:
        files = [
            {
                "path": "terraform/modules/iam/main.tf",
                "content": '\n'.join(
                    [
                        'resource "aws_iam_role" "ec2" {',
                        '  name_prefix        = "${var.project_name}-${var.environment}-ec2-role-"',
                        "}",
                        'resource "aws_iam_role_policy" "app" {',
                        '  name_prefix = "${var.project_name}-${var.environment}-app-"',
                        "}",
                        'resource "aws_iam_instance_profile" "ec2" {',
                        '  name_prefix = "${var.project_name}-${var.environment}-instance-profile-"',
                        "}",
                    ]
                ),
            },
        ]

        patched_files, remediation = _remediate_legacy_runtime_bundle(files, None)
        patched = patched_files[0]["content"]

        self.assertTrue(remediation["legacy_iam_name_collision_rewritten"])
        self.assertIn('substr("${var.project_name}-${var.environment}-ec2-role-", 0, 38)', patched)
        self.assertIn('substr("${var.project_name}-${var.environment}-app-", 0, 38)', patched)
        self.assertIn('substr("${var.project_name}-${var.environment}-instance-profile-", 0, 38)', patched)

    def test_rewrites_nginx_security_group_ingress_to_port_80(self) -> None:
        files = [
            {
                "path": "terraform/modules/compute/main.tf",
                "content": '\n'.join(
                    [
                        'resource "aws_security_group" "app" {',
                        "  ingress {",
                        "    from_port   = var.app_port",
                        "    to_port     = var.app_port",
                        '    protocol    = "tcp"',
                        '    cidr_blocks = ["0.0.0.0/0"]',
                        "  }",
                        "}",
                        'resource "aws_instance" "app" {',
                        '  user_data = join("\\n", [',
                        '    "#!/bin/bash",',
                        '    "set -euxo pipefail",',
                        '    "dnf install -y nginx"',
                        "  ])",
                        "}",
                    ]
                ),
            },
        ]

        patched_files, remediation = _remediate_legacy_runtime_bundle(files, None)
        patched = patched_files[0]["content"]

        self.assertTrue(remediation["legacy_nginx_ingress_port_fixed"])
        self.assertIn("from_port   = 80", patched)
        self.assertIn("to_port     = 80", patched)
        self.assertNotIn("from_port   = var.app_port", patched)

    def test_clean_bundle_skips_legacy_runtime_remediation(self) -> None:
        files = [
            {
                "path": "terraform/versions.tf",
                "content": 'terraform {\n  required_version = ">= 1.5.0"\n}\n',
            },
            {
                "path": "terraform/providers.tf",
                "content": 'provider "aws" {\n  region = var.aws_region\n}\n',
            },
            {
                "path": "terraform/modules/compute/variables.tf",
                "content": '\n'.join(
                    [
                        'variable "desired_log_group_name" {',
                        "  type    = string",
                        "  default = null",
                        "}",
                    ]
                ),
            },
            {
                "path": "terraform/modules/compute/main.tf",
                "content": 'resource "aws_ecs_service" "service" {\n  depends_on = [aws_lb_listener.http]\n}\n',
            },
        ]

        self.assertFalse(_legacy_runtime_bundle_needs_remediation(files))


if __name__ == "__main__":
    unittest.main()
