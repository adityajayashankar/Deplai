from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from deployment_planning_contract import (
    ArchitectureAnswersDocument,
    ArchitectureQuestion,
    ArchitectureReviewPayload,
    BuildPipelineProfile,
    ComplianceProfile,
    ComputeProfile,
    ComputeServiceProfile,
    DataLayerProfile,
    DeploymentProfileDocument,
    DerivedArchitectureView,
    DnsTlsProfile,
    NetworkingProfile,
    OperationalProfile,
    QuestionOption,
    RepositoryContextDocument,
    RuntimeConfigProfile,
)
from planning_runtime import (
    analyzer_context_path,
    decision_answers_path,
    decision_approval_payload_path,
    decision_architecture_view_path,
    decision_profile_path,
    read_json,
    runtime_paths_for_workspace,
    write_json,
)
from repository_analysis import run_repository_analysis
from stage7_bridge import run_stage7_approval_payload


def _load_or_build_context(*, project_id: str, project_name: str, project_type: str, workspace: str, user_id: str | None = None, repo_full_name: str | None = None) -> RepositoryContextDocument:
    context_path = analyzer_context_path(workspace)
    if context_path.exists():
        return RepositoryContextDocument.model_validate(read_json(context_path))
    context, _, _ = run_repository_analysis(
        project_id=project_id,
        project_name=project_name,
        project_type=project_type,
        workspace=workspace,
        user_id=user_id,
        repo_full_name=repo_full_name,
    )
    return context


def _default_answers(context: RepositoryContextDocument, environment_hint: str | None = None) -> dict[str, str]:
    return {
        "q_environment": environment_hint or "production",
        "q_traffic_scale": "10-100_rps",
        "q_worker_throughput": "10-100_jobs_per_minute",
        "q_redis_version": "7.0" if any(store.type == "redis" for store in context.data_stores) else "",
        "q_db_size": "20gb_50_connections" if context.data_stores else "",
        "q_db_multi_az": "true",
        "q_existing_vpc": "new",
        "q_public_api": "true",
        "q_domain": "",
        "q_ci_pipeline": "existing_ci",
        "q_backup_retention": "7",
        "q_log_retention": "30",
        "q_multi_region": "false",
        "q_service_selection": "all",
    }


def _question_options(items: list[tuple[str, str, str]]) -> list[QuestionOption]:
    return [QuestionOption(value=value, label=label, description=description) for value, label, description in items]


def _build_questions(context: RepositoryContextDocument, defaults: dict[str, str]) -> list[ArchitectureQuestion]:
    questions: list[ArchitectureQuestion] = []
    has_worker = any(process.type in {"worker", "clock"} or "worker" in (process.command or "").lower() for process in context.processes)
    has_db = any(store.type in {"postgresql", "mysql"} for store in context.data_stores)
    has_redis = any(store.type == "redis" for store in context.data_stores)
    is_monorepo = bool(context.infrastructure_hints.monorepo)
    runtime = context.language.runtime or "application"
    framework_names = sorted({item.name for item in context.frameworks if item.name})
    framework_hint = f" ({', '.join(framework_names)})" if framework_names else ""
    application_type = _derive_application_type(context)

    if is_monorepo:
        questions.append(
            ArchitectureQuestion(
                id="q_service_selection",
                category="repository",
                question="This repository looks like a multi-service codebase. Which service scope should Terraform target?",
                default=defaults["q_service_selection"],
                options=_question_options([
                    ("primary", "Primary service", "Generate Terraform for the main web/API service only."),
                    ("all", "All detected services", "Include every deployable service found in the repository."),
                ]),
                affects=["compute.services"],
            )
        )

    questions.extend(
        [
            ArchitectureQuestion(
                id="q_environment",
                category="deployment",
                question=f"What environment should we target for this {runtime}{framework_hint} deployment?",
                default=defaults["q_environment"],
                options=_question_options([
                    ("production", "Production", "Production-safe defaults and higher availability where needed."),
                    ("staging", "Staging", "Close to production but lower cost."),
                    ("dev", "Development", "Cheapest and simplest setup."),
                ]),
                affects=["environment", "networking.layout", "data_layer.multi_az"],
            ),
            ArchitectureQuestion(
                id="q_traffic_scale",
                category="scale",
                question="How much traffic should this Terraform stack be sized for at launch?",
                default=defaults["q_traffic_scale"],
                options=_question_options([
                    ("lt10_rps", "Low", "Internal tool, demo, or early traffic."),
                    ("10-100_rps", "Moderate", "Typical small production app baseline."),
                    ("100-1000_rps", "High", "Needs more compute headroom and scaling."),
                    ("gt1000_rps", "Very high", "Heavy production traffic from day one."),
                ]),
                affects=["compute.strategy", "compute.services", "autoscaling"],
            ),
        ]
    )

    if application_type != "static_site":
        questions.append(
            ArchitectureQuestion(
                id="q_public_api",
                category="networking",
                question="Should the main application endpoint be publicly reachable on the internet?",
                default=defaults["q_public_api"],
                options=_question_options([
                    ("true", "Public", "Expose the app through a public entrypoint."),
                    ("false", "Private", "Keep the app internal/private only."),
                ]),
                affects=["networking.load_balancer.public", "dns_and_tls.domain"],
            )
        )

    if has_worker:
        questions.append(
            ArchitectureQuestion(
                id="q_worker_throughput",
                category="scale",
                question="The scanner found background work. How much worker throughput should Terraform plan for?",
                default=defaults["q_worker_throughput"],
                options=_question_options([
                    ("lt10_jobs_per_minute", "< 10 jobs/min", "Single worker is enough."),
                    ("10-100_jobs_per_minute", "10-100 jobs/min", "Moderate worker baseline."),
                    ("gt100_jobs_per_minute", "> 100 jobs/min", "Requires additional worker capacity."),
                ]),
                affects=["compute.services.worker"],
            )
        )
    if has_redis and any(not store.version for store in context.data_stores if store.type == "redis"):
        questions.append(
            ArchitectureQuestion(
                id="q_redis_version",
                category="data",
                question="The repository points to Redis. Which engine version should Terraform assume?",
                default=defaults["q_redis_version"],
                options=_question_options([
                    ("7.0", "Redis 7.0", "Current stable default."),
                    ("6.2", "Redis 6.2", "Use when compatibility requires older engine behavior."),
                ]),
                affects=["data_layer.redis.engine_version"],
            )
        )
    if has_db:
        questions.append(
            ArchitectureQuestion(
                id="q_db_size",
                category="data",
                question="The scanner found a SQL datastore. What database size/profile should Terraform provision?",
                default=defaults["q_db_size"],
                options=_question_options([
                    ("20gb_50_connections", "20 GB / 50 conns", "Small production baseline."),
                    ("100gb_200_connections", "100 GB / 200 conns", "Medium production workload."),
                    ("500gb_500_connections", "500 GB / 500 conns", "Larger steady-state workload."),
                ]),
                affects=["data_layer.primary_db.instance_class", "data_layer.primary_db.storage_gb"],
            )
        )
        questions.append(
            ArchitectureQuestion(
                id="q_db_multi_az",
                category="data",
                question="Should the primary SQL database be highly available (Multi-AZ)?",
                default=defaults["q_db_multi_az"],
                options=_question_options([
                    ("true", "Yes", "Higher availability, higher cost."),
                    ("false", "No", "Lower cost, single-AZ deployment."),
                ]),
                affects=["data_layer.primary_db.multi_az"],
            )
        )
    questions.extend(
        [
            ArchitectureQuestion(
                id="q_existing_vpc",
                category="networking",
                question="Should Terraform create fresh AWS networking or assume an existing VPC?",
                default=defaults["q_existing_vpc"],
                options=_question_options([
                    ("new", "Create new VPC", "Terraform manages the network stack end to end."),
                    ("existing", "Use existing VPC", "Terraform plugs into networking you already have."),
                ]),
                affects=["networking.vpc"],
            ),
            ArchitectureQuestion(
                id="q_domain",
                category="networking",
                question="Optional: if you already have a domain for this app, enter it here.",
                required=False,
                default=defaults["q_domain"],
                affects=["dns_and_tls.domain"],
            ),
        ]
    )
    return questions


def start_architecture_review(*, project_id: str, project_name: str, project_type: str, workspace: str, user_id: str | None = None, repo_full_name: str | None = None, environment: str | None = None) -> ArchitectureReviewPayload:
    context = _load_or_build_context(
        project_id=project_id,
        project_name=project_name,
        project_type=project_type,
        workspace=workspace,
        user_id=user_id,
        repo_full_name=repo_full_name,
    )
    defaults = _default_answers(context, environment)
    questions = _build_questions(context, defaults)
    return ArchitectureReviewPayload(
        context_json=context,
        questions=questions,
        defaults=defaults,
        conflicts=context.conflicts,
        low_confidence_items=context.low_confidence_items,
    )


def _traffic_tier(value: str) -> tuple[int, int, int, int, int]:
    normalized = str(value or "")
    if normalized == "lt10_rps":
        return (256, 512, 1, 1, 3)
    if normalized == "100-1000_rps":
        return (1024, 2048, 2, 2, 10)
    if normalized == "gt1000_rps":
        return (2048, 4096, 3, 3, 20)
    return (512, 1024, 2, 2, 10)


def _db_shape(value: str) -> tuple[str, int]:
    if value == "100gb_200_connections":
        return ("db.t3.medium", 100)
    if value == "500gb_500_connections":
        return ("db.r6g.large", 500)
    return ("db.t3.small", 20)


def _redis_node_type(traffic: str) -> str:
    if traffic == "gt1000_rps":
        return "cache.r6g.large"
    if traffic == "100-1000_rps":
        return "cache.t3.medium"
    return "cache.t3.small"


def _service_port(context: RepositoryContextDocument) -> int | None:
    if context.build.dockerfile_port:
        return context.build.dockerfile_port
    if context.frontend.static_site_candidate:
        return None
    if context.language.runtime == "python":
        return 8000
    if context.language.runtime == "node":
        return 3000
    return 8080


def _derive_application_type(context: RepositoryContextDocument) -> str:
    has_docker = bool(context.build.has_dockerfile)
    has_web = any(process.type in {"web", "service"} or "start" in (process.command or "").lower() for process in context.processes) or any(f.role == "http_api_server" for f in context.frameworks)
    has_worker = any(process.type == "worker" or "worker" in (process.command or "").lower() for process in context.processes) or any(f.role == "background_worker" for f in context.frameworks)
    if context.frontend.static_site_candidate and not has_web:
        return "static_site"
    if has_docker and has_web:
        return "containerized_web_app"
    if has_worker and not has_web:
        return "worker_service"
    return "containerized_web_app" if has_docker else "monolith_with_database"


def _derive_compute_profile(context: RepositoryContextDocument, answers: dict[str, str]) -> ComputeProfile:
    application_type = _derive_application_type(context)
    traffic = answers.get("q_traffic_scale", "10-100_rps")
    cpu, memory, desired, auto_min, auto_max = _traffic_tier(traffic)
    services: list[ComputeServiceProfile] = []

    if application_type == "static_site":
        return ComputeProfile(strategy="s3_cloudfront", services=[])

    strategy = "ecs_fargate" if context.build.has_dockerfile else "ec2"
    services.append(
        ComputeServiceProfile(
            id="api",
            process_type="web",
            image_source="placeholder",
            cpu=cpu,
            memory=memory,
            port=_service_port(context),
            desired_count=desired,
            autoscaling={
                "min": auto_min,
                "max": auto_max,
                "target_cpu": 60,
                "target_memory": 70,
            },
        )
    )
    has_worker = any(process.type == "worker" or "worker" in (process.command or "").lower() for process in context.processes) or any(f.role == "background_worker" for f in context.frameworks)
    if has_worker:
        worker_throughput = answers.get("q_worker_throughput", "10-100_jobs_per_minute")
        worker_desired = 2 if worker_throughput == "gt100_jobs_per_minute" else 1
        services.append(
            ComputeServiceProfile(
                id="worker",
                process_type="worker",
                image_source="placeholder",
                cpu=256,
                memory=512,
                port=None,
                desired_count=worker_desired,
                autoscaling={"min": 1, "max": 5, "target_cpu": 70},
            )
        )
    return ComputeProfile(strategy=strategy, services=services)


def _derive_data_layer(context: RepositoryContextDocument, answers: dict[str, str]) -> list[DataLayerProfile]:
    traffic = answers.get("q_traffic_scale", "10-100_rps")
    db_instance_class, storage_gb = _db_shape(answers.get("q_db_size", "20gb_50_connections"))
    backup_retention = int(answers.get("q_backup_retention", "7") or 7)
    data_layer: list[DataLayerProfile] = []
    for store in context.data_stores:
        if store.type == "postgresql":
            data_layer.append(
                DataLayerProfile(
                    id="primary_db",
                    type="postgresql",
                    engine_version=store.version or "15.4",
                    instance_class=db_instance_class,
                    multi_az=answers.get("q_db_multi_az", "true") == "true",
                    storage_gb=storage_gb,
                    backup_retention_days=backup_retention,
                    migrate_command=context.build.migrate_command,
                )
            )
        elif store.type == "redis":
            data_layer.append(
                DataLayerProfile(
                    id="cache",
                    type="redis",
                    engine_version=answers.get("q_redis_version", store.version or "7.0"),
                    node_type=_redis_node_type(traffic),
                    cluster_mode=False,
                    purpose=store.purpose or ["cache"],
                )
            )
    return data_layer


def _derive_networking(context: RepositoryContextDocument, answers: dict[str, str], environment: str, compute: ComputeProfile) -> NetworkingProfile:
    public = answers.get("q_public_api", "true") == "true"
    has_public_entry = public and compute.strategy != "s3_cloudfront"
    layout = "private_subnets" if environment == "production" else "public_subnets"
    if compute.strategy == "s3_cloudfront":
        return NetworkingProfile(
            vpc=answers.get("q_existing_vpc", "new"),
            layout=layout,
            nat_gateway=environment == "production",
            load_balancer={},
            ports_exposed=[443, 80],
        )
    return NetworkingProfile(
        vpc=answers.get("q_existing_vpc", "new"),
        layout=layout,
        nat_gateway=environment == "production",
        load_balancer={
            "type": "alb",
            "public": public,
            "services": [service.id for service in compute.services if service.process_type == "web"] if has_public_entry else [],
        },
        ports_exposed=[443, 80] if public else [],
    )


def _derive_runtime_config(context: RepositoryContextDocument, environment: str) -> RuntimeConfigProfile:
    return RuntimeConfigProfile(
        required_secrets=context.environment_variables.required_secrets,
        config_values=context.environment_variables.config_values,
        secrets_manager_prefix=f"/{re.sub(r'[^a-zA-Z0-9-]+', '-', context.project_name.strip()).strip('-').lower() or 'deplai'}/{environment}",
    )


def _derive_build_pipeline(context: RepositoryContextDocument, answers: dict[str, str]) -> BuildPipelineProfile:
    project_slug = re.sub(r"[^a-zA-Z0-9-]+", "-", context.project_name.strip()).strip("-").lower() or "deplai-project"
    return BuildPipelineProfile(
        build_command=context.build.build_command,
        start_command=context.build.start_command,
        ecr_repository=project_slug,
        ci_provider=context.build.ci_provider,
        provision_codepipeline=answers.get("q_ci_pipeline", "existing_ci") == "codepipeline",
    )


def _derive_operational(context: RepositoryContextDocument, answers: dict[str, str]) -> OperationalProfile:
    project_slug = re.sub(r"[^a-zA-Z0-9-]+", "-", context.project_name.strip()).strip("-").lower() or "deplai-project"
    return OperationalProfile(
        health_check_path=context.health.endpoint or "/",
        health_check_interval=30,
        log_group=f"/deplai/{project_slug}",
        log_retention_days=int(answers.get("q_log_retention", "30") or 30),
        enable_container_insights=True,
    )


def _derive_dns_tls(answers: dict[str, str], compute: ComputeProfile) -> DnsTlsProfile:
    domain = answers.get("q_domain") or None
    return DnsTlsProfile(
        domain=domain,
        zone_id="existing" if domain else None,
        acm_certificate="new" if domain or compute.strategy == "s3_cloudfront" else None,
        cloudfront=compute.strategy == "s3_cloudfront",
    )


def _derive_compliance(answers: dict[str, str]) -> ComplianceProfile:
    requirements: list[str] = []
    if answers.get("q_multi_region", "false") == "true":
        requirements.append("multi_region")
    return ComplianceProfile(requirements=requirements, encryption_at_rest=True, encryption_in_transit=True)


def _profile_to_architecture_view(profile: DeploymentProfileDocument) -> DerivedArchitectureView:
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []

    def add_node(node_id: str, node_type: str, label: str, attributes: dict[str, Any] | None = None) -> None:
        nodes.append(
            {
                "id": node_id,
                "type": node_type,
                "label": label,
                "attributes": attributes or {},
            }
        )

    if profile.compute.strategy == "s3_cloudfront":
        add_node("websiteBucket", "AmazonS3", "Website Bucket", {"storageGB": 10, "storageClass": "Standard"})
        add_node("cloudFrontDistribution", "AmazonCloudFront", "CloudFront Distribution", {"enabled": True})
        edges.append({"from": "cloudFrontDistribution", "to": "websiteBucket", "label": "origin"})
    else:
        add_node("applicationVpc", "AmazonVPC", "Application VPC", {"layout": profile.networking.layout})
        if profile.compute.strategy == "ec2":
            add_node("websiteBucket", "AmazonS3", "Website Bucket", {"storageGB": 10, "storageClass": "Standard"})
            add_node("cloudFrontDistribution", "AmazonCloudFront", "CloudFront Distribution", {"enabled": True})
            add_node("appSecurityGroup", "AmazonVPC", "App Security Group", {"ports": profile.networking.ports_exposed})
            edges.append({"from": "cloudFrontDistribution", "to": "websiteBucket", "label": "origin"})
            edges.append({"from": "applicationVpc", "to": "appSecurityGroup", "label": "security"})
        elif profile.networking.load_balancer:
            add_node("applicationAlb", "ELB", "Application Load Balancer", {"public": profile.networking.load_balancer.get("public", True)})
            edges.append({"from": "applicationAlb", "to": "applicationVpc"})
        if profile.compute.strategy == "ecs_fargate":
            add_node("ecsCluster", "AmazonECS", "ECS Cluster", {})
            for service in profile.compute.services:
                service_node_id = f"{service.id}Service"
                add_node(
                    service_node_id,
                    "AmazonECS",
                    service.id.upper(),
                    {"cpu": service.cpu, "memory": service.memory, "desiredCount": service.desired_count},
                )
                edges.append({"from": "ecsCluster", "to": service_node_id})
                if service.port and profile.networking.load_balancer:
                    edges.append({"from": "applicationAlb", "to": service_node_id, "label": str(service.port)})
        else:
            for service in profile.compute.services:
                service_node_id = f"{service.id}Instance"
                add_node(
                    service_node_id,
                    "AmazonEC2",
                    service.id.upper(),
                    {"instanceType": "t3.micro", "instanceCount": service.desired_count, "storageGB": 20, "volumeType": "gp3"},
                )
                if profile.compute.strategy == "ec2":
                    edges.append({"from": "applicationVpc", "to": service_node_id, "label": "subnet"})
                    edges.append({"from": "appSecurityGroup", "to": service_node_id, "label": str(service.port or 80)})
                elif service.port and profile.networking.load_balancer:
                    edges.append({"from": "applicationAlb", "to": service_node_id, "label": str(service.port)})

    for item in profile.data_layer:
        if item.type == "postgresql":
            add_node(
                "primaryDatabase",
                "AmazonRDS",
                "Primary PostgreSQL",
                {"instanceType": item.instance_class, "databaseEngine": "PostgreSQL", "storageGB": item.storage_gb or 20, "termType": "OnDemand"},
            )
            for service in profile.compute.services:
                edges.append({"from": f"{service.id}Service" if profile.compute.strategy == "ecs_fargate" else f"{service.id}Instance", "to": "primaryDatabase"})
        elif item.type == "redis":
            add_node("cacheCluster", "AmazonElastiCache", "Redis Cache", {"nodeType": item.node_type, "engineVersion": item.engine_version})
            for service in profile.compute.services:
                edges.append({"from": f"{service.id}Service" if profile.compute.strategy == "ecs_fargate" else f"{service.id}Instance", "to": "cacheCluster"})

    return DerivedArchitectureView(
        title=f"Deployment view for {profile.project_name}",
        nodes=nodes,
        edges=edges,
        metadata={"source": "deployment_profile", "workspace": profile.workspace},
    )


def _profile_to_infra_plan(profile: DeploymentProfileDocument) -> dict[str, Any]:
    storage: list[str] = ["website_bucket"] if profile.compute.strategy == "s3_cloudfront" else []
    primary_db = next((item for item in profile.data_layer if item.type == "postgresql"), None)
    cache = next((item for item in profile.data_layer if item.type == "redis"), None)
    using_private_subnets = profile.networking.layout == "private_subnets"
    service_profiles = [
        {
            "id": service.id,
            "process_type": service.process_type,
            "cpu": service.cpu,
            "memory": service.memory,
            "port": service.port,
            "desired_count": service.desired_count,
            "autoscaling": service.autoscaling,
            "internet_facing": bool(service.port and profile.networking.load_balancer),
        }
        for service in profile.compute.services
    ]
    default_region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "eu-north-1"
    return {
        "compute": "ecs" if profile.compute.strategy == "ecs_fargate" else ("ec2" if profile.compute.strategy == "ec2" else None),
        "services": [service.id for service in profile.compute.services],
        "service_profiles": service_profiles,
        "database": "rds" if any(item.type == "postgresql" for item in profile.data_layer) else None,
        "database_config": (
            {
                "engine": "postgresql",
                "instance_class": primary_db.instance_class,
                "storage_gb": primary_db.storage_gb,
                "multi_az": bool(primary_db.multi_az),
                "backup_retention_days": primary_db.backup_retention_days,
            }
            if primary_db
            else None
        ),
        "cache": "elasticache" if any(item.type == "redis" for item in profile.data_layer) else None,
        "cache_config": (
            {
                "engine": "redis",
                "node_type": cache.node_type,
                "engine_version": cache.engine_version,
                "cluster_mode": bool(cache.cluster_mode),
                "purpose": cache.purpose,
            }
            if cache
            else None
        ),
        "networking": "custom_vpc" if profile.networking.vpc == "new" else "existing_vpc",
        "networking_config": {
            "vpc_mode": profile.networking.vpc,
            "layout": profile.networking.layout,
            "public_subnets": 2,
            "private_subnets": 2 if using_private_subnets else 0,
            "internet_gateway": profile.networking.vpc == "new",
            "nat_gateway": bool(profile.networking.nat_gateway and using_private_subnets),
            "load_balancer": str(profile.networking.load_balancer.get("type") or "").strip().lower() or None,
            "public_load_balancer": bool(profile.networking.load_balancer.get("public", True)) if profile.networking.load_balancer else False,
        },
        "cdn": "cloudfront" if profile.compute.strategy == "s3_cloudfront" else None,
        "storage": storage,
        "logging": "cloudwatch",
        "security_groups": ["app_security_group"],
        "container_registry": "ecr" if profile.compute.strategy == "ecs_fargate" else None,
        "task_definitions": [service.id for service in profile.compute.services] if profile.compute.strategy == "ecs_fargate" else [],
        "region": default_region,
        "state_backend": "s3_dynamodb",
    }


def complete_architecture_review(*, project_id: str, project_name: str, project_type: str, workspace: str, answers: dict[str, str], user_id: str | None = None, repo_full_name: str | None = None) -> tuple[ArchitectureAnswersDocument, DeploymentProfileDocument, DerivedArchitectureView, dict[str, Any], dict[str, str]]:
    review = start_architecture_review(
        project_id=project_id,
        project_name=project_name,
        project_type=project_type,
        workspace=workspace,
        user_id=user_id,
        repo_full_name=repo_full_name,
    )
    context = review.context_json
    resolved_answers = dict(review.defaults)
    for key, value in answers.items():
        if value is not None and str(value).strip():
            resolved_answers[key] = str(value).strip()
    answers_doc = ArchitectureAnswersDocument(workspace=workspace, answers=resolved_answers)

    environment = resolved_answers.get("q_environment", "production")
    compute = _derive_compute_profile(context, resolved_answers)
    data_layer = _derive_data_layer(context, resolved_answers)
    profile = DeploymentProfileDocument(
        workspace=workspace,
        project_name=project_name,
        application_type=_derive_application_type(context),
        environment=environment,
        compute=compute,
        networking=_derive_networking(context, resolved_answers, environment, compute),
        data_layer=data_layer,
        build_pipeline=_derive_build_pipeline(context, resolved_answers),
        runtime_config=_derive_runtime_config(context, environment),
        dns_and_tls=_derive_dns_tls(resolved_answers, compute),
        operational=_derive_operational(context, resolved_answers),
        compliance=_derive_compliance(resolved_answers),
        warnings=[item.reason for item in context.low_confidence_items] + [item.reason for item in context.conflicts],
    )
    architecture_view = _profile_to_architecture_view(profile)
    infra_plan = _profile_to_infra_plan(profile)
    approval_payload = run_stage7_approval_payload(
        infra_plan=infra_plan,
        budget_cap_usd=100.0,
        pipeline_run_id=workspace,
        environment=environment,
    )

    write_json(decision_answers_path(workspace), answers_doc.model_dump(exclude_none=True))
    write_json(decision_profile_path(workspace), profile.model_dump(exclude_none=True))
    write_json(decision_architecture_view_path(workspace), architecture_view.model_dump(exclude_none=True))
    write_json(decision_approval_payload_path(workspace), approval_payload)
    return answers_doc, profile, architecture_view, approval_payload, runtime_paths_for_workspace(workspace)
