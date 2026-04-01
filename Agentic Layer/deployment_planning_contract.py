from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

Confidence = Literal["high", "medium", "low"]


class DeploymentPlanningContractError(ValueError):
    """Raised when a planning payload does not match the shared contract."""


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class RepositorySignal(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    value: str
    source: str | None = None


class RepositoryFinding(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    name: str
    role: str
    confidence: Confidence = "medium"
    source: str | None = None
    details: dict[str, Any] = Field(default_factory=dict)


class DataStoreFinding(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    type: str
    version: str | None = None
    confidence: Confidence = "medium"
    signals: list[str] = Field(default_factory=list)
    purpose: list[str] = Field(default_factory=list)


class ProcessFinding(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    type: str
    source: str
    command: str | None = None


class LanguageInfo(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    primary: str | None = None
    runtime: str | None = None
    version: str | None = None
    confidence: Confidence = "low"


class BuildInfo(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    build_command: str | None = None
    start_command: str | None = None
    migrate_command: str | None = None
    test_command: str | None = None
    has_dockerfile: bool = False
    dockerfile_port: int | None = None
    is_multi_stage: bool = False
    runs_as_root: bool | None = None
    ci_provider: str | None = None
    existing_registry: str | None = None


class FrontendInfo(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    has_build_step: bool = False
    static_site_candidate: bool = False
    hybrid: bool = False
    output_dir: str | None = None
    framework: str | None = None
    entry_candidates: list[str] = Field(default_factory=list)


class EnvironmentVariablesInfo(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    required_secrets: list[str] = Field(default_factory=list)
    service_endpoints: list[str] = Field(default_factory=list)
    config_values: list[str] = Field(default_factory=list)
    missing_declarations: list[str] = Field(default_factory=list)


class HealthInfo(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    endpoint: str | None = None
    confidence: Confidence = "low"
    source: str | None = None


class MonitoringInfo(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    logging: str | None = None
    metrics: str | None = None
    apm: str | None = None


class InfrastructureHints(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    existing_compose: bool = False
    kubernetes_manifests: bool = False
    serverless_config: bool = False
    monorepo: bool = False


class ConflictItem(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    field: str
    reason: str
    signals: list[str] = Field(default_factory=list)


class LowConfidenceItem(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    field: str
    reason: str


class RepositoryContextDocument(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    document_kind: Literal["repository_context"] = "repository_context"
    scan_timestamp: str = Field(default_factory=utc_now_iso)
    project_root: str
    workspace: str
    project_name: str
    project_type: str
    language: LanguageInfo = Field(default_factory=LanguageInfo)
    frameworks: list[RepositoryFinding] = Field(default_factory=list)
    build: BuildInfo = Field(default_factory=BuildInfo)
    frontend: FrontendInfo = Field(default_factory=FrontendInfo)
    data_stores: list[DataStoreFinding] = Field(default_factory=list)
    processes: list[ProcessFinding] = Field(default_factory=list)
    environment_variables: EnvironmentVariablesInfo = Field(default_factory=EnvironmentVariablesInfo)
    health: HealthInfo = Field(default_factory=HealthInfo)
    monitoring: MonitoringInfo = Field(default_factory=MonitoringInfo)
    infrastructure_hints: InfrastructureHints = Field(default_factory=InfrastructureHints)
    conflicts: list[ConflictItem] = Field(default_factory=list)
    low_confidence_items: list[LowConfidenceItem] = Field(default_factory=list)
    readme_notes: str | None = None
    summary: str | None = None


class QuestionOption(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    value: str
    label: str
    description: str | None = None


class ArchitectureQuestion(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    id: str
    category: str
    question: str
    required: bool = True
    default: str | None = None
    options: list[QuestionOption] = Field(default_factory=list)
    affects: list[str] = Field(default_factory=list)


class ArchitectureAnswersDocument(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    document_kind: Literal["architecture_answers"] = "architecture_answers"
    answered_at: str = Field(default_factory=utc_now_iso)
    workspace: str
    answers: dict[str, str] = Field(default_factory=dict)


class ComputeServiceProfile(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    id: str
    process_type: str
    image_source: str | None = None
    cpu: int | None = None
    memory: int | None = None
    port: int | None = None
    desired_count: int = 1
    autoscaling: dict[str, Any] = Field(default_factory=dict)
    command: str | None = None


class ComputeProfile(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    strategy: str
    services: list[ComputeServiceProfile] = Field(default_factory=list)


class DataLayerProfile(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    id: str
    type: str
    engine_version: str | None = None
    instance_class: str | None = None
    multi_az: bool | None = None
    storage_gb: int | None = None
    backup_retention_days: int | None = None
    migrate_command: str | None = None
    node_type: str | None = None
    cluster_mode: bool | None = None
    purpose: list[str] = Field(default_factory=list)


class NetworkingProfile(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    vpc: str = "new"
    layout: str = "private_subnets"
    nat_gateway: bool = True
    load_balancer: dict[str, Any] = Field(default_factory=dict)
    ports_exposed: list[int] = Field(default_factory=list)


class BuildPipelineProfile(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    build_command: str | None = None
    start_command: str | None = None
    ecr_repository: str | None = None
    ci_provider: str | None = None
    provision_codepipeline: bool = False


class RuntimeConfigProfile(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    required_secrets: list[str] = Field(default_factory=list)
    config_values: list[str] = Field(default_factory=list)
    secrets_manager_prefix: str | None = None


class DnsTlsProfile(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    domain: str | None = None
    zone_id: str | None = None
    acm_certificate: str | None = None
    cloudfront: bool = False


class OperationalProfile(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    health_check_path: str | None = None
    health_check_interval: int = 30
    log_group: str | None = None
    log_retention_days: int = 30
    enable_container_insights: bool = True


class ComplianceProfile(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    requirements: list[str] = Field(default_factory=list)
    encryption_at_rest: bool = True
    encryption_in_transit: bool = True


class DeploymentProfileDocument(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    document_kind: Literal["deployment_profile"] = "deployment_profile"
    profile_version: str = "1.0"
    generated_at: str = Field(default_factory=utc_now_iso)
    workspace: str
    project_name: str
    provider: Literal["aws"] = "aws"
    application_type: str
    environment: str
    compute: ComputeProfile
    networking: NetworkingProfile
    data_layer: list[DataLayerProfile] = Field(default_factory=list)
    build_pipeline: BuildPipelineProfile = Field(default_factory=BuildPipelineProfile)
    runtime_config: RuntimeConfigProfile = Field(default_factory=RuntimeConfigProfile)
    dns_and_tls: DnsTlsProfile = Field(default_factory=DnsTlsProfile)
    operational: OperationalProfile = Field(default_factory=OperationalProfile)
    compliance: ComplianceProfile = Field(default_factory=ComplianceProfile)
    warnings: list[str] = Field(default_factory=list)


class DerivedArchitectureView(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    document_kind: Literal["derived_architecture_view"] = "derived_architecture_view"
    title: str
    schema_version: str = "1.0"
    provider: Literal["aws"] = "aws"
    nodes: list[dict[str, Any]] = Field(default_factory=list)
    edges: list[dict[str, Any]] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ArchitectureReviewPayload(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    context_json: RepositoryContextDocument
    questions: list[ArchitectureQuestion] = Field(default_factory=list)
    defaults: dict[str, str] = Field(default_factory=dict)
    conflicts: list[ConflictItem] = Field(default_factory=list)
    low_confidence_items: list[LowConfidenceItem] = Field(default_factory=list)


class RepositoryAnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    project_id: str
    project_name: str
    project_type: Literal["local", "github"]
    user_id: str | None = None
    repo_full_name: str | None = None
    workspace: str | None = None
    provider: str | None = None
    environment: str | None = None


class RepositoryAnalysisResponse(BaseModel):
    success: bool
    workspace: str | None = None
    context_json: RepositoryContextDocument | None = None
    context_md: str | None = None
    runtime_paths: dict[str, str] | None = None
    error: str | None = None


class ArchitectureReviewStartRequest(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    project_id: str
    project_name: str
    project_type: Literal["local", "github"]
    workspace: str
    user_id: str | None = None
    repo_full_name: str | None = None
    environment: str | None = None


class ArchitectureReviewStartResponse(BaseModel):
    success: bool
    workspace: str | None = None
    review: ArchitectureReviewPayload | None = None
    error: str | None = None


class ArchitectureReviewCompleteRequest(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    project_id: str
    project_name: str
    project_type: Literal["local", "github"]
    workspace: str
    user_id: str | None = None
    repo_full_name: str | None = None
    answers: dict[str, str] = Field(default_factory=dict)


class ArchitectureReviewCompleteResponse(BaseModel):
    success: bool
    workspace: str | None = None
    answers_json: ArchitectureAnswersDocument | None = None
    deployment_profile: DeploymentProfileDocument | None = None
    architecture_view: DerivedArchitectureView | None = None
    approval_payload: dict[str, Any] | None = None
    runtime_paths: dict[str, str] | None = None
    error: str | None = None


def is_deployment_profile_payload(payload: Any) -> bool:
    return isinstance(payload, dict) and str(payload.get("document_kind") or "").strip().lower() == "deployment_profile"


def parse_deployment_profile(payload: Any) -> DeploymentProfileDocument:
    try:
        return DeploymentProfileDocument.model_validate(payload)
    except ValidationError as exc:
        details = "; ".join(
            f"{'.'.join(str(part) for part in err.get('loc', []))}: {err.get('msg')}"
            for err in exc.errors()
        )
        raise DeploymentPlanningContractError(details or "Invalid deployment_profile payload") from exc


def normalize_deployment_profile(payload: Any) -> dict[str, Any]:
    return parse_deployment_profile(payload).model_dump(exclude_none=True)
