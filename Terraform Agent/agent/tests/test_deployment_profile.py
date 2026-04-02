from __future__ import annotations

import unittest

from terraform_agent.agent.engine.deployment_profile import (
    build_profile_manifest,
    is_deployment_profile_payload,
    validate_deployment_profile_payload,
)


class DeploymentProfileTests(unittest.TestCase):
    def test_detects_profile_shape(self) -> None:
        payload = {
            "document_kind": "deployment_profile",
            "workspace": "demo",
            "project_name": "demo",
            "compute": {"strategy": "ecs_fargate", "services": []},
            "networking": {"vpc": "new"},
        }
        self.assertTrue(is_deployment_profile_payload(payload))
        self.assertEqual(validate_deployment_profile_payload(payload), [])

    def test_build_profile_manifest_for_ecs(self) -> None:
        manifest, dag_order = build_profile_manifest(
            {
                "document_kind": "deployment_profile",
                "workspace": "demo",
                "project_name": "demo",
                "compute": {
                    "strategy": "ecs_fargate",
                    "services": [
                        {"id": "api", "process_type": "web", "port": 3000},
                        {"id": "worker", "process_type": "worker"},
                    ],
                },
                "networking": {"load_balancer": {"public": True}},
                "data_layer": [
                    {"id": "primary_db", "type": "postgresql"},
                    {"id": "cache", "type": "redis"},
                ],
            }
        )
        self.assertIn("api", dag_order)
        self.assertIn("worker", dag_order)
        self.assertTrue(any(component["type"] == "aws_db_instance" for component in manifest))
        self.assertTrue(any(component["type"] == "aws_elasticache_cluster" for component in manifest))
