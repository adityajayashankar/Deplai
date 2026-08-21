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
            "s3_bucket",
            "lambda",
            "eip",
        ):
            self.assertIn(required, services)

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
        pin = legacy_get_module("ec2")
        self.assertEqual(pin["version"], "5.8.0")
        self.assertEqual(pin["source"], "terraform-aws-modules/ec2-instance/aws")

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


class InternalRegistrySnippetTests(unittest.TestCase):
    def test_ec2_snippet_is_v5_compatible(self) -> None:
        snippet = render_snippet("ec2_instance", {"root_volume_size_gb": 20})
        self.assertIn('source                      = "terraform-aws-modules/ec2-instance/aws"', snippet)
        self.assertIn('version                     = "5.8.0"', snippet)
        self.assertIn("root_block_device = [", snippet)
        self.assertNotIn("create_security_group", snippet)
        self.assertIn("volume_size = 20", snippet)

    def test_alb_snippet_keeps_create_security_group(self) -> None:
        snippet = render_snippet("alb")
        self.assertIn("create_security_group = false", snippet)
        self.assertIn('version = "9.17.0"', snippet)


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
        )
        compute = files["terraform/modules/compute/main.tf"]
        self.assertIn('source                      = "terraform-aws-modules/ec2-instance/aws"', compute)
        self.assertIn('version                     = "5.8.0"', compute)
        self.assertIn("root_block_device = [", compute)
        ec2_slice = compute.split('module "alb"')[0]
        self.assertNotIn("create_security_group", ec2_slice)
        self.assertIn('module "alb"', compute)
        self.assertIn('resource "aws_eip" "app"', compute)


if __name__ == "__main__":
    unittest.main()
