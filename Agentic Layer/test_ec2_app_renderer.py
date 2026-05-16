import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from deployment_packager import DeploymentPackage, _source_root_candidates, build_deployment_package
from ec2_app_renderer import render_ec2_app_bundle


def _package() -> DeploymentPackage:
    return DeploymentPackage(
        package_id="demo-package",
        source_root="/repos/acme/demo",
        app_kind="node",
        app_port=3000,
        health_path="/",
        build_command="npm run build",
        start_command="npm run start",
        package_base64="ZGVtbw==",
        package_file_count=1,
        package_bytes=4,
        selected_root=".",
        package_tarball_path="",
        manifest_path="",
        warnings=[],
    )


def test_source_root_candidates_translate_connector_host_paths_to_agentic_mounts() -> None:
    candidates = [
        str(path).replace("\\", "/")
        for path in _source_root_candidates("C:/work/Deplai_AJ/Connector/tmp/repos/acme/demo")
    ]

    assert "/repos/acme/demo" in candidates


def test_ec2_renderer_materializes_requested_data_services() -> None:
    rendered = render_ec2_app_bundle(
        project_name="demo-app",
        aws_region="us-east-1",
        deployment_package=_package(),
        deployment_profile={
            "environment": "dev",
            "consultant_decision": {
                "stack_config": {
                    "rds": {
                        "engine": "postgres",
                        "instance_class": "db.t3.micro",
                        "backup_retention_period": 7,
                    },
                    "elasticache": {
                        "node_type": "cache.t4g.micro",
                    },
                },
            },
        },
    )
    by_path = {item["path"]: item["content"] for item in rendered["files"]}

    assert 'resource "aws_db_instance" "app"' in by_path["terraform/main.tf"]
    assert 'resource "aws_elasticache_cluster" "app"' in by_path["terraform/main.tf"]
    assert 'output "rds_endpoint"' in by_path["terraform/outputs.tf"]
    assert 'output "redis_endpoint"' in by_path["terraform/outputs.tf"]
    assert "enable_rds = true" in by_path["terraform/terraform.tfvars"]
    assert "enable_elasticache = true" in by_path["terraform/terraform.tfvars"]


def test_packager_falls_back_to_generated_static_package_for_unknown_app_shape(tmp_path: Path) -> None:
    (tmp_path / "README.md").write_text("No deployable entrypoint yet.", encoding="utf-8")

    package = build_deployment_package(
        source_root=str(tmp_path),
        project_name="demo-app",
        repository_context={"summary": "unknown app"},
    )

    assert package.app_kind == "static"
    assert package.selected_root == "generated-placeholder"
    assert package.package_file_count == 1
    assert any("generated a static placeholder" in warning for warning in package.warnings)
