from __future__ import annotations

import os
import sys
import types
import unittest
from unittest import mock

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
    apply_terraform_bundle,
    _bundle_requests_ec2,
    _canonical_postgres_engine_version,
    _collect_one_time_credentials,
    _configure_s3_state_backend,
    _collect_root_terraform_text,
    _collect_terraform_text,
    _collect_tfvars_text,
    _database_env_from_secret,
    _discover_existing_ec2_key_pair_name,
    _ec2_addresses_from_state_list,
    _ensure_ecr_pull_policy,
    _ensure_unique_ec2_key_pair,
    _extract_importable_aws_collisions,
    _aws_tags_mark_terraform_owned,
    _is_orphan_alb_collision,
    _is_orphan_key_pair_collision,
    _is_missing_default_vpc_error,
    _is_transient_aws_api_error,
    _legacy_runtime_bundle_needs_remediation,
    _terraform_run_kwargs,
    _transient_aws_api_error_message,
    _missing_required_ec2_error,
    _normalize_aws_provider_to_registry_pin,
    _inject_app_artifact_tarball,
    _normalize_rds_engine_versions,
    _region_has_default_vpc,
    _remediate_app_artifact_filemd5,
    _remediate_legacy_runtime_bundle,
    _rewrite_hard_default_vpc_lookup,
    _summarize_ec2_plan_changes,
    _terraform_has_aws_instance,
    _terraform_has_variable,
    _validate_aws_deploy_credentials,
    rewrite_app_artifact_filemd5_guard,
    rewrite_ec2_module_v5_compat,
)
import terraform_apply


class RdsRetentionErrorTests(unittest.TestCase):
    def test_restriction_explains_review_and_preserving_state(self):
        result = terraform_apply._friendly_terraform_error('FreeTierRestrictionError: specified backup retention period exceeds maximum')
        self.assertIn('1 day', result)
        self.assertIn('Preserve the saved deployment and Terraform state', result)
        self.assertIn('new repository scan is not required', result)

    def test_other_free_plan_restriction_is_not_misclassified(self):
        self.assertEqual(terraform_apply._friendly_terraform_error('FreeTierRestrictionError: instance size exceeds maximum'), '')


class AwsCredentialValidationTests(unittest.TestCase):
    def test_signature_mismatch_is_reported_before_terraform_without_secret_material(self) -> None:
        from botocore.exceptions import ClientError

        try:
            rejected = ClientError(
                {"Error": {"Code": "SignatureDoesNotMatch", "Message": "bad signature"}},
                "GetCallerIdentity",
            )
        except TypeError:
            rejected = ClientError()
            rejected.response = {"Error": {"Code": "SignatureDoesNotMatch", "Message": "bad signature"}}
        if not isinstance(getattr(rejected, "response", None), dict):
            rejected.response = {"Error": {"Code": "SignatureDoesNotMatch", "Message": "bad signature"}}

        class StsClient:
            def get_caller_identity(self):
                raise rejected

        class Session:
            def __init__(self, **_kwargs):
                pass

            def client(self, service: str, **_kwargs):
                if service != "sts":
                    raise AssertionError(f"unexpected AWS service: {service}")
                return StsClient()

        with mock.patch.object(terraform_apply.boto3.session, "Session", Session):
            result = _validate_aws_deploy_credentials(
                aws_access_key_id="AKIAEXAMPLE00000000",
                aws_secret_access_key="not-a-real-secret",
                aws_session_token="",
                aws_region="eu-north-1",
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "SignatureDoesNotMatch")
        self.assertIn("Standard AWS access keys do not need a session token", str(result["message"]))
        self.assertNotIn("not-a-real-secret", str(result["message"]))


class TerraformStateBackendTests(unittest.TestCase):
    def test_runtime_configuration_replaces_disposable_local_backend(self) -> None:
        files = [
            {
                "path": "terraform/backend.tf",
                "content": 'terraform {\n  backend "local" {}\n}\n',
            },
            {"path": "terraform/main.tf", "content": 'resource "null_resource" "example" {}\n'},
        ]

        configured = _configure_s3_state_backend(
            files,
            state_bucket="deplai-tfstate-example",
            lock_table="deplai-tflock-example",
            aws_region="eu-north-1",
            project_name="ifca",
        )

        backend = next(item for item in configured if item["path"] == "terraform/backend.tf")
        self.assertNotIn('backend "local"', backend["content"])
        self.assertIn('backend "s3"', backend["content"])
        self.assertIn('bucket         = "deplai-tfstate-example"', backend["content"])
        self.assertIn('dynamodb_table = "deplai-tflock-example"', backend["content"])
        self.assertIn('key            = "ifca/production/terraform.tfstate"', backend["content"])
        self.assertEqual(backend["encoding"], "utf-8")

    def test_apply_stops_at_credential_preflight_before_creating_a_terraform_workspace(self) -> None:
        with (
            mock.patch.object(
                terraform_apply,
                "_validate_aws_deploy_credentials",
                return_value={
                    "ok": False,
                    "code": "SignatureDoesNotMatch",
                    "message": "AWS rejected the access key and secret as a pair.",
                },
            ) as validate,
            mock.patch.object(terraform_apply, "get_docker_client") as docker,
        ):
            result = apply_terraform_bundle(
                files=[{"path": "main.tf", "content": "terraform {}\n"}],
                project_name="example",
                provider="aws",
                aws_access_key_id="AKIAEXAMPLE00000000",
                aws_secret_access_key="not-a-real-secret",
                aws_session_token="",
                aws_region="eu-north-1",
            )

        self.assertFalse(result["success"])
        self.assertEqual(result["details"]["stage"], "credentials")
        validate.assert_called_once()
        docker.assert_not_called()


class TerraformApplyKeyPairDiscoveryTests(unittest.TestCase):
    def test_extracts_ecr_and_log_group_collisions_without_misclassifying_key_or_alb(self) -> None:
        error = """Error: creating ECR Repository (ifca): operation error ECR: CreateRepository, RepositoryAlreadyExistsException: repository exists

  with module.compute.aws_ecr_repository.app,
  on modules/compute/main.tf line 7, in resource "aws_ecr_repository" "app":

Error: creating CloudWatch Logs Log Group (/deplai/ifca): ResourceAlreadyExistsException: log group exists

  with module.compute.aws_cloudwatch_log_group.ecs,
  on modules/compute/main.tf line 13, in resource "aws_cloudwatch_log_group" "ecs":
"""
        collisions = _extract_importable_aws_collisions(error)
        self.assertEqual(
            [(item["kind"], item["address"], item["import_id"]) for item in collisions],
            [
                ("ecr_repository", "module.compute.aws_ecr_repository.app", "ifca"),
                ("cloudwatch_log_group", "module.compute.aws_cloudwatch_log_group.ecs", "/deplai/ifca"),
            ],
        )
        self.assertFalse(_is_orphan_key_pair_collision(error))
        self.assertFalse(_is_orphan_alb_collision(error))

    def test_extracts_rds_subnet_group_collision_for_state_recovery(self) -> None:
        error = """Error: creating RDS DB Subnet Group (ifca-db-subnets): DBSubnetGroupAlreadyExists: already exists

  with module.data.aws_db_subnet_group.main[0],
  on modules/data/main.tf line 8, in resource "aws_db_subnet_group" "main":
"""
        self.assertEqual(
            _extract_importable_aws_collisions(error),
            [{"kind": "rds_subnet_group", "address": "module.data.aws_db_subnet_group.main[0]", "import_id": "ifca-db-subnets"}],
        )

    def test_extracts_load_balancer_collision_for_state_recovery(self) -> None:
        error = """Error: creating ELBv2 application Load Balancer (ifca-alb): DuplicateLoadBalancerName: already exists

  with module.compute.aws_lb.main[0],
  on modules/compute/main.tf line 1, in resource "aws_lb" "main":
"""
        self.assertEqual(
            _extract_importable_aws_collisions(error),
            [{"kind": "load_balancer", "address": "module.compute.aws_lb.main[0]", "import_id": "ifca-alb"}],
        )

    def test_extracts_rds_collision_for_state_recovery(self) -> None:
        error = """Error: creating RDS DB Instance (ifca-postgres): DBInstanceAlreadyExists: DB instance already exists

  with module.data.aws_db_instance.main[0],
  on modules/data/main.tf line 42, in resource "aws_db_instance" "main":
"""
        self.assertEqual(
            _extract_importable_aws_collisions(error),
            [{"kind": "rds_instance", "address": "module.data.aws_db_instance.main[0]", "import_id": "ifca-postgres"}],
        )

    def test_import_ownership_requires_terraform_or_deplai_tags(self) -> None:
        class EcrClient:
            def describe_repositories(self, **_kwargs):
                return {"repositories": [{"repositoryArn": "arn:ecr:ifca"}]}

            def list_tags_for_resource(self, **_kwargs):
                return {"tags": [{"Key": "ManagedBy", "Value": "deplai"}]}

        class Session:
            def client(self, service, **_kwargs):
                self.assert_service = service
                return EcrClient()

        owned, tags = _aws_tags_mark_terraform_owned(
            {"kind": "ecr_repository", "import_id": "ifca", "address": "module.compute.aws_ecr_repository.app"},
            session=Session(),
            aws_region="eu-north-1",
        )
        self.assertTrue(owned)
        self.assertEqual(tags["managedby"], "deplai")

    def test_verifies_tagged_rds_subnet_group_before_importing(self) -> None:
        class RdsClient:
            def describe_db_subnet_groups(self, **_kwargs):
                return {"DBSubnetGroups": [{"DBSubnetGroupArn": "arn:aws:rds:eu-north-1:123:subgrp:ifca-db-subnets"}]}

            def list_tags_for_resource(self, **_kwargs):
                return {"TagList": [{"Key": "ManagedBy", "Value": "deplai"}, {"Key": "Project", "Value": "ifca"}]}

        class Session:
            def client(self, service, **_kwargs):
                if service != "rds":
                    raise AssertionError(f"unexpected AWS service: {service}")
                return RdsClient()

        owned, tags = _aws_tags_mark_terraform_owned(
            {"kind": "rds_subnet_group", "import_id": "ifca-db-subnets", "address": "module.data.aws_db_subnet_group.main[0]"},
            session=Session(),
            aws_region="eu-north-1",
            expected_project="ifca",
        )
        self.assertTrue(owned)
        self.assertEqual(tags["project"], "ifca")

    def test_verifies_tagged_load_balancer_and_resolves_its_import_arn(self) -> None:
        class Elbv2Client:
            def describe_load_balancers(self, **_kwargs):
                return {"LoadBalancers": [{"LoadBalancerArn": "arn:aws:elasticloadbalancing:region:123:loadbalancer/app/ifca-alb/id"}]}

            def describe_tags(self, **_kwargs):
                return {"TagDescriptions": [{"Tags": [{"Key": "ManagedBy", "Value": "deplai"}, {"Key": "Project", "Value": "ifca"}]}]}

        class Session:
            def client(self, service, **_kwargs):
                if service != "elbv2":
                    raise AssertionError(f"unexpected AWS service: {service}")
                return Elbv2Client()

        collision = {"kind": "load_balancer", "import_id": "ifca-alb", "address": "module.compute.aws_lb.main[0]"}
        owned, tags = _aws_tags_mark_terraform_owned(
            collision,
            session=Session(),
            aws_region="eu-north-1",
            expected_project="ifca",
        )
        self.assertTrue(owned)
        self.assertEqual(tags["managedby"], "deplai")
        self.assertTrue(collision["import_id"].startswith("arn:aws:elasticloadbalancing:"))

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

    def test_rewrites_artifacts_iam_policy_count_away_from_unknown_role_name(self) -> None:
        files = [
            {
                "path": "terraform/modules/compute/main.tf",
                "content": "\n".join(
                    [
                        'resource "aws_iam_role_policy" "artifacts" {',
                        '  count       = var.enabled && trimspace(var.instance_role_name) != "" ? 1 : 0',
                        '  name_prefix = substr("${var.project_name}-${var.environment}-artifacts-", 0, 38)',
                        "  role        = var.instance_role_name",
                        "}",
                    ]
                ),
            },
        ]

        self.assertTrue(_legacy_runtime_bundle_needs_remediation(files))

        patched_files, remediation = _remediate_legacy_runtime_bundle(files, None)
        patched = patched_files[0]["content"]

        self.assertTrue(remediation["artifacts_policy_count_known_at_plan"])
        self.assertIn("count       = var.enabled ? 1 : 0", patched)
        self.assertNotIn("trimspace(var.instance_role_name)", patched)
        self.assertIn("role        = var.instance_role_name", patched)

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

    def test_skips_nginx_ingress_rewrite_when_port_80_already_open(self) -> None:
        files = [
            {
                "path": "terraform/modules/compute/main.tf",
                "content": '\n'.join(
                    [
                        'resource "aws_security_group" "app" {',
                        "  ingress {",
                        "    from_port   = 80",
                        "    to_port     = 80",
                        '    protocol    = "tcp"',
                        '    cidr_blocks = ["0.0.0.0/0"]',
                        "  }",
                        "  ingress {",
                        "    from_port   = var.app_port",
                        "    to_port     = var.app_port",
                        '    protocol    = "tcp"',
                        '    cidr_blocks = ["0.0.0.0/0"]',
                        "  }",
                        "}",
                        'module "ec2" {',
                        '  user_data = join("\\n", [',
                        '    "#!/bin/bash",',
                        '    "dnf install -y nginx"',
                        "  ])",
                        "}",
                    ]
                ),
            },
        ]
        patched_files, remediation = _remediate_legacy_runtime_bundle(files, None)
        self.assertFalse(remediation.get("legacy_nginx_ingress_port_fixed"))
        self.assertIn("from_port   = var.app_port", patched_files[0]["content"])

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


class Ec2ModuleV5CompatTests(unittest.TestCase):
    def test_rewrites_object_root_block_device_to_list(self) -> None:
        source = """
module "ec2" {
  source = "terraform-aws-modules/ec2-instance/aws"
  version = "5.8.0"
  create_security_group = false
  root_block_device = {
    encrypted   = true
    volume_type = "gp3"
    volume_size = 8
  }
  tags = {}
}

module "alb" {
  source = "terraform-aws-modules/alb/aws"
  create_security_group = false
}
"""
        rewritten, changed = rewrite_ec2_module_v5_compat(source)
        self.assertTrue(changed)
        ec2_slice = rewritten.split('module "alb"')[0]
        self.assertNotIn("create_security_group", ec2_slice)
        self.assertIn("root_block_device = [{", rewritten)
        self.assertIn("create_security_group = false", rewritten.split('module "alb"')[1])

    def test_detects_stale_ec2_module_for_remediation(self) -> None:
        files = [
            {
                "path": "terraform/modules/compute/main.tf",
                "content": """
module "ec2" {
  root_block_device = {
    encrypted = true
    volume_type = "gp3"
    volume_size = 8
  }
}
""",
            }
        ]
        self.assertTrue(_legacy_runtime_bundle_needs_remediation(files))
        patched, remediation = _remediate_legacy_runtime_bundle(files, {})
        self.assertTrue(remediation.get("ec2_module_v5_compat_rewritten"))
        content = str(patched[0]["content"])
        self.assertIn("root_block_device = [{", content)

    def test_leaves_list_root_block_device_alone(self) -> None:
        source = """
module "ec2" {
  root_block_device = [{
    encrypted = true
    volume_type = "gp3"
    volume_size = 8
  }]
}
"""
        rewritten, changed = rewrite_ec2_module_v5_compat(source)
        self.assertFalse(changed)
        self.assertEqual(rewritten, source)


class KeyPairReuseRemediationTests(unittest.TestCase):
    def test_repairs_key_pair_variable_with_two_single_line_arguments(self) -> None:
        files = [
            {
                "path": "terraform/modules/compute/variables.tf",
                "content": 'variable "existing_ec2_key_pair_name" { type = string default = "" }\n',
            }
        ]
        self.assertTrue(_legacy_runtime_bundle_needs_remediation(files))
        patched, remediation = _remediate_legacy_runtime_bundle(files, {})
        content = str(patched[0]["content"])
        self.assertTrue(remediation.get("legacy_single_line_variable_blocks_rewritten"))
        self.assertIn('variable "existing_ec2_key_pair_name" {\n', content)
        self.assertIn("  type    = string\n", content)
        self.assertIn('  default = ""\n', content)
        self.assertNotIn('{ type = string default = "" }', content)

    def test_key_reuse_remediation_does_not_gate_ec2_module_count(self) -> None:
        # Bundle already has key-pair reuse locals/count; second pass must not
        # rewrite module.ec2 count to !local.use_existing_key.
        files = [
            {
                "path": "terraform/modules/compute/main.tf",
                "content": """
locals {
  use_existing_key = trimspace(var.existing_ec2_key_pair_name) != ""
  ec2_key_name     = local.use_existing_key ? trimspace(var.existing_ec2_key_pair_name) : aws_key_pair.generated[0].key_name
}

resource "tls_private_key" "generated" {
  count     = var.enabled && !local.use_existing_key ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "generated" {
  count      = var.enabled && !local.use_existing_key ? 1 : 0
  key_name   = "${var.project_name}-${var.environment}-key"
  public_key = tls_private_key.generated[0].public_key_openssh
}

module "ec2" {
  count    = var.enabled ? 1 : 0
  key_name = local.ec2_key_name
}
""",
            }
        ]
        # Force remediator path via corrupted EC2 count so needs_remediation is true.
        files[0]["content"] = files[0]["content"].replace(
            "count    = var.enabled ? 1 : 0",
            "count    = var.enabled && !local.use_existing_key ? 1 : 0",
        )
        self.assertTrue(_legacy_runtime_bundle_needs_remediation(files))
        patched, remediation = _remediate_legacy_runtime_bundle(files, {})
        content = str(patched[0]["content"])
        self.assertTrue(
            remediation.get("legacy_ec2_count_ungated_from_key_reuse")
            or remediation.get("ec2_module_v5_compat_rewritten")
        )
        ec2_slice = content.split('module "ec2"')[1]
        self.assertRegex(ec2_slice, r"count\s*=\s*var\.enabled\s*\?\s*1\s*:\s*0")
        self.assertNotRegex(
            ec2_slice,
            r"count\s*=\s*var\.enabled\s*&&\s*!local\.use_existing_key",
        )
        key_slice = content.split('module "ec2"')[0]
        self.assertNotIn("var.enabled && !local.use_existing_key", key_slice)
        self.assertIn("${var.project_name}-${var.environment}-${var.ec2_key_rotation}-key", key_slice)
        self.assertIn("use_existing_key = false", key_slice)


    def test_second_pass_does_not_bleed_key_count_into_ec2(self) -> None:
        files = [
            {
                "path": "terraform/modules/compute/main.tf",
                "content": """
locals {
  use_existing_key = trimspace(var.existing_ec2_key_pair_name) != ""
  ec2_key_name     = local.use_existing_key ? trimspace(var.existing_ec2_key_pair_name) : aws_key_pair.generated[0].key_name
}

resource "tls_private_key" "generated" {
  count     = var.enabled && !local.use_existing_key ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "generated" {
  count      = var.enabled && !local.use_existing_key ? 1 : 0
  key_name   = "${var.project_name}-${var.environment}-key"
  public_key = tls_private_key.generated[0].public_key_openssh
}

module "ec2" {
  count    = var.enabled ? 1 : 0
  key_name = local.ec2_key_name
  root_block_device = {
    encrypted = true
  }
}
""",
            }
        ]
        self.assertTrue(_legacy_runtime_bundle_needs_remediation(files))
        patched, _ = _remediate_legacy_runtime_bundle(files, {})
        content = str(patched[0]["content"])
        ec2_slice = content.split('module "ec2"')[1]
        self.assertRegex(ec2_slice, r"count\s*=\s*var\.enabled\s*\?\s*1\s*:\s*0")
        self.assertNotRegex(
            ec2_slice,
            r"count\s*=\s*var\.enabled\s*&&\s*!local\.use_existing_key",
        )
        key_slice = content.split('module "ec2"')[0]
        self.assertNotIn("var.enabled && !local.use_existing_key", key_slice)
        self.assertIn("${var.project_name}-${var.environment}-${var.ec2_key_rotation}-key", key_slice)


class UniqueEc2KeyPairTests(unittest.TestCase):
    def test_ensure_unique_key_rewrites_static_name_and_disables_reuse(self) -> None:
        files = [
            {
                "path": "terraform/variables.tf",
                "content": 'variable "project_name" { type = string }\n',
            },
            {
                "path": "terraform/modules/compute/main.tf",
                "content": """
locals {
  use_existing_key = trimspace(var.existing_ec2_key_pair_name) != ""
  ec2_key_name     = local.use_existing_key ? trimspace(var.existing_ec2_key_pair_name) : aws_key_pair.generated[0].key_name
}

resource "tls_private_key" "generated" {
  count     = var.enabled && !local.use_existing_key ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "generated" {
  count      = var.enabled && !local.use_existing_key ? 1 : 0
  key_name   = "${var.project_name}-${var.environment}-key"
  public_key = tls_private_key.generated[0].public_key_openssh
}
""",
            },
        ]
        patched, details = _ensure_unique_ec2_key_pair(files)
        combined = "\n".join(str(item["content"]) for item in patched)
        self.assertTrue(details.get("unique_ec2_key_rotation_var_added"))
        self.assertTrue(details.get("unique_ec2_key_name_rewritten"))
        self.assertTrue(details.get("unique_ec2_key_always_generated"))
        self.assertIn('variable "ec2_key_rotation"', combined)
        self.assertIn("${var.project_name}-${var.environment}-${var.ec2_key_rotation}-key", combined)
        self.assertNotIn("var.enabled && !local.use_existing_key", combined)
        self.assertIn("use_existing_key = false", combined)

    def test_database_env_from_secret_includes_url(self) -> None:
        env = _database_env_from_secret({
            "username": "app",
            "password": "p@ss:word",
            "host": "db.internal",
            "port": 5432,
            "dbname": "appdb",
            "engine": "postgres",
        })
        self.assertIn("PGPASSWORD=p@ss:word", env)
        self.assertIn("DATABASE_URL=postgresql://app:p%40ss%3Aword@db.internal:5432/appdb", env)

    def test_database_env_from_secret_uses_rds_endpoint_fallback(self) -> None:
        env = _database_env_from_secret(
            {
                "username": "app",
                "password": "p@ss:word",
                "port": 5432,
                "dbname": "appdb",
            },
            rds_endpoint="postgres.rds.amazonaws.com",
        )
        self.assertIn("DATABASE_URL=postgresql://app:p%40ss%3Aword@postgres.rds.amazonaws.com:5432/appdb", env)

    def test_collect_one_time_credentials_names_pem_with_instance_id(self) -> None:
        creds = _collect_one_time_credentials(
            {
                "generated_ec2_private_key_pem": "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
                "ec2_key_name": "ifca-prod-a1b2c3d4-key",
                "ec2_instance_id": "i-07e9f26a97ffe42ed",
            },
            project_name="ifca",
            aws_region="eu-north-1",
            aws_access_key_id="",
            aws_secret_access_key="",
            aws_session_token=None,
        )
        self.assertEqual(creds["key_file_name"], "ifca-prod-a1b2c3d4-key-i-07e9f26a97ffe42ed.pem")
        self.assertTrue(creds["download_once"])
        self.assertIn("BEGIN RSA PRIVATE KEY", creds["private_key_pem"])


class AwsProviderRegistryPinTests(unittest.TestCase):
    def test_rewrites_aws_provider_6_to_registry_5x_when_ec2_v5_present(self) -> None:
        files = [
            {
                "path": "terraform/versions.tf",
                "content": """
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
""",
            },
            {
                "path": "terraform/modules/compute/main.tf",
                "content": """
module "ec2" {
  source  = "terraform-aws-modules/ec2-instance/aws"
  version = "5.8.0"
}
""",
            },
        ]
        patched = _normalize_aws_provider_to_registry_pin(files, {})
        versions = str(patched[0]["content"])
        self.assertIn('version = "~> 5.100.0"', versions)
        self.assertNotIn("~> 6.0", versions)


class MissingDefaultVpcTests(unittest.TestCase):
    def test_detects_no_matching_ec2_vpc_error(self) -> None:
        self.assertTrue(
            _is_missing_default_vpc_error(
                "Error: no matching EC2 VPC found with data.aws_vpc.default[0], "
                'on main.tf line 31, in data "aws_vpc" "default":'
            )
        )
        self.assertTrue(_is_missing_default_vpc_error("Default VPC not found in eu-north-1"))
        self.assertTrue(_is_missing_default_vpc_error("no default VPC in this region"))
        self.assertFalse(_is_missing_default_vpc_error("VpcLimitExceeded"))
        self.assertFalse(_is_missing_default_vpc_error(""))


class TransientAwsApiErrorTests(unittest.TestCase):
    def test_classifies_docker_dns_failure_during_rds_wait(self) -> None:
        log = (
            'Error: waiting for RDS DB Instance (postgres-83a1d527) create: operation error RDS: '
            'DescribeDBInstances, https response error StatusCode: 0, RequestID: , request send failed, '
            'Post "https://rds.eu-north-1.amazonaws.com/": dial tcp: lookup rds.eu-north-1.amazonaws.com '
            'on 192.168.65.7:53: no such host'
        )
        self.assertTrue(_is_transient_aws_api_error(log))
        message = _transient_aws_api_error_message(log)
        self.assertIn("postgres-83a1d527", message)
        self.assertIn("Redeploy", message)
        self.assertIn("do not destroy", message.lower())

    def test_ignores_quota_and_auth_failures(self) -> None:
        self.assertFalse(_is_transient_aws_api_error("VcpuLimitExceeded: you have reached"))
        self.assertFalse(_is_transient_aws_api_error("UnauthorizedOperation: not authorized"))
        self.assertFalse(_is_transient_aws_api_error(""))

    def test_terraform_containers_use_public_dns(self) -> None:
        kwargs = _terraform_run_kwargs("vol-1", {"AWS_DEFAULT_REGION": "eu-north-1"})
        self.assertEqual(kwargs["dns"], ["8.8.8.8", "1.1.1.1"])
        self.assertEqual(kwargs["volumes"]["vol-1"]["bind"], "/workspace")


class MissingDefaultVpcRuntimeTests(unittest.TestCase):
    def test_region_has_default_vpc_true_false_or_unknown(self) -> None:
        class Present:
            def describe_vpcs(self, Filters=None):
                return {"Vpcs": [{"VpcId": "vpc-123"}]}

        class Absent:
            def describe_vpcs(self, Filters=None):
                return {"Vpcs": []}

        class Denied:
            def describe_vpcs(self, Filters=None):
                raise RuntimeError("AccessDenied")

        self.assertTrue(_region_has_default_vpc(Present()))
        self.assertFalse(_region_has_default_vpc(Absent()))
        self.assertIsNone(_region_has_default_vpc(Denied()))

    def test_rewrites_hard_default_vpc_lookup_to_optional_list(self) -> None:
        files = [
            {
                "path": "terraform/main.tf",
                "content": """
data "aws_vpc" "default" {
  count   = var.use_default_vpc ? 1 : 0
  default = true
}

data "aws_subnets" "default" {
  count = var.use_default_vpc ? 1 : 0
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default[0].id]
  }
}

resource "aws_vpc" "main" {
  count                = var.use_default_vpc ? 0 : 1
  cidr_block           = "10.52.0.0/16"
}

locals {
  selected_vpc_id = var.use_default_vpc ? data.aws_vpc.default[0].id : aws_vpc.main[0].id
}
""",
            }
        ]
        patched, remediation = _rewrite_hard_default_vpc_lookup(files)
        content = str(patched[0]["content"])
        self.assertTrue(remediation["default_vpc_lookup_softened"])
        self.assertIn('data "aws_vpcs" "default"', content)
        self.assertIn("local.has_default_vpc", content)
        self.assertNotIn("default = true", content)
        self.assertIn("count = local.has_default_vpc ? 1 : 0", content)
        self.assertIn("count                = local.has_default_vpc ? 0 : 1", content)
        self.assertIn("selected_vpc_id = local.has_default_vpc ? data.aws_vpc.default[0].id", content)
        self.assertIn("deplai_prefer_default_vpc = var.use_default_vpc", content)
        self.assertNotIn("try(var.use_default_vpc, true)", content)

    def test_skips_rewrite_when_default_vpc_lookup_is_already_soft(self) -> None:
        files = [
            {
                "path": "terraform/main.tf",
                "content": """
data "aws_vpcs" "default" {
  filter {
    name   = "isDefault"
    values = ["true"]
  }
}

locals {
  has_default_vpc = var.use_default_vpc && length(data.aws_vpcs.default.ids) > 0
}

data "aws_vpc" "default" {
  count = local.has_default_vpc ? 1 : 0
  id    = data.aws_vpcs.default.ids[0]
}
""",
            }
        ]
        patched, remediation = _rewrite_hard_default_vpc_lookup(files)
        self.assertFalse(remediation["default_vpc_lookup_softened"])
        self.assertEqual(patched[0]["content"], files[0]["content"])

    def test_rewrite_stays_inside_networking_module_for_enterprise_bundle(self) -> None:
        files = [
            {
                "path": "terraform/main.tf",
                "content": """
module "networking" {
  source           = "./modules/networking"
  use_existing_vpc = var.use_existing_vpc || var.use_default_vpc
}
""",
            },
            {
                "path": "terraform/variables.tf",
                "content": """
variable "use_existing_vpc" {
  type    = bool
  default = false
}

variable "use_default_vpc" {
  type    = bool
  default = false
}
""",
            },
            {
                "path": "terraform/modules/networking/main.tf",
                "content": """
data "aws_vpc" "default" {
  count   = var.use_existing_vpc ? 1 : 0
  default = true
}

data "aws_subnets" "default" {
  count = var.use_existing_vpc ? 1 : 0
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default[0].id]
  }
}

resource "aws_vpc" "main" {
  count                = var.use_existing_vpc || var.use_registry_vpc ? 0 : 1
  cidr_block           = "10.42.0.0/16"
}

locals {
  vpc_id = var.use_existing_vpc ? data.aws_vpc.default[0].id : aws_vpc.main[0].id
}
""",
            },
            {
                "path": "terraform/modules/networking/variables.tf",
                "content": """
variable "use_existing_vpc" { type = bool }
variable "use_registry_vpc" {
  type    = bool
  default = false
}
""",
            },
        ]
        patched, remediation = _rewrite_hard_default_vpc_lookup(files)
        root = str(patched[0]["content"])
        networking = str(patched[2]["content"])
        networking_vars = str(patched[3]["content"])
        self.assertTrue(remediation["default_vpc_lookup_softened"])
        self.assertIn("use_existing_vpc = var.use_existing_vpc || var.use_default_vpc", root)
        self.assertNotIn("local.has_default_vpc", root)
        self.assertIn('data "aws_vpcs" "default"', networking)
        self.assertIn("deplai_prefer_default_vpc = var.use_existing_vpc", networking)
        self.assertNotIn("try(var.use_default_vpc, true)", networking)
        self.assertNotIn("var.use_default_vpc", networking)
        self.assertIn("count = local.has_default_vpc ? 1 : 0", networking)
        self.assertIn("count                = local.has_default_vpc || var.use_registry_vpc ? 0 : 1", networking)
        self.assertIn("vpc_id = local.has_default_vpc ? data.aws_vpc.default[0].id", networking)
        self.assertIn('variable "use_existing_vpc"', networking_vars)


class TerraformApplyRootVariableTests(unittest.TestCase):
    def test_cli_vars_ignore_module_only_use_default_vpc(self) -> None:
        files = [
            {
                "path": "terraform/variables.tf",
                "content": 'variable "aws_region" {\n  type = string\n}\n',
            },
            {
                "path": "terraform/modules/networking/variables.tf",
                "content": 'variable "use_default_vpc" {\n  type = bool\n  default = true\n}\n',
            },
        ]
        all_text = _collect_terraform_text(files)
        root_text = _collect_root_terraform_text(files)
        self.assertTrue(_terraform_has_variable(all_text, "use_default_vpc"))
        self.assertFalse(_terraform_has_variable(root_text, "use_default_vpc"))
        self.assertTrue(_terraform_has_variable(root_text, "aws_region"))


class TerraformApplyEc2FailClosedTests(unittest.TestCase):
    def test_detects_registry_ec2_module(self) -> None:
        tf_text = """
module "ec2" {
  source  = "terraform-aws-modules/ec2-instance/aws"
  version = "5.8.0"
}
"""
        self.assertTrue(_terraform_has_aws_instance(tf_text))

    def test_runtime_bundle_with_disabled_rds_still_requests_ec2(self) -> None:
        files = [
            {
                "path": "terraform/main.tf",
                "content": """
module "ec2" {
  source  = "terraform-aws-modules/ec2-instance/aws"
  version = "5.8.0"
}
resource "aws_db_instance" "app" {
  count = var.enable_rds ? 1 : 0
}
""",
            },
            {
                "path": "terraform/terraform.tfvars",
                "content": 'enable_ec2 = true\nenable_rds = false\n',
            },
        ]
        tf_text = _collect_terraform_text(files)
        tfvars = _collect_tfvars_text(files)
        self.assertTrue(_bundle_requests_ec2(tf_text, tfvars))

    def test_static_site_strategy_does_not_require_ec2(self) -> None:
        tf_text = """
module "ec2" {
  source  = "terraform-aws-modules/ec2-instance/aws"
  version = "5.8.0"
}
"""
        tfvars = 'compute_strategy = "s3_cloudfront"\n'
        self.assertFalse(_bundle_requests_ec2(tf_text, tfvars))

    def test_missing_ec2_is_an_error_even_with_rds_in_bundle(self) -> None:
        error = _missing_required_ec2_error(
            requests_ec2=True,
            ec2_fallback_applied=False,
            ec2_state_resources=[],
            ec2_output_evidence={},
        )
        self.assertIsNotNone(error)
        self.assertIn("no EC2 instance", error or "")

    def test_quota_fallback_without_instance_is_an_error(self) -> None:
        error = _missing_required_ec2_error(
            requests_ec2=True,
            ec2_fallback_applied=True,
            ec2_state_resources=[],
            ec2_output_evidence={},
        )
        self.assertIsNotNone(error)
        self.assertIn("quota fallback", error or "")

    def test_state_list_finds_nested_registry_instance(self) -> None:
        rows = _ec2_addresses_from_state_list(
            "module.compute.module.ec2[0].aws_instance.this[0]\naws_security_group.app\n"
        )
        self.assertEqual(rows, ["module.compute.module.ec2[0].aws_instance.this[0]"])


class TerraformApplyRdsEngineVersionTests(unittest.TestCase):
    def test_canonicalizes_docker_latest_and_retired_minors(self) -> None:
        self.assertEqual(_canonical_postgres_engine_version("latest"), "15.17")
        self.assertEqual(_canonical_postgres_engine_version("16-alpine"), "16.13")
        self.assertEqual(_canonical_postgres_engine_version("15.5"), "15.17")
        self.assertEqual(_canonical_postgres_engine_version("15.17"), "15.17")

    def test_rewrites_latest_variable_default_before_apply(self) -> None:
        files = [
            {
                "path": "terraform/variables.tf",
                "content": 'variable "postgres_engine_version" {\n  type    = string\n  default = "latest"\n}\n',
            },
            {
                "path": "terraform/modules/data/main.tf",
                "content": 'resource "aws_db_instance" "postgres" {\n  engine_version = var.postgres_engine_version\n}\n',
            },
            {
                "path": "terraform/terraform.tfvars",
                "content": 'project_name = "demo"\n',
            },
        ]
        patched = _normalize_rds_engine_versions(files)
        variables = str(patched[0]["content"])
        self.assertIn('default = "15.17"', variables)
        self.assertNotIn('default = "latest"', variables)
        data = str(patched[1]["content"])
        self.assertIn('contains(["", "latest", "lts", "stable", "current", "alpine"]', data)
        self.assertIn("15.17", data)
        tfvars = str(patched[2]["content"])
        self.assertIn('postgres_engine_version = "15.17"', tfvars)

    def test_rewrites_var_engine_version_assignment_before_apply(self) -> None:
        files = [
            {
                "path": "terraform/modules/data/main.tf",
                "content": 'resource "aws_db_instance" "postgres" {\n  engine_version              = var.postgres_engine_version\n}\n',
            },
            {
                "path": "terraform/variables.tf",
                "content": 'variable "postgres_engine_version" {\n  type    = string\n  default = "latest"\n}\n',
            },
        ]
        patched = _normalize_rds_engine_versions(files)
        data = str(patched[0]["content"])
        self.assertIn("contains([", data)
        self.assertNotIn("engine_version              = var.postgres_engine_version", data)


class AppArtifactTarballTests(unittest.TestCase):
    def test_rewrite_app_artifact_filemd5_guard(self) -> None:
        before = '  etag   = filemd5("${path.root}/artifacts/app.tgz")\n'
        after, changed = rewrite_app_artifact_filemd5_guard(before)
        self.assertTrue(changed)
        self.assertIn("fileexists", after)
        self.assertIn("filemd5", after)

    def test_remediate_app_artifact_filemd5_updates_compute_module(self) -> None:
        files = [
            {
                "path": "terraform/modules/compute/main.tf",
                "content": (
                    'resource "aws_s3_object" "app" {\n'
                    '  count  = var.enabled && fileexists("${path.root}/artifacts/app.tgz") ? 1 : 0\n'
                    '  etag   = filemd5("${path.root}/artifacts/app.tgz")\n'
                    "}\n"
                ),
            }
        ]
        patched, remediation = _remediate_app_artifact_filemd5(files)
        self.assertTrue(remediation["app_artifact_filemd5_guarded"])
        self.assertIn("fileexists", str(patched[0]["content"]))

    def test_inject_app_artifact_from_tfvars_base64(self) -> None:
        import base64
        from unittest import mock

        payload = b"fake-tarball-bytes"
        encoded = base64.b64encode(payload).decode("ascii")
        files = [
            {
                "path": "terraform/terraform.tfvars",
                "content": f'app_archive_base64 = "{encoded}"\n',
            }
        ]
        with mock.patch("deployment_packager.load_persisted_app_tarball", return_value=None):
            patched = _inject_app_artifact_tarball(files, None, "demo-app")
        paths = [str(item.get("path", "")) for item in patched]
        self.assertIn("terraform/artifacts/app.tgz", paths)
        artifact = next(item for item in patched if item["path"] == "terraform/artifacts/app.tgz")
        self.assertEqual(base64.b64decode(str(artifact["content"])), payload)

    def test_inject_app_artifact_from_artifact_source_and_persisted_store(self) -> None:
        import base64
        from unittest import mock

        payload = b"persisted-tarball"
        files = [
            {
                "path": "terraform/terraform.tfvars",
                "content": 'artifact_source = "pkg-demo-123"\n',
            }
        ]
        with mock.patch(
            "deployment_packager.load_persisted_app_tarball",
            return_value=("pkg-demo-123", payload),
        ) as loader:
            patched = _inject_app_artifact_tarball(files, {"deployment_package_id": "pkg-demo-123"}, "demo-app")
        loader.assert_called()
        artifact = next(item for item in patched if item["path"] == "terraform/artifacts/app.tgz")
        self.assertEqual(base64.b64decode(str(artifact["content"])), payload)


class EcrPullPolicyInjectTests(unittest.TestCase):
    def test_injects_ecr_pull_when_instance_role_exists(self) -> None:
        files = [
            {
                "path": "terraform/modules/iam/main.tf",
                "content": 'resource "aws_iam_role" "ec2" {\n  name_prefix = "app-"\n}\n',
                "encoding": "utf-8",
            }
        ]
        patched = _ensure_ecr_pull_policy(files)
        text = str(patched[0]["content"])
        self.assertIn("ecr:GetAuthorizationToken", text)
        self.assertIn("ecr:BatchGetImage", text)

    def test_skips_when_ecr_permission_already_present(self) -> None:
        files = [
            {
                "path": "terraform/modules/iam/main.tf",
                "content": 'resource "aws_iam_role" "ec2" {}\n# ecr:GetAuthorizationToken already\n',
                "encoding": "utf-8",
            }
        ]
        patched = _ensure_ecr_pull_policy(files)
        self.assertEqual(patched[0]["content"], files[0]["content"])


if __name__ == "__main__":
    unittest.main()
