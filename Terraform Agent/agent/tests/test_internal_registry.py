"""Tests for the curated internal Terraform registry."""

from __future__ import annotations

import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
for candidate in (ROOT, REPO, REPO / "Terraform Agent"):
    if candidate.exists() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from terraform_agent.agent.internal_registry import (  # noqa: E402
    assert_catalog_pin_policy,
    catalog_summary,
    enforce_registry_contracts_on_text,
    filter_allowlisted_edits,
    get_contract,
    get_edit_schema,
    get_module,
    list_services,
    load_catalog,
    module_source_block,
    render_snippet,
    rewrite_ec2_module_v5_compat,
    select_allowlisted_edits,
)
from terraform_agent.agent.engine.deployment_profile import build_profile_bundle  # noqa: E402
from terraform_agent.agent.module_catalog import MODULE_CATALOG, get_module as legacy_get_module  # noqa: E402


class InternalRegistryCatalogTests(unittest.TestCase):
    def test_core_services_present(self) -> None:
        services = set(list_services())
        for required in (
            "vpc",
            "ec2_instance",
            "alb",
            "security_group",
            "rds",
            "elasticache",
            "s3_cloudfront",
            "cloudfront",
            "s3_bucket",
            "lambda",
            "eip",
        ):
            self.assertIn(required, services)

    def test_cloudfront_alias_resolves_to_s3_stack(self) -> None:
        pin = get_module("cloudfront")
        self.assertEqual(pin["id"], "s3_cloudfront")
        self.assertEqual(pin["resource"], "aws_cloudfront_distribution")
        self.assertEqual(pin["template"], "s3_cloudfront")
        self.assertEqual(pin["snippet"], "s3_cloudfront_native.tf.tmpl")
        self.assertEqual(get_module("cdn")["id"], "s3_cloudfront")
        self.assertEqual(get_module("static_site")["id"], "s3_cloudfront")

        summary = {row["id"]: row for row in catalog_summary()}
        self.assertIn("cloudfront", summary)
        self.assertIn("s3_cloudfront", summary)
        self.assertEqual(summary["s3_cloudfront"]["resource"], "aws_cloudfront_distribution")
        self.assertIn("cloudfront", summary["s3_cloudfront"].get("aliases") or [])
        self.assertIn("cdn", summary["s3_cloudfront"].get("aliases") or [])

        contract = get_contract("cloudfront")
        self.assertIn("cloudfront_url", contract.get("outputs") or [])

        from terraform_agent.agent.template_registry import get_template_path

        template_dir = get_template_path("cloudfront")
        self.assertEqual(template_dir.name, "s3_cloudfront")
        self.assertTrue((template_dir / "main.tf").is_file())
        self.assertTrue((template_dir / "variables.tf").is_file())
        self.assertTrue((template_dir / "outputs.tf").is_file())

        from terraform_agent.agent.output_parser import parse_outputs

        parsed = parse_outputs(
            {
                "cloudfront_url": "https://d111.cloudfront.net",
                "cloudfront_domain_name": "d111.cloudfront.net",
                "website_bucket_name": "demo-site",
                "distribution_id": "E123ABC",
                "region": "eu-north-1",
            },
            "cloudfront",
        )
        keys = {item["key"] for item in parsed["outputs"]}
        self.assertEqual(
            keys,
            {
                "cloudfront_url",
                "cloudfront_domain_name",
                "website_bucket_name",
                "distribution_id",
                "region",
            },
        )

    def test_s3_bucket_module_pin_matches_registry(self) -> None:
        pin = get_module("s3_bucket")
        self.assertEqual(pin["source"], "terraform-aws-modules/s3-bucket/aws")
        # 5.15.4 needs aws >= 6.42; stay on 4.11.0 until EC2/ALB migrate to provider 6.
        self.assertEqual(pin["version"], "4.11.0")
        from terraform_agent.agent.internal_registry import load_catalog

        provider = load_catalog().get("provider") or {}
        self.assertEqual(provider.get("constraint"), "~> 5.100.0")
        self.assertEqual(provider.get("tested_version"), "5.100.0")

    def test_legacy_module_catalog_compatible(self) -> None:
        self.assertIn("ec2_instance", MODULE_CATALOG)
        self.assertIn("s3_cloudfront", MODULE_CATALOG)
        self.assertIn("cloudfront", MODULE_CATALOG)
        pin = legacy_get_module("ec2")
        self.assertEqual(pin["version"], "5.8.0")
        self.assertEqual(pin["source"], "terraform-aws-modules/ec2-instance/aws")
        self.assertEqual(legacy_get_module("cloudfront")["id"], "s3_cloudfront")

    def test_module_pins_are_exact_not_open_ended(self) -> None:
        assert_catalog_pin_policy()
        block = module_source_block("alb")
        self.assertIn('version = "9.17.0"', block)
        self.assertNotIn("~>", block)
        self.assertNotIn(">=", block)
        provider = load_catalog().get("provider") or {}
        # Provider must keep an upper bound via ~> (not bare >=)
        self.assertTrue(str(provider.get("constraint") or "").startswith("~>"))
        self.assertFalse(str(provider.get("constraint") or "").startswith(">="))
        terraform = load_catalog().get("terraform") or {}
        self.assertIn("< 1.12.0", str(terraform.get("required_version") or ""))

    def test_ec2_contract_forbids_v6_only_args(self) -> None:
        contract = get_contract("ec2_instance")
        forbidden = set(contract.get("forbidden_args") or [])
        self.assertIn("create_security_group", forbidden)
        self.assertEqual(
            (contract.get("allowed_args") or {}).get("root_block_device", {}).get("type"),
            "list(any)",
        )

    def test_edit_schema_filters_unknown_keys(self) -> None:
        filtered = filter_allowlisted_edits(
            "ec2_instance",
            {"instance_type": "t3.small", "invented_arg": True, "app_port": 8080},
        )
        self.assertEqual(filtered, {"instance_type": "t3.small", "app_port": 8080})
        self.assertTrue(get_edit_schema("rds"))


class AgentAllowlistedEditTests(unittest.TestCase):
    def test_agent_picks_node_sizing_and_ignores_operator_stack_config(self) -> None:
        edits = select_allowlisted_edits(
            {
                "environment": "dev",
                "compute": {
                    "strategy": "ec2",
                    "services": [{"process_type": "web", "port": 8080, "cpu": 512, "memory": 1024}],
                },
                "consultant_decision": {
                    "stack_config": {
                        "ec2": {"instance_type": "m7g.16xlarge", "root_volume_size_gb": 200, "app_port": 22},
                    }
                },
            },
            app_bootstrap={"app_kind": "node"},
        )
        ec2 = edits["ec2_instance"]
        self.assertEqual(ec2["instance_type"], "t3.small")
        self.assertEqual(ec2["root_volume_size_gb"], 35)
        self.assertEqual(ec2["app_port"], 8080)
        self.assertNotEqual(ec2["instance_type"], "m7g.16xlarge")

    def test_agent_picks_prod_rds_and_redis_pins(self) -> None:
        edits = select_allowlisted_edits(
            {
                "environment": "production",
                "compute": {"strategy": "ec2", "services": [{"process_type": "web", "port": 3000, "cpu": 256}]},
                "data_layer": [
                    {"type": "postgresql", "instance_class": "db.r6g.xlarge", "engine_version": "11.0", "storage_gb": 1000},
                    {"type": "redis", "node_type": "cache.r6g.large", "engine_version": "6.2"},
                ],
            },
            app_bootstrap={"app_kind": "node"},
        )
        self.assertEqual(edits["rds"]["instance_class"], "db.t4g.small")
        self.assertEqual(edits["rds"]["engine_version"], "15.17")
        self.assertTrue(edits["rds"]["multi_az"])
        self.assertEqual(edits["elasticache"]["engine_version"], "7.0")
        self.assertEqual(edits["elasticache"]["node_type"], "cache.t4g.small")

    def test_agent_ignores_datastore_port_and_sizes_node_workspace(self) -> None:
        edits = select_allowlisted_edits(
            {
                "environment": "dev",
                "compute": {
                    "strategy": "ec2",
                    "services": [
                        {"process_type": "web", "port": 5432, "cpu": 256, "memory": 512},
                    ],
                },
            },
            app_bootstrap={
                "app_kind": "node",
                "start_command": "deplai-node-workspace",
                "app_port": 3000,
            },
        )
        ec2 = edits["ec2_instance"]
        self.assertEqual(ec2["instance_type"], "t3.medium")
        self.assertEqual(ec2["root_volume_size_gb"], 40)
        self.assertEqual(ec2["app_port"], 3000)


class InternalRegistrySnippetTests(unittest.TestCase):
    def test_ec2_snippet_is_v5_compatible(self) -> None:
        snippet = render_snippet("ec2_instance", {"root_volume_size_gb": 20})
        self.assertIn('source                      = "terraform-aws-modules/ec2-instance/aws"', snippet)
        self.assertIn('version                     = "5.8.0"', snippet)
        self.assertIn("root_block_device = [", snippet)
        self.assertNotIn("create_security_group", snippet)
        self.assertIn("volume_size = 20", snippet)
        self.assertIn("aws s3 cp", snippet)
        self.assertIn("git clone", snippet)
        self.assertIn("location /api/", snippet)
        self.assertIn("frontend/package.json", snippet)
        self.assertIn("user_data_base64", snippet)

    def test_alb_snippet_keeps_create_security_group(self) -> None:
        snippet = render_snippet("alb")
        self.assertIn("create_security_group = false", snippet)
        self.assertIn('version = "9.17.0"', snippet)

    def test_cloudfront_snippet_has_distribution_and_oac_policy(self) -> None:
        snippet = render_snippet("cloudfront")
        self.assertIn('resource "aws_cloudfront_distribution" "site"', snippet)
        self.assertIn('resource "aws_cloudfront_origin_access_control"', snippet)
        self.assertIn("AllowCloudFrontRead", snippet)
        self.assertIn("cloudfront.amazonaws.com", snippet)
        self.assertIn("PriceClass_100", snippet)


class InternalRegistryEnforceTests(unittest.TestCase):
    def test_rewrites_stale_ec2_object_root_block_device(self) -> None:
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
}

module "alb" {
  create_security_group = false
}
"""
        rewritten, changed = rewrite_ec2_module_v5_compat(source)
        self.assertTrue(changed)
        self.assertIn("root_block_device = [{", rewritten)
        self.assertNotIn("create_security_group", rewritten.split('module "alb"')[0])
        self.assertIn("create_security_group = false", rewritten.split('module "alb"')[1])

        enforced, details = enforce_registry_contracts_on_text(source)
        self.assertTrue(details.get("ec2_module_v5_compat_rewritten"))
        self.assertIn("root_block_device = [{", enforced)

    def test_ec2_count_not_gated_on_key_reuse(self) -> None:
        from agent.internal_registry import rewrite_ec2_module_count_not_gated_on_key_reuse

        source = """
resource "aws_key_pair" "generated" {
  count = var.enabled && !local.use_existing_key ? 1 : 0
}

module "ec2" {
  count = var.enabled && !local.use_existing_key ? 1 : 0
  source = "terraform-aws-modules/ec2-instance/aws"
}

resource "aws_eip" "app" {
  count    = var.enabled && var.enable_eip ? 1 : 0
  instance = module.ec2[0].id
}
"""
        rewritten, changed = rewrite_ec2_module_count_not_gated_on_key_reuse(source)
        self.assertTrue(changed)
        self.assertIn("module \"ec2\"", rewritten)
        self.assertRegex(
            rewritten,
            r'module\s+"ec2"\s*\{[\s\S]*?count\s*=\s*var\.enabled\s*\?\s*1\s*:\s*0',
        )
        self.assertNotRegex(
            rewritten,
            r'module\s+"ec2"\s*\{[\s\S]*?count\s*=\s*var\.enabled\s*&&\s*!local\.use_existing_key',
        )
        # Key pair count must stay gated on reuse.
        self.assertIn(
            "count = var.enabled && !local.use_existing_key ? 1 : 0",
            rewritten.split('module "ec2"')[0],
        )

        enforced, details = enforce_registry_contracts_on_text(source)
        self.assertTrue(details.get("ec2_count_ungated_from_key_reuse"))
        self.assertRegex(
            enforced,
            r'module\s+"ec2"\s*\{[\s\S]*?count\s*=\s*var\.enabled\s*\?\s*1\s*:\s*0',
        )


    def test_artifacts_iam_policy_count_not_gated_on_role_name(self) -> None:
        from agent.internal_registry import rewrite_artifacts_iam_policy_count_known_at_plan

        source = """
resource "aws_iam_role_policy" "artifacts" {
  count       = var.enabled && trimspace(var.instance_role_name) != "" ? 1 : 0
  name_prefix = substr("${var.project_name}-${var.environment}-artifacts-", 0, 38)
  role        = var.instance_role_name
}
"""
        rewritten, changed = rewrite_artifacts_iam_policy_count_known_at_plan(source)
        self.assertTrue(changed)
        self.assertIn("count       = var.enabled ? 1 : 0", rewritten)
        self.assertNotIn("trimspace(var.instance_role_name)", rewritten)
        self.assertIn("role        = var.instance_role_name", rewritten)

        enforced, details = enforce_registry_contracts_on_text(source)
        self.assertTrue(details.get("artifacts_policy_count_known_at_plan"))
        self.assertIn("count       = var.enabled ? 1 : 0", enforced)
        self.assertNotIn("trimspace(var.instance_role_name)", enforced)


class EnterpriseBundleRegistryGoldenTests(unittest.TestCase):
    def test_generated_compute_uses_registry_ec2_snippet(self) -> None:
        profile = {
            "document_kind": "deployment_profile",
            "workspace": "slice-demo",
            "project_name": "slice-demo",
            "application_type": "web_app",
            "environment": "dev",
            "compute": {"strategy": "ec2", "services": [{"id": "web", "process_type": "web", "port": 8080}]},
            "networking": {"vpc": "new", "nat_gateway": False, "load_balancer": {"public": True}, "ports_exposed": [8080], "elastic_ip": True},
            "need_alb": True,
            "need_eip": True,
            "data_layer": [],
            "runtime_config": {},
        }
        files, _ = build_profile_bundle(
            payload=profile,
            provider_version="~> 5.0",
            state_bucket="",
            lock_table="",
            aws_region="eu-north-1",
            context_summary="registry golden",
            website_index_html="<html>ok</html>",
            app_bootstrap={
                "repository_url": "https://github.com/acme/demo.git",
                "app_kind": "node",
                "build_command": "npm run build",
                "start_command": "npm start",
            },
        )
        compute = files["terraform/modules/compute/main.tf"]
        self.assertIn('source                      = "terraform-aws-modules/ec2-instance/aws"', compute)
        self.assertIn('version                     = "5.8.0"', compute)
        self.assertIn("root_block_device = [", compute)
        self.assertIn("volume_size = 35", compute)
        self.assertIn('default = "t3.small"', files["terraform/variables.tf"])
        self.assertIn("aws s3 cp", compute)
        self.assertIn("git clone", compute)
        self.assertIn("location /api/", compute)
        self.assertIn("var.database_secret_arn", compute)
        self.assertIn("var.ec2_key_rotation", compute)
        self.assertIn("${var.project_name}-${var.environment}-${var.ec2_key_rotation}-key", compute)
        self.assertIn("deplai_key_rotation", compute)
        self.assertNotIn("!local.use_existing_key", compute.split('module "ec2"')[0])
        self.assertIn("var.ec2_key_rotation", compute)
        self.assertIn("${var.project_name}-${var.environment}-${var.ec2_key_rotation}-key", compute)
        self.assertIn("deplai_key_rotation", compute)
        self.assertNotIn("!local.use_existing_key", compute.split('module "ec2"')[0])
        self.assertIn('resource "aws_s3_bucket" "artifacts"', compute)
        artifacts_block = compute.split('resource "aws_iam_role_policy" "artifacts"')[1].split("resource ")[0]
        self.assertIn("count       = var.enabled ? 1 : 0", artifacts_block)
        self.assertNotIn("trimspace(var.instance_role_name)", artifacts_block)
        self.assertIn("role        = var.instance_role_name", artifacts_block)
        self.assertIn("AmazonSSMManagedInstanceCore", files["terraform/modules/iam/main.tf"])
        self.assertIn("ecr:GetAuthorizationToken", files["terraform/modules/iam/main.tf"])
        self.assertIn("docker", compute)
        networking = files["terraform/modules/networking/main.tf"]
        self.assertIn('data "aws_vpcs" "default"', networking)
        self.assertNotIn("default = true", networking)
        self.assertIn('default = "15.17"', files["terraform/modules/data/variables.tf"])
        ec2_slice = compute.split('module "alb"')[0]
        self.assertNotIn("create_security_group", ec2_slice)
        self.assertIn('module "alb"', compute)
        self.assertIn('resource "aws_eip" "app"', compute)

    def test_ec2_only_bundle_still_uses_registry_ec2_module(self) -> None:
        profile = {
            "document_kind": "deployment_profile",
            "workspace": "ec2-only",
            "project_name": "ec2-only",
            "application_type": "web_app",
            "environment": "dev",
            "compute": {"strategy": "ec2", "services": [{"id": "web", "process_type": "web", "port": 8080}]},
            "networking": {"vpc": "new", "nat_gateway": False, "ports_exposed": [8080]},
            "need_alb": False,
            "need_eip": False,
            "data_layer": [],
            "runtime_config": {},
        }
        files, _ = build_profile_bundle(
            payload=profile,
            provider_version="~> 5.100.0",
            state_bucket="",
            lock_table="",
            aws_region="eu-north-1",
            context_summary="ec2 only registry",
            website_index_html="<html>ok</html>",
        )
        compute = files["terraform/modules/compute/main.tf"]
        self.assertIn('source                      = "terraform-aws-modules/ec2-instance/aws"', compute)
        self.assertIn('version                     = "5.8.0"', compute)
        self.assertNotIn('resource "aws_instance" "app"', compute)
        networking = files["terraform/modules/networking/main.tf"]
        self.assertIn("terraform-aws-modules/vpc/aws", networking)


if __name__ == "__main__":
    unittest.main()
