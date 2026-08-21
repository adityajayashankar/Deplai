"""Smoke: consult intakes → planner decision → registry-module Terraform → endpoint outputs.

Manual AWS acceptance (run after local stack is up with real keys):
1. Open Deployment Track, complete analysis for an EC2-capable repo.
2. In consultant chat: "peak traffic 5000 concurrent, I need a load balancer and elastic IP".
3. Approve decision; Stage 4 cost must show ALB + EIP (+ EBS) line items and a decision_hash.
4. Generate Terraform; inspect outputs for alb_dns_name, elastic_ip, app_url.
5. Apply with AKIA or ASIA+session token; deploy summary must return ALB DNS and/or EIP.
"""

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
from terraform_consult import parse_chat_intakes, run_terraform_consult


class DeployPipelineSmokeTests(unittest.TestCase):
    def test_chat_to_terraform_vertical_slice(self) -> None:
        history = [
            {
                "role": "user",
                "content": (
                    "Our peak traffic is about 5000 concurrent users and roughly "
                    "2 million requests per month. I need a load balancer and an elastic IP."
                ),
            }
        ]
        intakes = parse_chat_intakes(history)
        self.assertTrue(intakes.get("need_alb"))
        self.assertTrue(intakes.get("need_eip"))
        self.assertTrue(
            intakes.get("peak_concurrent_users") == 5000
            or intakes.get("peak_traffic") is not None
            or intakes.get("monthly_traffic") is not None
        )

        result = run_terraform_consult(
            architecture_json={"document_kind": "architecture_view", "nodes": [], "edges": []},
            repository_context={
                "language": {"primary": "javascript"},
                "frameworks": [{"name": "express"}],
                "data_stores": [],
                "processes": [{"type": "web"}],
            },
            deployment_profile=None,
            detected={"has_web_server": True, "has_database": False, "has_redis": False},
            aws_region="eu-north-1",
            conversation_history=history,
            turn_count=1,
            force_decision=True,
            workspace="smoke-slice",
            project_id="smoke-slice",
            project_name="smoke-slice",
            user_answers={},
            prior_decision=None,
        )
        decision = result.get("decision") or {}
        self.assertTrue(result.get("ready") or decision.get("need_alb"))
        self.assertTrue(decision.get("need_alb"))
        self.assertTrue(decision.get("need_eip"))
        components = {str(item).lower() for item in (decision.get("components") or [])}
        self.assertTrue("alb" in components or decision.get("need_alb"))

        profile = {
            "document_kind": "deployment_profile",
            "workspace": "smoke-slice",
            "project_name": "smoke-slice",
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
        enriched = _apply_consultant_decision_to_profile(
            profile_payload=profile,
            consultant_decision_json=decision,
        )
        files, warnings = build_profile_bundle(
            payload=enriched,
            provider_version="~> 5.0",
            state_bucket="",
            lock_table="",
            aws_region="eu-north-1",
            context_summary="smoke vertical slice",
            website_index_html="<html>ok</html>",
        )
        joined = "\n".join(files.values())
        self.assertIn("terraform-aws-modules/alb/aws", joined)
        self.assertIn("terraform-aws-modules/ec2-instance/aws", joined)
        self.assertIn('resource "aws_eip" "app"', joined)
        self.assertIn('output "alb_dns_name"', joined)
        self.assertIn('output "elastic_ip"', joined)
        self.assertIn('output "app_url"', joined)
        self.assertTrue(isinstance(warnings, list))


if __name__ == "__main__":
    unittest.main()
