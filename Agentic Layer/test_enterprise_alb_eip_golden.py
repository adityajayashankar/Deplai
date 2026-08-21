"""Golden test: consultant need_alb+need_eip must change rendered HCL (not profile JSON only)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
for candidate in (ROOT, REPO, REPO / "Terraform Agent"):
    if candidate.exists() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from claude_deployment_pipeline import _apply_consultant_decision_to_profile
from terraform_agent.agent.engine.deployment_profile import build_profile_bundle
from terraform_agent.agent.module_catalog import MODULE_CATALOG


class ConsultantDecisionAlbEipGoldenTests(unittest.TestCase):
    def test_apply_decision_need_alb_eip_produces_alb_and_eip_hcl(self) -> None:
        profile = {
            "document_kind": "deployment_profile",
            "workspace": "slice-demo",
            "project_name": "slice-demo",
            "application_type": "web_app",
            "environment": "dev",
            "compute": {
                "strategy": "ec2",
                "services": [{"id": "web", "process_type": "web", "port": 8080}],
            },
            "networking": {"vpc": "new", "nat_gateway": False, "load_balancer": {}, "ports_exposed": [8080]},
            "data_layer": [],
            "runtime_config": {},
        }
        decision = {
            "need_alb": True,
            "need_eip": True,
            "components": ["ec2", "alb", "eip"],
            "stack_config": {
                "alb": {"enabled": True, "type": "application"},
                "eip": {"enabled": True, "associate_with": "ec2"},
            },
        }
        enriched = _apply_consultant_decision_to_profile(
            profile_payload=profile,
            consultant_decision_json=decision,
        )
        self.assertTrue(enriched.get("need_alb"))
        self.assertTrue(enriched.get("need_eip"))
        self.assertTrue((enriched.get("networking") or {}).get("load_balancer"))
        self.assertTrue((enriched.get("networking") or {}).get("elastic_ip"))

        files, _warnings = build_profile_bundle(
            payload=enriched,
            provider_version="~> 5.0",
            state_bucket="",
            lock_table="",
            aws_region="eu-north-1",
            context_summary="golden alb+eip",
            website_index_html="<html>ok</html>",
        )
        compute = files["terraform/modules/compute/main.tf"]
        outputs = files["terraform/outputs.tf"]

        self.assertIn('module "alb"', compute)
        self.assertIn(MODULE_CATALOG["alb"]["source"], compute)
        self.assertIn('resource "aws_eip" "app"', compute)
        self.assertIn('output "alb_dns_name"', outputs)
        self.assertIn("module.compute.alb_dns_name", outputs)
        self.assertIn('output "elastic_ip"', outputs)
        self.assertIn('output "app_url"', outputs)
        self.assertIn("enable_alb                  = local.enable_alb", files["terraform/main.tf"])
        self.assertIn("enable_eip                  = local.enable_eip", files["terraform/main.tf"])

    def test_module_catalog_pins_vertical_slice(self) -> None:
        for key in ("vpc", "ec2_instance", "alb", "security_group", "rds", "elasticache", "eip"):
            self.assertIn(key, MODULE_CATALOG)
        self.assertEqual(MODULE_CATALOG["alb"]["source"], "terraform-aws-modules/alb/aws")
        self.assertTrue(str(MODULE_CATALOG["alb"]["version"]).startswith("9."))


if __name__ == "__main__":
    unittest.main()
