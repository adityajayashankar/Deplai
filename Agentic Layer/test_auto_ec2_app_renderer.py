from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))

from claude_deployment_pipeline import (
    _should_auto_select_ec2_app_renderer,
    normalize_terraform_renderer,
)


class AutoEc2AppRendererSelectionTests(unittest.TestCase):
    def test_normalize_renderer(self) -> None:
        self.assertEqual(normalize_terraform_renderer("auto"), "auto")
        self.assertEqual(normalize_terraform_renderer("deplai_ec2_app"), "deplai_ec2_app")
        self.assertEqual(normalize_terraform_renderer("weird"), "auto")

    def test_auto_selects_node_app_for_ec2_strategy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "package.json").write_text(
                '{"scripts":{"build":"react-scripts build","start":"react-scripts start"}}',
                encoding="utf-8",
            )
            (root / "public").mkdir()
            (root / "public" / "index.html").write_text("<html></html>", encoding="utf-8")

            selected, package = _should_auto_select_ec2_app_renderer(
                terraform_renderer="auto",
                profile_payload={"compute": {"strategy": "ec2"}},
                source_root=str(root),
                source_root_candidates=[],
                project_name="ifca",
                repository_context_json={},
                user_answers_json={},
            )

            self.assertTrue(selected)
            self.assertIsNotNone(package)
            assert package is not None
            self.assertEqual(package.app_kind, "node")

    def test_auto_skips_static_cloudfront_strategy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "package.json").write_text(
                '{"scripts":{"build":"vite build","start":"vite preview"}}',
                encoding="utf-8",
            )
            selected, package = _should_auto_select_ec2_app_renderer(
                terraform_renderer="auto",
                profile_payload={"compute": {"strategy": "s3_cloudfront"}},
                source_root=str(root),
                source_root_candidates=[],
                project_name="site",
                repository_context_json={},
                user_answers_json={},
            )
            self.assertFalse(selected)
            self.assertIsNone(package)

    def test_explicit_deplai_ec2_app_always_selected(self) -> None:
        selected, package = _should_auto_select_ec2_app_renderer(
            terraform_renderer="deplai_ec2_app",
            profile_payload={"compute": {"strategy": "ec2"}},
            source_root="",
            source_root_candidates=[],
            project_name="x",
            repository_context_json={},
            user_answers_json={},
        )
        self.assertTrue(selected)
        self.assertIsNone(package)


    def test_auto_selects_docker_app_for_ec2_strategy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "Dockerfile").write_text(
                "FROM nginx:alpine\nEXPOSE 80\n",
                encoding="utf-8",
            )
            selected, package = _should_auto_select_ec2_app_renderer(
                terraform_renderer="auto",
                profile_payload={"compute": {"strategy": "ec2"}},
                source_root=str(root),
                source_root_candidates=[],
                project_name="docker-app",
                repository_context_json={},
                user_answers_json={},
            )
            self.assertTrue(selected)
            self.assertIsNotNone(package)
            assert package is not None
            self.assertEqual(package.app_kind, "docker")


if __name__ == "__main__":
    unittest.main()
