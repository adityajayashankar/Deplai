from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
for candidate in (ROOT, REPO):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

import pytest

from deployment_manifest import ManifestResolutionError, resolve_deployment_manifest
from deployment_packager import build_deployment_package
from ec2_app_renderer import render_ec2_app_bundle


@pytest.fixture(autouse=True)
def isolated_manifest_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("deployment_manifest.CACHE_ROOT", tmp_path / ".manifest_cache")


def test_user_deplai_manifest_is_validated_and_packaged(tmp_path: Path) -> None:
    (tmp_path / "deplai.yaml").write_text(
        """name: manifest-app
runtime: node
runtime_version: \"20\"
build_command: npm run build
start_command: npm run start
port: 8080
health_check_path: /healthz
env:
  - NODE_ENV=production
strategy: cloud_init
""",
        encoding="utf-8",
    )
    (tmp_path / "package.json").write_text('{"scripts":{"build":"x","start":"x"}}', encoding="utf-8")

    package = build_deployment_package(source_root=str(tmp_path), project_name="ignored")

    assert package.app_kind == "node"
    assert package.strategy == "cloud_init"
    assert package.app_port == 8080
    assert package.health_path == "/healthz"
    assert package.environment == ["NODE_ENV=production"]
    assert package.deployment_manifest["name"] == "manifest-app"
    assert package.manifest_cache_hit is False


def test_docker_wins_over_package_json_and_uses_docker_strategy(tmp_path: Path) -> None:
    (tmp_path / "Dockerfile").write_text("FROM node:20\nEXPOSE 8080\n", encoding="utf-8")
    (tmp_path / "package.json").write_text('{"scripts":{"start":"node app.js"}}', encoding="utf-8")

    package = build_deployment_package(source_root=str(tmp_path), project_name="image-app")

    assert package.app_kind == "docker"
    assert package.strategy == "docker"
    assert package.app_port == 8080


def test_node_is_resolved_to_certified_buildpack_and_cache_skips_detection(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text(
        '{"engines":{"node":"20.x"},"scripts":{"build":"next build","start":"next start"}}',
        encoding="utf-8",
    )

    manifest, hit, fingerprint = resolve_deployment_manifest(tmp_path, "node-app")
    cached, cached_hit, cached_fingerprint = resolve_deployment_manifest(tmp_path, "node-app")

    assert manifest.runtime == "node"
    assert manifest.strategy == "buildpack"
    assert hit is False
    assert cached == manifest
    assert cached_hit is True
    assert cached_fingerprint == fingerprint


def test_python_src_layout_infers_start_command(tmp_path: Path) -> None:
    (tmp_path / "requirements.txt").write_text("fastapi\nuvicorn\n", encoding="utf-8")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("from fastapi import FastAPI\napp = FastAPI()\n", encoding="utf-8")

    manifest, _, _ = resolve_deployment_manifest(tmp_path, "py-src")

    assert manifest.runtime == "python"
    assert "uvicorn" in manifest.start_command
    assert "main:app" in manifest.start_command
    assert manifest.start_command.startswith("PYTHONPATH=src")


def test_python_procfile_is_used_as_start_command(tmp_path: Path) -> None:
    (tmp_path / "requirements.txt").write_text("gunicorn\n", encoding="utf-8")
    (tmp_path / "Procfile").write_text("web: gunicorn wsgi:application --bind 0.0.0.0:$PORT\n", encoding="utf-8")

    manifest, _, _ = resolve_deployment_manifest(tmp_path, "py-procfile")

    assert manifest.start_command == "gunicorn wsgi:application --bind 0.0.0.0:$APP_PORT"


def test_python_requirements_without_entrypoint_still_resolves(tmp_path: Path) -> None:
    (tmp_path / "requirements.txt").write_text("flask==3.0.0\n", encoding="utf-8")

    manifest, _, _ = resolve_deployment_manifest(tmp_path, "py-flask")

    assert manifest.runtime == "python"
    assert manifest.start_command
    assert "flask" in manifest.start_command


def test_python_repo_with_tooling_package_json_is_not_blocked(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text('{"devDependencies":{"prettier":"3.0.0"}}', encoding="utf-8")
    (tmp_path / "requirements.txt").write_text("flask==3.0.0\n", encoding="utf-8")
    (tmp_path / "app.py").write_text("from flask import Flask\napp = Flask(__name__)\n", encoding="utf-8")

    manifest, _, _ = resolve_deployment_manifest(tmp_path, "py-with-js-tooling")

    assert manifest.runtime == "python"
    assert manifest.start_command


def test_partial_python_deplai_yaml_infers_start_command(tmp_path: Path) -> None:
    (tmp_path / "deplai.yaml").write_text(
        "runtime: python\nstrategy: buildpack\n",
        encoding="utf-8",
    )
    (tmp_path / "requirements.txt").write_text("fastapi\nuvicorn\n", encoding="utf-8")
    (tmp_path / "main.py").write_text("from fastapi import FastAPI\napp = FastAPI()\n", encoding="utf-8")

    manifest, _, _ = resolve_deployment_manifest(tmp_path, "py-partial-yaml")

    assert manifest.runtime == "python"
    assert manifest.origin == "user"
    assert "uvicorn" in manifest.start_command
    assert manifest.build_command


def test_python_wsgi_module_uses_gunicorn(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[project]\nname='demo'\nversion='0.1.0'\n", encoding="utf-8")
    (tmp_path / "wsgi.py").write_text("application = object()\n", encoding="utf-8")

    manifest, _, _ = resolve_deployment_manifest(tmp_path, "py-wsgi")

    assert "gunicorn wsgi:application" in manifest.start_command


def test_unknown_repository_fails_fast_instead_of_creating_placeholder(tmp_path: Path) -> None:
    (tmp_path / "README.md").write_text("not an application", encoding="utf-8")

    with pytest.raises(ManifestResolutionError, match="deterministic_manifest_required"):
        build_deployment_package(source_root=str(tmp_path), project_name="unknown")



def test_buildpack_renderer_uses_certified_executor_and_health_rollback(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text('{"scripts":{"start":"next start"}}', encoding="utf-8")
    package = build_deployment_package(source_root=str(tmp_path), project_name="buildpack-app")

    rendered = render_ec2_app_bundle(
        project_name="buildpack-app",
        aws_region="eu-north-1",
        deployment_package=package,
    )
    files = {item["path"]: item["content"] for item in rendered["files"]}

    assert 'deployment_strategy = "buildpack"' in files["terraform/terraform.tfvars"]
    assert 'resource "aws_ssm_document" "deployment_verify"' in files["terraform/main.tf"]
    assert 'pack build "$APP_NAME:latest"' in files["terraform/main.tf"]
    assert 'rolled_back_after_failed_health_check' in files["terraform/main.tf"]


def test_frontend_backend_workspace_uses_cloud_init_not_static(tmp_path: Path) -> None:
    from deployment_manifest import NODE_WORKSPACE_COMMAND, bootstrap_fallback_from_repository_context, resolve_deployment_manifest

    (tmp_path / "frontend").mkdir()
    (tmp_path / "backend").mkdir()
    (tmp_path / "frontend" / "package.json").write_text(
        '{"scripts":{"build":"next build","start":"next start"}}',
        encoding="utf-8",
    )
    (tmp_path / "backend" / "package.json").write_text(
        '{"scripts":{"start":"node server.js"}}',
        encoding="utf-8",
    )

    manifest, _, _ = resolve_deployment_manifest(tmp_path, "ifca")
    package = build_deployment_package(source_root=str(tmp_path), project_name="ifca")

    assert manifest.runtime == "node"
    assert manifest.strategy == "cloud_init"
    assert manifest.start_command == NODE_WORKSPACE_COMMAND
    assert manifest.app_root == "."
    assert package.app_kind == "node"
    assert package.start_command == NODE_WORKSPACE_COMMAND
    assert package.app_port != 5432

    fallback = bootstrap_fallback_from_repository_context(
        {
            "frameworks": [{"name": "nextjs"}, {"name": "express"}],
            "frontend": {"framework": "nextjs"},
            "backend": {"framework": "express"},
        },
        repository_url="https://github.com/acme/ifca.git",
    )
    assert fallback["app_kind"] == "node"
    assert fallback["start_command"] == NODE_WORKSPACE_COMMAND
    assert fallback["app_subdir"] == "."
