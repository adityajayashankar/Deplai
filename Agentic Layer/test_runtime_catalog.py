from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))

from deployment_packager import build_deployment_package
from ec2_app_renderer import render_ec2_app_bundle
from runtime_catalog import (
    catalog_summary,
    detect_bootstrappable_recipe,
    get_runtime_recipe,
    list_runtime_recipes,
)


class RuntimeCatalogTests(unittest.TestCase):
    def test_catalog_lists_core_ec2_kinds(self) -> None:
        kinds = {recipe.app_kind for recipe in list_runtime_recipes()}
        for expected in (
            "docker",
            "static",
            "node",
            "python",
            "go",
            "java",
            "dotnet",
            "php",
            "ruby",
            "rust",
        ):
            self.assertIn(expected, kinds)

        summary = catalog_summary()
        self.assertIn("runtimes", summary)
        self.assertIn("datastores", summary)
        self.assertIn("node", summary["ec2_bootstrapped_kinds"])
        self.assertIn("go", summary["ec2_bootstrapped_kinds"])

    def test_detects_go_module(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "go.mod").write_text("module example.com/app\n\ngo 1.22\n", encoding="utf-8")
            (root / "main.go").write_text("package main\nfunc main() {}", encoding="utf-8")
            recipe = detect_bootstrappable_recipe(root)
            self.assertIsNotNone(recipe)
            assert recipe is not None
            self.assertEqual(recipe.app_kind, "go")

            package = build_deployment_package(
                source_root=str(root),
                project_name="go-app",
                repository_context={},
            )
            self.assertEqual(package.app_kind, "go")
            self.assertIn("go build", package.build_command)

    def test_detects_java_maven(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "pom.xml").write_text("<project></project>\n", encoding="utf-8")
            package = build_deployment_package(
                source_root=str(root),
                project_name="java-app",
                repository_context={},
            )
            self.assertEqual(package.app_kind, "java")
            self.assertIn("mvn", package.build_command)

    def test_renderer_installs_go_java_php_toolchains(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            # Force a go-shaped package through renderer.
            from deployment_packager import DeploymentPackage

            go_pkg = DeploymentPackage(
                package_id="go-demo",
                source_root=str(tmp),
                app_kind="go",
                app_port=8080,
                health_path="/",
                build_command="go build -o bin/app .",
                start_command="./bin/app",
                package_base64="cGFja2FnZQ==",
                package_file_count=1,
                package_bytes=8,
                selected_root=".",
                package_tarball_path="",
                manifest_path="",
                warnings=[],
            )
            rendered = render_ec2_app_bundle(
                project_name="go-demo",
                aws_region="eu-north-1",
                deployment_package=go_pkg,
            )
            main_tf = next(item["content"] for item in rendered["files"] if item["path"] == "terraform/main.tf")
            self.assertIn('dnf install -y golang', main_tf)
            self.assertIn('dnf install -y java-17-amazon-corretto-devel maven', main_tf)
            self.assertIn('dnf install -y php php-cli', main_tf)
            self.assertIn("language_build_started", main_tf)

    def test_recipe_min_volume_for_docker(self) -> None:
        recipe = get_runtime_recipe("docker")
        self.assertIsNotNone(recipe)
        assert recipe is not None
        self.assertGreaterEqual(recipe.min_root_volume_gb, 40)


if __name__ == "__main__":
    unittest.main()
