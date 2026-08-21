"""Unit + smoke tests for LangGraph infra advisor."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from infra_advisor.cost import estimate_decision_cost, evaluate_budget
from infra_advisor.design import (
    build_upgrade_suggestions,
    classify_intent,
    parse_budget_from_text,
    pick_affordable_tier,
)
from infra_advisor.service import run_infra_advise


class InfraAdvisorTests(unittest.TestCase):
    def test_parse_budget(self) -> None:
        self.assertEqual(parse_budget_from_text("$50"), 50.0)
        self.assertEqual(parse_budget_from_text("budget 100 /mo"), 100.0)

    def test_classify_budget_intent(self) -> None:
        intent = classify_intent(
            messages=[{"role": "user", "content": "My monthly budget is $50"}],
            budget_cap_usd=0,
            force_decision=False,
        )
        self.assertEqual(intent, "set_budget")

    def test_budget_fit_pass_fail(self) -> None:
        self.assertEqual(evaluate_budget(20, 50)["status"], "PASS")
        self.assertEqual(evaluate_budget(60, 50)["status"], "FAIL")
        self.assertGreater(evaluate_budget(60, 50)["gap_usd"], 0)

    def test_pick_affordable_tier(self) -> None:
        costs = {"baseline": 18.0, "recommended": 90.0, "resilient": 140.0}
        self.assertEqual(pick_affordable_tier(costs, 25, preferred="recommended"), "baseline")
        self.assertEqual(pick_affordable_tier(costs, 100, preferred="recommended"), "recommended")

    def test_upgrade_suggestions_for_low_budget(self) -> None:
        suggestions = build_upgrade_suggestions(
            selected_tier="baseline",
            costs={"baseline": 18.0, "recommended": 90.0, "resilient": 140.0},
            budget_cap_usd=25,
            detected={"has_database": True},
        )
        self.assertTrue(suggestions)
        self.assertTrue(any(item.get("tier") == "recommended" for item in suggestions))
        self.assertGreater(float(suggestions[0].get("extra_monthly_usd") or 0), 0)

    def test_estimate_decision_cost_has_ec2(self) -> None:
        decision = {
            "components": ["vpc", "ec2", "eip"],
            "stack_config": {"ec2": {"instance_type": "t3.micro", "root_volume_size_gb": 35, "desired_count": 1}},
        }
        estimate = estimate_decision_cost(decision)
        self.assertGreater(float(estimate["subtotal_monthly_usd"]), 0)
        self.assertTrue(any(item["component"] == "ec2" for item in estimate["line_items"]))

    def test_classify_question_intent(self) -> None:
        intent = classify_intent(
            messages=[{"role": "user", "content": "which ec2 instance do u suggest to configure"}],
            budget_cap_usd=1000,
            force_decision=False,
        )
        self.assertEqual(intent, "question")

    def test_budget_followup_does_not_repeat_intro(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            runtime_root = Path(tmp)
            with mock.patch("infra_advisor.persistence.runtime_root", return_value=runtime_root), \
                    mock.patch("planning_runtime.runtime_root", return_value=runtime_root):
                first = run_infra_advise(
                    architecture_json={},
                    repository_context={"language": {"primary": "python"}},
                    conversation_history=[],
                    workspace="unit-repeat",
                    budget_cap_usd=0,
                )
                self.assertIn("plain language", first["assistant_message"].lower())
                second = run_infra_advise(
                    architecture_json={},
                    repository_context={"language": {"primary": "python"}},
                    conversation_history=[
                        {"role": "assistant", "content": first["assistant_message"]},
                        {"role": "user", "content": "1000"},
                    ],
                    workspace="unit-repeat",
                    budget_cap_usd=0,
                    turn_count=1,
                )
                self.assertNotIn(
                    "i'll set up aws for your project in plain language",
                    second["assistant_message"].lower(),
                )
                self.assertIn("1000", second["assistant_message"].replace(",", ""))

    def test_question_fallback_mentions_instance_without_llm(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            runtime_root = Path(tmp)
            with mock.patch("infra_advisor.persistence.runtime_root", return_value=runtime_root), \
                    mock.patch("planning_runtime.runtime_root", return_value=runtime_root), \
                    mock.patch("infra_advisor.nodes.call_advisor_chat", return_value=None):
                result = run_infra_advise(
                    architecture_json={},
                    repository_context={
                        "language": {"primary": "python"},
                        "data_stores": [{"type": "postgres"}],
                    },
                    conversation_history=[
                        {"role": "user", "content": "$150"},
                        {
                            "role": "user",
                            "content": "for customers, around 100 users, keep my data safe, must stay up",
                        },
                        {"role": "user", "content": "which ec2 instance do you suggest"},
                    ],
                    workspace="unit-q",
                    budget_cap_usd=150,
                    turn_count=3,
                )
                msg = (result.get("assistant_message") or "").lower()
                self.assertTrue("t3." in msg or "instance" in msg or "app server" in msg)
                self.assertIn("ec2", str((result.get("decision") or {}).get("components") or []).lower())

    def test_run_advise_asks_for_budget_first(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            runtime_root = Path(tmp)
            with mock.patch("infra_advisor.persistence.runtime_root", return_value=runtime_root), \
                    mock.patch("planning_runtime.runtime_root", return_value=runtime_root):
                result = run_infra_advise(
                    architecture_json={},
                    repository_context={"language": {"primary": "python"}, "data_stores": []},
                    conversation_history=[],
                    workspace="unit-budget",
                    budget_cap_usd=0,
                )
                self.assertTrue(result["success"])
                self.assertTrue(result["open_questions"])
                joined = " ".join(result["open_questions"]).lower()
                self.assertTrue("spend" in joined or "budget" in joined or "$25" in joined)

    def test_run_advise_low_budget_baseline_with_upsell(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            runtime_root = Path(tmp)
            with mock.patch("infra_advisor.persistence.runtime_root", return_value=runtime_root), \
                    mock.patch("planning_runtime.runtime_root", return_value=runtime_root):
                result = run_infra_advise(
                    architecture_json={},
                    repository_context={
                        "language": {"primary": "python"},
                        "data_stores": [{"type": "postgres"}],
                    },
                    conversation_history=[
                        {"role": "user", "content": "$25"},
                        {"role": "user", "content": "side project for friends, under 20 users, downtime ok"},
                    ],
                    workspace="unit-low",
                    budget_cap_usd=25,
                    turn_count=1,
                )
                self.assertTrue(result["success"])
                self.assertEqual(result["selected_tier"], "baseline")
                components = (result.get("decision") or {}).get("components") or []
                self.assertIn("ec2", components)
                self.assertNotIn("rds", components)
                self.assertTrue(result.get("upgrade_suggestions"))

    def test_run_advise_higher_budget_can_include_db(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            runtime_root = Path(tmp)
            with mock.patch("infra_advisor.persistence.runtime_root", return_value=runtime_root), \
                    mock.patch("planning_runtime.runtime_root", return_value=runtime_root):
                result = run_infra_advise(
                    architecture_json={},
                    repository_context={
                        "language": {"primary": "python"},
                        "data_stores": [{"type": "postgres"}],
                    },
                    conversation_history=[
                        {"role": "user", "content": "$150"},
                        {
                            "role": "user",
                            "content": "for customers, around 100 users, keep my data safe, must stay up",
                        },
                    ],
                    workspace="unit-high",
                    budget_cap_usd=150,
                    turn_count=1,
                )
                self.assertTrue(result["success"])
                components = (result.get("decision") or {}).get("components") or []
                self.assertIn("ec2", components)
                self.assertIn("rds", [str(c).lower() for c in components])
                self.assertNotIn("llm_call_failed", str(result.get("assistant_message") or ""))


if __name__ == "__main__":
    unittest.main()
