from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from architecture_decision.planner import apply_aws_discovery, build_initial_decisions, critique, estimate_candidates
from architecture_decision.service import _build_adaptive_questions, _default_answers
from deployment_planning_contract import (
    AwsDiscoveryContext,
    AwsResourceMetadata,
    AwsReuseRecommendation,
    BuildInfo,
    ComputeProfile,
    ComputeServiceProfile,
    DataStoreFinding,
    DeploymentProfileDocument,
    FrontendInfo,
    LanguageInfo,
    NetworkingProfile,
    RepositoryContextDocument,
    WorkloadProfile,
)
from repository_analysis.service import _workload_scanner


def context(**overrides: object) -> RepositoryContextDocument:
    payload = {
        "project_root": "/tmp/demo",
        "workspace": "deploy-demo",
        "project_name": "demo",
        "project_type": "local",
        "language": LanguageInfo(primary="typescript", runtime="node", confidence="high"),
        "build": BuildInfo(has_dockerfile=True),
        "frontend": FrontendInfo(),
    }
    payload.update(overrides)
    return RepositoryContextDocument.model_validate(payload)


class WorkloadDetectionTests(unittest.TestCase):
    def test_detects_workers_schedules_uploads_websockets_and_integrations(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package = root / "package.json"
            package.write_text('{"scripts":{"worker":"node worker.js"}}', encoding="utf-8")
            source = root / "app.ts"
            source.write_text(
                "const ws = new WebSocket(url); fs.writeFile('/uploads/a', body); app.post('/api/webhooks/stripe', handler);",
                encoding="utf-8",
            )
            workflow = root / ".github" / "workflows"
            workflow.mkdir(parents=True)
            schedule = workflow / "nightly.yml"
            schedule.write_text("on:\n  schedule:\n    - cron: '0 1 * * *'\n", encoding="utf-8")
            profile = _workload_scanner(
                root,
                [package, source, schedule],
                {"bullmq", "multer", "socket.io", "stripe", "prisma"},
                {"STRIPE_SECRET_KEY"},
            )
        self.assertTrue(profile.workers)
        self.assertTrue(profile.scheduled_jobs)
        self.assertIn("websocket", profile.protocols)
        self.assertTrue(profile.persistent_storage)
        self.assertTrue(profile.webhooks)
        self.assertEqual(profile.migration.get("framework"), "prisma")
        self.assertIn("STRIPE_SECRET_KEY", profile.third_party_dependencies[0].required_environment_variables)


class AdaptivePlanningTests(unittest.TestCase):
    def test_typical_sql_app_asks_only_business_questions(self) -> None:
        repo = context(data_stores=[DataStoreFinding(type="postgresql", confidence="high", signals=["config:prisma/schema.prisma"])])
        questions = _build_adaptive_questions(repo, _default_answers(repo))
        ids = {item.id for item in questions}
        self.assertLessEqual(len(questions), 8)
        self.assertIn("q_data_loss", ids)
        self.assertNotIn("q_compute_strategy", ids)
        self.assertNotIn("q_db_multi_az", ids)
        self.assertTrue(all(item.reason for item in questions))

    def test_decisions_are_typed_and_evidence_backed(self) -> None:
        repo = context(data_stores=[DataStoreFinding(type="postgresql", confidence="high", signals=["config:prisma/schema.prisma"])])
        decisions = build_initial_decisions(repo, _default_answers(repo))
        database = next(item for item in decisions if item.decision_id == "primary_database_engine")
        self.assertEqual(database.authority, "auto")
        self.assertEqual(database.recommendation, "postgresql")
        self.assertTrue(database.evidence)
        self.assertTrue(any(item.authority == "user_required" for item in decisions))

    def test_critic_catches_budget_and_in_memory_session_scaling(self) -> None:
        workload = WorkloadProfile(session_storage={"type": "in_memory", "horizontally_safe": False})
        profile = DeploymentProfileDocument(
            workspace="deploy-demo", project_name="demo", application_type="web", environment="production",
            compute=ComputeProfile(strategy="ecs_fargate", services=[ComputeServiceProfile(id="api", process_type="web", desired_count=2)]),
            networking=NetworkingProfile(nat_gateway=True), workload=workload,
        )
        profile.candidate_architectures = estimate_candidates(profile)
        codes = {item.code for item in critique(profile, 25)}
        self.assertIn("BUDGET_EXCEEDED", codes)
        self.assertIn("STATEFUL_SESSION_SCALING_CONFLICT", codes)
        self.assertIn("NAT_LOW_BUDGET_CONFLICT", codes)


class AwsDiscoveryIntegrationTests(unittest.TestCase):
    def test_apply_aws_discovery_attaches_reuse_decisions(self) -> None:
        profile = DeploymentProfileDocument(
            workspace="deploy-demo",
            project_name="demo",
            application_type="web",
            environment="production",
            compute=ComputeProfile(strategy="ec2", services=[]),
            networking=NetworkingProfile(vpc="new"),
        )
        aws_context = AwsDiscoveryContext(
            status="partial",
            account_id="123456789012",
            region="us-east-1",
            resources=[
                AwsResourceMetadata(resource_type="vpc", resource_id="vpc-abc", name="default", metadata={"default": True}),
            ],
            reuse_recommendations=[
                AwsReuseRecommendation(
                    resource_type="vpc",
                    resource_id="vpc-abc",
                    recommendation="evaluate_reuse",
                    reason="VPC already exists in the account.",
                ),
            ],
            permission_gaps=["rds:DescribeDBInstances:AccessDenied"],
        )
        updated = apply_aws_discovery(profile, aws_context)
        self.assertEqual(updated.aws_reuse.account_id, "123456789012")
        self.assertEqual(updated.networking.vpc, "vpc-abc")
        self.assertTrue(any(decision.category == "aws_reuse" for decision in updated.decisions))


if __name__ == "__main__":
    unittest.main()
