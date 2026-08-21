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


def _frontend_package() -> DeploymentPackage:
    package = _package()
    package.selected_root = "frontend"
    return package


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


def test_ec2_renderer_bootstraps_node_app_without_manual_ssh_build() -> None:
    rendered = render_ec2_app_bundle(
        project_name="demo-app",
        aws_region="us-east-1",
        deployment_package=_package(),
    )
    by_path = {item["path"]: item["content"] for item in rendered["files"]}
    main_tf = by_path["terraform/main.tf"]
    variables_tf = by_path["terraform/variables.tf"]
    tfvars = by_path["terraform/terraform.tfvars"]

    assert "fallocate -l 6G /swapfile" in main_tf
    assert "npm ci --legacy-peer-deps || npm install --legacy-peer-deps" in main_tf
    assert 'export NODE_OPTIONS="--max-old-space-size=4096"' in main_tf
    assert 'BOOTSTRAP_STATUS_FILE="/var/log/deplai-bootstrap-status.json"' in main_tf
    assert 'pm2 start node_modules/next/dist/bin/next --name "$APP_NAME" -- start -p "$APP_PORT"' in main_tf
    assert 'write_status "application_service_started"' in main_tf
    assert 'write_status "ready"' in main_tf
    assert "volume_size           = var.root_volume_size_gb" in main_tf
    assert 'output "app_url"' in by_path["terraform/outputs.tf"]
    assert 'variable "root_volume_size_gb"' in variables_tf
    assert "root_volume_size_gb = 35" in tfvars


def test_ec2_renderer_uses_approved_ec2_resource_config() -> None:
    rendered = render_ec2_app_bundle(
        project_name="demo-app",
        aws_region="us-east-1",
        deployment_package=_package(),
        deployment_profile={
            "consultant_decision": {
                "stack_config": {
                    "ec2": {
                        "instance_type": "t3.medium",
                        "root_volume_size_gb": 50,
                        "app_port": 3000,
                        "ssh_ingress_cidr_blocks": ["203.0.113.10/32"],
                    },
                },
            },
        },
    )
    by_path = {item["path"]: item["content"] for item in rendered["files"]}
    tfvars = by_path["terraform/terraform.tfvars"]

    assert 'instance_type = "t3.medium"' in tfvars
    assert "root_volume_size_gb = 50" in tfvars
    assert "app_port = 3000" in tfvars
    assert 'ssh_ingress_cidr_blocks = ["203.0.113.10/32"]' in tfvars


def test_ec2_renderer_normalizes_legacy_ec2_instance_config() -> None:
    rendered = render_ec2_app_bundle(
        project_name="demo-app",
        aws_region="us-east-1",
        deployment_package=_package(),
        deployment_profile={
            "consultant_decision": {
                "stack_config": {
                    "ec2-instance": {
                        "instance_type": "t3.medium",
                    },
                },
            },
        },
    )
    by_path = {item["path"]: item["content"] for item in rendered["files"]}

    assert 'instance_type = "t3.medium"' in by_path["terraform/terraform.tfvars"]


def test_ec2_renderer_invalid_instance_type_falls_back_to_micro() -> None:
    rendered = render_ec2_app_bundle(
        project_name="demo-app",
        aws_region="us-east-1",
        deployment_package=_package(),
        deployment_profile={
            "consultant_decision": {
                "stack_config": {
                    "ec2": {
                        "instance_type": "m7g.16xlarge",
                    },
                },
            },
        },
    )
    by_path = {item["path"]: item["content"] for item in rendered["files"]}

    assert 'instance_type = "t3.micro"' in by_path["terraform/terraform.tfvars"]


def test_ec2_renderer_clones_github_repo_and_uses_detected_frontend_subdir() -> None:
    rendered = render_ec2_app_bundle(
        project_name="ifca",
        aws_region="eu-north-1",
        deployment_package=_frontend_package(),
        repository_url="https://github.com/adityajayashankar/ifca-.git",
    )
    by_path = {item["path"]: item["content"] for item in rendered["files"]}
    main_tf = by_path["terraform/main.tf"]
    tfvars = by_path["terraform/terraform.tfvars"]

    assert 'APP_ROOT="/opt/${var.project_name}"' in main_tf
    assert 'APP_DIR="$APP_ROOT/$APP_SUBDIR"' in main_tf
    assert 'git clone "$REPOSITORY_URL" "$APP_ROOT"' in main_tf
    assert 'write_status "repository_synced"' in main_tf
    assert 'repository_url = "https://github.com/adityajayashankar/ifca-.git"' in tfvars
    assert 'app_subdir = "frontend"' in tfvars


def test_packager_detects_nested_frontend_node_app(tmp_path: Path) -> None:
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "package.json").write_text(
        '{"scripts":{"build":"next build","start":"next start"}}',
        encoding="utf-8",
    )
    (frontend / "package-lock.json").write_text('{"lockfileVersion":3}', encoding="utf-8")

    package = build_deployment_package(
        source_root=str(tmp_path),
        project_name="ifca",
        repository_context={},
    )

    assert package.app_kind == "node"
    assert package.selected_root == "frontend"
    assert package.build_command == "npm run build"
    assert package.start_command == "npm run start"


def test_packager_does_not_treat_cra_public_as_finished_static_site(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text(
        '{"scripts":{"build":"react-scripts build","start":"react-scripts start"}}',
        encoding="utf-8",
    )
    public = tmp_path / "public"
    public.mkdir()
    (public / "index.html").write_text(
        "<!doctype html><html><body><div id='root'></div></body></html>",
        encoding="utf-8",
    )

    package = build_deployment_package(
        source_root=str(tmp_path),
        project_name="ifca",
        repository_context={},
    )

    assert package.app_kind == "node"
    assert package.selected_root == "."
    assert package.build_command == "npm run build"
    assert package.start_command == "npm run start"


def test_packager_prefers_docker_compose_over_node(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text(
        '{"scripts":{"start":"node server.js"}}',
        encoding="utf-8",
    )
    (tmp_path / "docker-compose.yml").write_text(
        "services:\n  web:\n    build: .\n    ports:\n      - '3000:3000'\n",
        encoding="utf-8",
    )
    (tmp_path / "Dockerfile").write_text(
        "FROM node:20-alpine\nEXPOSE 3000\nCMD [\"node\",\"server.js\"]\n",
        encoding="utf-8",
    )

    package = build_deployment_package(
        source_root=str(tmp_path),
        project_name="compose-app",
        repository_context={},
    )

    assert package.app_kind == "docker"
    assert package.build_command == "compose"
    assert package.start_command == "compose:docker-compose.yml"


def test_packager_detects_dockerfile_and_expose_port(tmp_path: Path) -> None:
    (tmp_path / "Dockerfile").write_text(
        "FROM python:3.12-slim\nEXPOSE 8080\nCMD [\"python\",\"-m\",\"http.server\",\"8080\"]\n",
        encoding="utf-8",
    )

    package = build_deployment_package(
        source_root=str(tmp_path),
        project_name="image-app",
        repository_context={},
    )

    assert package.app_kind == "docker"
    assert package.build_command == "docker"
    assert package.start_command == "dockerfile:Dockerfile"
    assert package.app_port == 8080


def test_ec2_renderer_bootstraps_docker_engine(tmp_path: Path) -> None:
    from deployment_packager import DeploymentPackage

    package = DeploymentPackage(
        package_id="demo-docker",
        source_root=str(tmp_path),
        app_kind="docker",
        app_port=8080,
        health_path="/",
        build_command="docker",
        start_command="dockerfile:Dockerfile",
        package_base64="cGFja2FnZQ==",
        package_file_count=1,
        package_bytes=8,
        selected_root=".",
        package_tarball_path="",
        manifest_path="",
        warnings=[],
    )
    rendered = render_ec2_app_bundle(
        project_name="demo-docker",
        aws_region="eu-north-1",
        deployment_package=package,
    )
    main_tf = next(item["content"] for item in rendered["files"] if item["path"] == "terraform/main.tf")
    assert 'APP_KIND="${var.app_kind}"' in main_tf
    assert "dnf install -y docker" in main_tf
    assert "docker compose" in main_tf
    assert "docker build -t" in main_tf
    assert "docker run -d --name" in main_tf
    assert "root_volume_size_gb = 40" in next(
        item["content"] for item in rendered["files"] if item["path"] == "terraform/terraform.tfvars"
    )


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

def test_ec2_renderer_fetches_secrets_manager_and_omits_oauth_plaintext(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text(
        '{"name":"demo","dependencies":{"next-auth":"4.24.0"}}',
        encoding="utf-8",
    )
    (tmp_path / ".env.example").write_text(
        "GOOGLE_CLIENT_ID=\nGOOGLE_CLIENT_SECRET=\nNEXTAUTH_SECRET=\n",
        encoding="utf-8",
    )
    package = DeploymentPackage(
        package_id="demo-package",
        source_root=str(tmp_path),
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
    rendered = render_ec2_app_bundle(
        project_name="demo-app",
        aws_region="eu-north-1",
        deployment_package=package,
        deployment_profile={
            "environment": "prod",
            "runtime_config": {
                "secrets_manager_prefix": "/demo-app/prod",
                "required_secrets": ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
            },
        },
        user_answers={
            "oauth": {
                "GOOGLE_CLIENT_ID": "should-not-appear-in-hcl",
                "GOOGLE_CLIENT_SECRET": "plaintext-oauth-secret-must-not-land-in-tf",
            }
        },
    )
    by_path = {item["path"]: item["content"] for item in rendered["files"]}
    main_tf = by_path["terraform/main.tf"]
    tfvars = by_path["terraform/terraform.tfvars"]

    assert "secretsmanager:GetSecretValue" in main_tf
    assert "secrets_manager_fetch_started" in main_tf
    assert "var.secrets_manager_prefix" in main_tf
    assert "data.aws_caller_identity.current.account_id" in main_tf
    assert "secret:${var.secrets_manager_prefix}*" in main_tf
    get_idx = main_tf.find("secretsmanager:GetSecretValue")
    assert get_idx > 0
    scoped_slice = main_tf[get_idx : get_idx + 600]
    assert "secrets_manager_prefix" in scoped_slice
    assert 'secrets_manager_prefix = "/demo-app/prod"' in tfvars
    assert "plaintext-oauth-secret-must-not-land-in-tf" not in main_tf
    assert "plaintext-oauth-secret-must-not-land-in-tf" not in tfvars
    assert "GOOGLE_CLIENT_SECRET=plaintext" not in main_tf
    assert "should-not-appear-in-hcl" not in main_tf
    assert "should-not-appear-in-hcl" not in tfvars
