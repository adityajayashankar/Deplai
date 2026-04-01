from __future__ import annotations

import unittest

from terraform_agent.agent.engine.manifest import build_manifest


class ManifestTests(unittest.TestCase):
    def test_build_manifest_orders_dependencies(self) -> None:
        manifest, dag_order = build_manifest(
            {
                "nodes": [
                    {"id": "cdn", "type": "CloudFront", "attributes": {}},
                    {"id": "bucket", "type": "AmazonS3", "attributes": {}},
                    {"id": "app", "type": "AmazonEC2", "attributes": {}},
                ],
                "edges": [
                    {"from": "cdn", "to": "bucket"},
                    {"from": "app", "to": "bucket"},
                ],
            }
        )
        self.assertEqual(dag_order[0], "bucket")
        self.assertEqual({component["id"] for component in manifest}, {"cdn", "bucket", "app"})

    def test_build_manifest_rejects_cycles(self) -> None:
        with self.assertRaisesRegex(ValueError, "Circular dependencies detected"):
            build_manifest(
                {
                    "nodes": [
                        {"id": "a", "type": "AmazonS3", "attributes": {}},
                        {"id": "b", "type": "AmazonEC2", "attributes": {}},
                    ],
                    "edges": [
                        {"from": "a", "to": "b"},
                        {"from": "b", "to": "a"},
                    ],
                }
            )
