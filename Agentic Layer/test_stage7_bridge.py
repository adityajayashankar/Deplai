from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from stage7_bridge import run_stage7_approval_payload


class Stage7BridgeFallbackTests(unittest.TestCase):
    def test_ecs_multi_az_topology_and_cost_are_present(self) -> None:
        payload = run_stage7_approval_payload(
            infra_plan={
                "compute": "ecs",
                "services": ["api", "worker"],
                "service_profiles": [
                    {"id": "api", "port": 3000, "desired_count": 2, "cpu": 512, "memory": 1024},
                    {"id": "worker", "port": None, "desired_count": 1, "cpu": 256, "memory": 512},
                ],
                "database": "rds",
                "database_config": {"instance_class": "db.t3.small", "storage_gb": 20, "multi_az": True},
                "cache": "elasticache",
                "cache_config": {"node_type": "cache.t3.small", "engine_version": "7.0"},
                "networking": "custom_vpc",
                "networking_config": {
                    "vpc_mode": "new",
                    "layout": "private_subnets",
                    "public_subnets": 2,
                    "private_subnets": 2,
                    "internet_gateway": True,
                    "nat_gateway": True,
                    "load_balancer": "alb",
                    "public_load_balancer": True,
                },
                "container_registry": "ecr",
                "task_definitions": ["api", "worker"],
                "logging": "cloudwatch",
                "security_groups": ["app_security_group"],
                "region": "us-east-1",
            },
            budget_cap_usd=250.0,
            pipeline_run_id="unit-test",
            environment="production",
        )

        node_ids = {node["id"] for node in payload["diagram"]["nodes"]}
        edges = {(edge["from"], edge["to"]) for edge in payload["diagram"]["edges"]}
        line_items = {item["resource_id"]: item for item in payload["cost_estimate"]["line_items"]}

        self.assertIn("APPLICATIONVPC", node_ids)
        self.assertIn("APPLICATIONLOADBALANCER", node_ids)
        self.assertIn("NATGATEWAY", node_ids)
        self.assertIn("ECSCLUSTER", node_ids)
        self.assertIn("APISERVICE", node_ids)
        self.assertIn("WORKERSERVICE", node_ids)
        self.assertIn("PRIMARYDATABASE", node_ids)
        self.assertIn("STANDBYDATABASE", node_ids)
        self.assertIn("CACHECLUSTER", node_ids)
        self.assertIn(("APPLICATIONLOADBALANCER", "APISERVICE"), edges)
        self.assertIn(("APISERVICE", "CACHECLUSTER"), edges)
        self.assertIn(("WORKERSERVICE", "CACHECLUSTER"), edges)
        self.assertIn(("PRIMARYDATABASE", "STANDBYDATABASE"), edges)
        self.assertIn("NATGATEWAY", line_items)
        self.assertIn("APPLICATIONLOADBALANCER", line_items)
        self.assertIn("PRIMARYDATABASE", line_items)
        self.assertIn("STANDBYDATABASE", line_items)
        self.assertGreaterEqual(float(payload["cost_estimate"]["total_monthly_usd"]), 180.0)


if __name__ == "__main__":
    unittest.main()
