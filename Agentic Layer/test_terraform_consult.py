"""Contract tests for terraform consult intake parsing and heuristic planner."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from terraform_consult import (
    build_heuristic_decision,
    parse_chat_intakes,
    parse_message_deltas,
    run_terraform_consult,
)


class TerraformConsultTests(unittest.TestCase):
    def test_parse_chat_intakes_alb_eip_traffic(self) -> None:
        history = [
            {
                "role": "user",
                "content": "We need an ALB and Elastic IP in eu-west-1. Peak concurrent users 200, monthly traffic 250k. Instance t3.small.",
            }
        ]
        intakes = parse_chat_intakes(history)
        self.assertTrue(intakes.get("need_alb"))
        self.assertTrue(intakes.get("need_eip"))
        self.assertEqual(intakes.get("region"), "eu-west-1")
        self.assertEqual(intakes.get("instance_type"), "t3.small")
        self.assertEqual(intakes.get("peak_concurrent_users"), 200)
        self.assertEqual(intakes.get("monthly_traffic"), 250000)

    def test_parse_negated_alb(self) -> None:
        history = [{"role": "user", "content": "No load balancer please, just a single EC2 with EIP"}]
        intakes = parse_chat_intakes(history)
        self.assertFalse(intakes.get("need_alb"))
        self.assertTrue(intakes.get("need_eip"))

    def test_latest_message_disables_port_routing(self) -> None:
        history = [
            {"role": "user", "content": "Need ALB and Elastic IP, peak 500"},
            {"role": "assistant", "content": "Plan ready with app_port=3000"},
            {"role": "user", "content": "disable 3000 port routing"},
        ]
        intakes = parse_chat_intakes(history)
        self.assertTrue(intakes.get("need_alb"))
        self.assertTrue(intakes.get("need_eip"))
        self.assertFalse(intakes.get("direct_port_routing"))
        self.assertEqual(intakes.get("disabled_public_port"), 3000)
        deltas = parse_message_deltas("disable 3000 port routing")
        self.assertFalse(deltas.get("direct_port_routing"))

    def test_latest_message_can_remove_alb(self) -> None:
        history = [
            {"role": "user", "content": "Need an ALB and EIP"},
            {"role": "user", "content": "remove the load balancer"},
        ]
        intakes = parse_chat_intakes(history)
        self.assertFalse(intakes.get("need_alb"))
        self.assertTrue(intakes.get("need_eip"))

    def test_heuristic_applies_direct_port_routing_off(self) -> None:
        decision = build_heuristic_decision(
            detected={"has_database": False, "has_redis": False, "database_type": "unknown"},
            intakes={"need_alb": True, "need_eip": True, "direct_port_routing": False, "disabled_public_port": 3000},
            deployment_profile={"compute": {"strategy": "ec2", "services": [{"process_type": "web", "port": 3000}]}},
            aws_region="eu-north-1",
            prior_decision={
                "components": ["vpc", "ec2", "alb", "eip"],
                "stack_config": {"ec2": {"app_port": 3000, "public_http": True}},
            },
        )
        self.assertFalse(decision["stack_config"]["ec2"]["public_http"])
        self.assertEqual(decision["stack_config"]["networking"]["ports_exposed"], [80, 443])
        self.assertTrue(any("Direct :3000" in note for note in decision["consultant_notes"]))

    def test_heuristic_respects_alb_eip(self) -> None:
        decision = build_heuristic_decision(
            detected={"has_database": False, "has_redis": False, "database_type": "unknown"},
            intakes={"need_alb": True, "need_eip": True, "monthly_traffic": 500000},
            deployment_profile={"compute": {"strategy": "ec2", "services": [{"process_type": "web", "port": 8080}]}},
            aws_region="eu-north-1",
        )
        self.assertIn("alb", decision["components"])
        self.assertIn("eip", decision["components"])
        self.assertTrue(decision["need_alb"])
        self.assertTrue(decision["need_eip"])
        self.assertIn("alb", decision["stack_config"])
        self.assertIn("eip", decision["stack_config"])
        self.assertEqual(decision["stack_config"]["ec2"]["app_port"], 8080)

    def test_run_consult_persists_and_returns_contract(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            runtime_root = Path(tmp)
            with mock.patch("terraform_consult.consult_transcript_path") as transcript_path, \
                    mock.patch("terraform_consult.consult_decision_path") as decision_path, \
                    mock.patch("terraform_consult.consult_state_path") as state_path, \
                    mock.patch("terraform_consult._llm_available", return_value=(False, "no_llm_api_keys")):
                workspace = "demo-app"
                base = runtime_root / "terraform-consult" / workspace
                base.mkdir(parents=True, exist_ok=True)
                transcript_path.side_effect = lambda _ws: base / "transcript.json"
                decision_path.side_effect = lambda _ws: base / "latest_decision.json"
                state_path.side_effect = lambda _ws: base / "state.json"

                result = run_terraform_consult(
                    architecture_json={"compute": {"strategy": "ec2"}},
                    repository_context={"language": {"primary": "python"}, "data_stores": []},
                    conversation_history=[
                        {"role": "user", "content": "Please add an ALB and Elastic IP for peak 80 users"},
                    ],
                    turn_count=0,
                    force_decision=True,
                    workspace=workspace,
                    aws_region="eu-north-1",
                )

                self.assertTrue(result["success"])
                self.assertTrue(result["ready"])
                self.assertIsInstance(result["decision"], dict)
                self.assertIn("alb", result["decision"]["components"])
                self.assertIn("eip", result["decision"]["components"])
                self.assertTrue((base / "latest_decision.json").exists())
                self.assertTrue((base / "transcript.json").exists())
                self.assertEqual(result["source"], "heuristic")
                self.assertEqual(result["fallback_reason"], "no_llm_api_keys")
                self.assertNotIn("llm_call_failed", str(result.get("assistant_message") or ""))
                self.assertNotIn("no_llm_api_keys", str(result.get("assistant_message") or ""))

    def test_run_consult_applies_followup_without_llm(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            runtime_root = Path(tmp)
            with mock.patch("terraform_consult.consult_transcript_path") as transcript_path, \
                    mock.patch("terraform_consult.consult_decision_path") as decision_path, \
                    mock.patch("terraform_consult.consult_state_path") as state_path, \
                    mock.patch("terraform_consult._llm_available", return_value=(True, "")), \
                    mock.patch("terraform_consult._call_llm_decision_overlay", return_value=None):
                workspace = "demo-dynamic"
                base = runtime_root / "terraform-consult" / workspace
                base.mkdir(parents=True, exist_ok=True)
                transcript_path.side_effect = lambda _ws: base / "transcript.json"
                decision_path.side_effect = lambda _ws: base / "latest_decision.json"
                state_path.side_effect = lambda _ws: base / "state.json"

                prior = build_heuristic_decision(
                    detected={"has_database": False, "has_redis": False, "database_type": "unknown"},
                    intakes={"need_alb": True, "need_eip": True, "peak_traffic": 500},
                    deployment_profile={},
                    aws_region="eu-north-1",
                )
                result = run_terraform_consult(
                    architecture_json={"compute": {"strategy": "ec2"}},
                    repository_context={"language": {"primary": "python"}, "data_stores": []},
                    conversation_history=[
                        {"role": "user", "content": "Need ALB and EIP, peak 500"},
                        {"role": "assistant", "content": "Plan ready"},
                        {"role": "user", "content": "disable 3000 port routing"},
                    ],
                    turn_count=1,
                    workspace=workspace,
                    aws_region="eu-north-1",
                    prior_decision=prior,
                )

                self.assertTrue(result["success"])
                self.assertEqual(result["fallback_reason"], "llm_call_failed")
                self.assertNotIn("llm_call_failed", str(result.get("assistant_message") or ""))
                self.assertFalse(result["decision"]["stack_config"]["ec2"]["public_http"])
                self.assertEqual(result["decision"]["stack_config"]["networking"]["ports_exposed"], [80, 443])
                self.assertIn("Updated the plan", str(result.get("assistant_message") or ""))


if __name__ == "__main__":
    unittest.main()
