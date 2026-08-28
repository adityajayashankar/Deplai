from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

from architecture_decision.service import (
    _budget_cap_usd,
    _build_questions,
    _default_answers,
    _derive_compute_profile,
    _derive_data_layer,
    _derive_networking,
    _rds_engine_version,
    complete_architecture_review,
)
from deployment_planning_contract import (
    BuildInfo,
    DataStoreFinding,
    FrontendInfo,
    InfrastructureHints,
    LanguageInfo,
    ProcessFinding,
    RepositoryContextDocument,
    RepositoryFinding,
    parse_deployment_profile,
)


def _context(**overrides: object) -> RepositoryContextDocument:
    payload = {
        "project_root": "/tmp/demo",
        "workspace": "deploy-demo",
        "project_name": "demo-app",
        "project_type": "local",
        "language": LanguageInfo(primary="javascript", runtime="node"),
        "frameworks": [RepositoryFinding(name="express", role="http_api_server")],
        "build": BuildInfo(has_dockerfile=True, start_command="node server.js"),
        "frontend": FrontendInfo(static_site_candidate=False),
        "data_stores": [],
        "processes": [ProcessFinding(type="web", source="package.json", command="node server.js")],
        "infrastructure_hints": InfrastructureHints(has_dockerfile=True),
    }
    payload.update(overrides)
    return RepositoryContextDocument.model_validate(payload)


class ArchitectureDecisionQuestionTests(unittest.TestCase):
    def test_always_asks_budget_compute_and_ops(self) -> None:
        context = _context()
        questions = _build_questions(context, _default_answers(context))
        ids = [item.id for item in questions]
        self.assertIn("q_environment", ids)
        self.assertIn("q_budget", ids)
        self.assertIn("q_compute_strategy", ids)
        self.assertIn("q_traffic_scale", ids)
        self.assertIn("q_log_retention", ids)
        self.assertIn("q_multi_region", ids)
        self.assertNotIn("q_ci_pipeline", ids)
        budget = next(item for item in questions if item.id == "q_budget")
        self.assertEqual([option.value for option in budget.options], ["25", "50", "100", "250"])

    def test_hides_ecs_without_dockerfile_and_static_without_candidate(self) -> None:
        context = _context(
            build=BuildInfo(has_dockerfile=False),
            frontend=FrontendInfo(static_site_candidate=False),
            infrastructure_hints=InfrastructureHints(has_dockerfile=False),
        )
        questions = _build_questions(context, _default_answers(context))
        compute = next(item for item in questions if item.id == "q_compute_strategy")
        self.assertEqual([option.value for option in compute.options], ["ec2"])

    def test_offers_static_when_scan_says_so(self) -> None:
        context = _context(
            frontend=FrontendInfo(static_site_candidate=True),
            processes=[],
            frameworks=[],
        )
        questions = _build_questions(context, _default_answers(context))
        compute = next(item for item in questions if item.id == "q_compute_strategy")
        self.assertIn("s3_cloudfront", [option.value for option in compute.options])
        self.assertIn("ecs_fargate", [option.value for option in compute.options])

    def test_skips_public_and_vpc_for_static_sites(self) -> None:
        context = _context(
            frontend=FrontendInfo(static_site_candidate=True),
            processes=[],
            frameworks=[],
            build=BuildInfo(has_dockerfile=False),
        )
        ids = [item.id for item in _build_questions(context, _default_answers(context))]
        self.assertNotIn("q_public_api", ids)
        self.assertNotIn("q_existing_vpc", ids)
        self.assertNotIn("q_root_volume", ids)
        self.assertNotIn("q_elastic_ip", ids)
        self.assertNotIn("q_redis", ids)

    def test_asks_volume_eip_and_redis_for_apps(self) -> None:
        context = _context()
        questions = _build_questions(context, _default_answers(context))
        ids = [item.id for item in questions]
        self.assertIn("q_elastic_ip", ids)
        self.assertIn("q_redis", ids)
        self.assertNotIn("q_root_volume", ids)
        self.assertNotIn("q_db_size", ids)
        self.assertNotIn("q_db_multi_az", ids)
        self.assertNotIn("q_backup_retention", ids)
        redis = next(item for item in questions if item.id == "q_redis")
        self.assertEqual([option.value for option in redis.options], ["none", "yes"])
        self.assertEqual(redis.default, "none")

    def test_redis_defaults_to_yes_when_scan_finds_it(self) -> None:
        context = _context(data_stores=[DataStoreFinding(type="redis", version="6.2")])
        defaults = _default_answers(context)
        self.assertEqual(defaults["q_redis"], "yes")
        redis = next(item for item in _build_questions(context, defaults) if item.id == "q_redis")
        self.assertIn("repository uses Redis", redis.question)

    def test_asks_db_backup_when_sql_detected(self) -> None:
        context = _context(
            data_stores=[DataStoreFinding(type="postgresql", version="16.6")],
        )
        ids = [item.id for item in _build_questions(context, _default_answers(context))]
        self.assertNotIn("q_db_size", ids)
        self.assertNotIn("q_db_multi_az", ids)
        self.assertNotIn("q_backup_retention", ids)

    def test_budget_cap_parses_answers(self) -> None:
        self.assertEqual(_budget_cap_usd({"q_budget": "50"}), 50.0)
        self.assertEqual(_budget_cap_usd({"q_budget": "$250"}), 250.0)
        self.assertEqual(_budget_cap_usd({}), 100.0)
        self.assertEqual(_budget_cap_usd({"q_budget": "0"}), 100.0)


class ArchitectureDecisionProfileTests(unittest.TestCase):
    def test_honors_ec2_even_when_dockerfile_exists(self) -> None:
        context = _context()
        profile = _derive_compute_profile(context, {"q_compute_strategy": "ec2", "q_traffic_scale": "lt10_rps"})
        self.assertEqual(profile.strategy, "ec2")
        self.assertTrue(profile.services)

    def test_honors_static_strategy(self) -> None:
        context = _context()
        profile = _derive_compute_profile(context, {"q_compute_strategy": "s3_cloudfront"})
        self.assertEqual(profile.strategy, "s3_cloudfront")
        self.assertEqual(profile.services, [])

    def test_honors_root_volume_eip_and_opt_in_redis(self) -> None:
        context = _context()
        compute = _derive_compute_profile(context, {"q_compute_strategy": "ec2"})
        self.assertEqual(compute.root_volume_gb, 35)
        networking = _derive_networking(
            context,
            {"q_public_api": "true", "q_elastic_ip": "true", "q_existing_vpc": "new"},
            "staging",
            compute,
        )
        self.assertTrue(networking.elastic_ip.get("enabled"))
        self.assertEqual(networking.load_balancer, {})
        alb_networking = _derive_networking(
            context,
            {"q_public_api": "true", "q_elastic_ip": "false", "q_existing_vpc": "new"},
            "staging",
            compute,
        )
        self.assertEqual(alb_networking.elastic_ip, {})
        self.assertEqual(alb_networking.load_balancer.get("type"), "alb")
        opted_in = _derive_data_layer(context, {"q_redis": "7.0"})
        self.assertEqual(opted_in[0].type, "redis")
        self.assertEqual(opted_in[0].engine_version, "7.0")
        skipped = _derive_data_layer(
            _context(data_stores=[DataStoreFinding(type="redis", version="7.0")]),
            {"q_redis": "none"},
        )
        self.assertEqual(skipped, [])

    def test_complete_uses_budget_and_compute_strategy(self) -> None:
        context = _context(data_stores=[DataStoreFinding(type="postgresql")])
        answers = {
            "q_environment": "staging",
            "q_budget": "50",
            "q_compute_strategy": "ec2",
            "q_traffic_scale": "lt10_rps",
            "q_public_api": "true",
            "q_existing_vpc": "new",
            "q_elastic_ip": "true",
            "q_redis": "7.0",
            "q_log_retention": "7",
            "q_multi_region": "false",
        }
        with tempfile.TemporaryDirectory() as tmp:
            runtime_root = Path(tmp)
            with patch("architecture_decision.service._load_or_build_context", return_value=context), patch(
                "architecture_decision.service.write_json"
            ), patch(
                "architecture_decision.service.runtime_paths_for_workspace",
                return_value={"workspace": str(runtime_root)},
            ), patch(
                "architecture_decision.service.decision_answers_path", return_value=runtime_root / "answers.json"
            ), patch(
                "architecture_decision.service.decision_profile_path", return_value=runtime_root / "profile.json"
            ), patch(
                "architecture_decision.service.decision_architecture_view_path", return_value=runtime_root / "view.json"
            ), patch(
                "architecture_decision.service.decision_approval_payload_path", return_value=runtime_root / "approval.json"
            ):
                _, profile, _, approval, _ = complete_architecture_review(
                    project_id="demo",
                    project_name="demo-app",
                    project_type="local",
                    workspace="deploy-demo",
                    answers=answers,
                )
        self.assertEqual(profile.compute.strategy, "ec2")
        self.assertEqual(profile.compute.root_volume_gb, 35)
        self.assertEqual(profile.environment, "staging")
        self.assertTrue(profile.networking.elastic_ip.get("enabled"))
        self.assertEqual(profile.networking.load_balancer, {})
        self.assertTrue(any(item.type == "redis" for item in profile.data_layer))
        self.assertEqual(float(approval["budget_gate"]["cap_usd"]), 50.0)

    def test_postgres_latest_tag_becomes_rds_minor(self) -> None:
        self.assertEqual(_rds_engine_version("postgresql", "latest"), "15.17")
        self.assertEqual(_rds_engine_version("postgresql", "16-alpine"), "16.13")
        layer = _derive_data_layer(
            _context(data_stores=[DataStoreFinding(type="postgresql", version="latest")]),
            {"q_environment": "staging"},
        )
        self.assertEqual(layer[0].engine_version, "15.17")


class DeploymentProfileCoercionTests(unittest.TestCase):
    def test_coerces_boolean_networking_fields(self) -> None:
        profile = parse_deployment_profile(
            {
                "workspace": "deploy-demo",
                "project_name": "demo-app",
                "application_type": "web_app",
                "environment": "dev",
                "compute": {"strategy": "ec2", "services": []},
                "networking": {"vpc": True, "elastic_ip": True, "load_balancer": False},
            }
        )
        self.assertEqual(profile.networking.vpc, "new")
        self.assertTrue(profile.networking.elastic_ip.get("enabled"))
        self.assertEqual(profile.networking.load_balancer, {})


if __name__ == "__main__":
    unittest.main()
