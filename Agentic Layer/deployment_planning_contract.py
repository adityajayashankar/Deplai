from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

Confidence = Literal["high", "medium", "low"]
DecisionAuthority = Literal["auto", "recommend_confirm", "user_required"]
DecisionStatus = Literal["proposed", "confirmed", "overridden", "blocked"]
EvidenceSource = Literal["repository", "security", "aws", "user", "policy", "runtime", "cost"]


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
    has_dockerfile: bool = False
    helm_charts: bool = False
    compose_images: list[str] = Field(default_factory=list)


class ConflictItem(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    field: str
    reason: str
    signals: list[str] = Field(default_factory=list)


class LowConfidenceItem(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    field: str
    reason: str


class ArchitectureEvidence(BaseModel):
    """A non-secret, traceable input to an architecture decision."""

    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    source: EvidenceSource
    signal: str
    value: Any = None
    confidence: float = Field(default=0.75, ge=0.0, le=1.0)


class ArchitectureAlternative(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    value: Any
    label: str
    description: str | None = None
    cost_delta_usd: float | None = None
    risk_delta: str | None = None


class ArchitectureDecision(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    decision_id: str
    category: str
    authority: DecisionAuthority
    status: DecisionStatus = "proposed"
    recommendation: Any = None
    confidence: float = Field(default=0.75, ge=0.0, le=1.0)
    reason_codes: list[str] = Field(default_factory=list)
    evidence: list[ArchitectureEvidence] = Field(default_factory=list)
    alternatives: list[ArchitectureAlternative] = Field(default_factory=list)
    cost_delta_usd: float | None = None
    requires_user_input: bool = False
    depends_on: list[str] = Field(default_factory=list)


class WorkloadService(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    id: str
    process_type: Literal["web", "worker", "scheduler", "internal", "static"]
    framework: str | None = None
    command: str | None = None
    visibility: Literal["public", "internal", "none"] = "internal"
    protocols: list[str] = Field(default_factory=list)
    port: int | None = None
    confidence: float = Field(default=0.75, ge=0.0, le=1.0)
    evidence: list[ArchitectureEvidence] = Field(default_factory=list)


class WorkloadDependency(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    type: str
    provider: str | None = None
    usage: str | None = None
    required_environment_variables: list[str] = Field(default_factory=list)
    confidence: float = Field(default=0.75, ge=0.0, le=1.0)
    evidence: list[ArchitectureEvidence] = Field(default_factory=list)


class WorkloadProfile(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    services: list[WorkloadService] = Field(default_factory=list)
    workers: list[WorkloadService] = Field(default_factory=list)
    scheduled_jobs: list[WorkloadService] = Field(default_factory=list)
    queues: list[WorkloadDependency] = Field(default_factory=list)
    persistent_storage: list[WorkloadDependency] = Field(default_factory=list)
    object_storage: list[WorkloadDependency] = Field(default_factory=list)
    search: list[WorkloadDependency] = Field(default_factory=list)
    authentication: list[WorkloadDependency] = Field(default_factory=list)
    third_party_dependencies: list[WorkloadDependency] = Field(default_factory=list)
    webhooks: list[WorkloadDependency] = Field(default_factory=list)
    protocols: list[str] = Field(default_factory=list)
    health_checks: dict[str, str] = Field(default_factory=dict)
    migration: dict[str, Any] = Field(default_factory=dict)
    session_storage: dict[str, Any] = Field(default_factory=dict)
    runtime_characteristics: dict[str, Any] = Field(default_factory=dict)
    service_graph: list[dict[str, str]] = Field(default_factory=list)


class AwsResourceMetadata(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    resource_type: str
    resource_id: str
    name: str | None = None
    arn: str | None = None
    region: str | None = None
    state: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class AwsReuseRecommendation(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    resource_type: str
    resource_id: str
    recommendation: str
    authority: DecisionAuthority = "recommend_confirm"
    reason: str
    confirmed: bool = False


class AwsDiscoveryContext(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    status: Literal["not_requested", "complete", "partial", "unavailable"] = "not_requested"
    account_id: str | None = None
    region: str | None = None
    resources: list[AwsResourceMetadata] = Field(default_factory=list)
    reuse_recommendations: list[AwsReuseRecommendation] = Field(default_factory=list)
    permission_gaps: list[str] = Field(default_factory=list)
    discovered_at: str | None = None


class ArchitectureCriticFinding(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    severity: Literal["info", "warning", "high", "blocking"]
    code: str
    message: str
    recommendation: str | None = None
    affected_decisions: list[str] = Field(default_factory=list)


class CandidateArchitecture(BaseModel):
    model_config = ConfigDict(extra="allow", str_strip_whitespace=True)

    id: Literal["lean", "recommended", "high_availability"]
    label: str
    description: str
    compute_strategy: str
    estimated_monthly_usd: float | None = None
    reliability: str
    differences: list[str] = Field(default_factory=list)


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
    workload_profile: WorkloadProfile = Field(default_factory=WorkloadProfile)


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
    priority: int = Field(default=50, ge=0, le=100)
    reason: str | None = None
    recommended_answer: str | None = None
    cost_impact: str | None = None
    risk_impact: str | None = None
    skip_allowed: bool = False
    decision_id: str | None = None


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
    root_volume_gb: int | None = None


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
    elastic_ip: dict[str, Any] = Field(default_factory=dict)
    ports_exposed: list[int] = Field(default_factory=list)

    @field_validator("vpc", mode="before")
    @classmethod
    def _coerce_vpc(cls, value: Any) -> str:
        if isinstance(value, bool):
            return "new" if value else "existing"
        text = str(value or "").strip()
        if not text:
            return "new"
        lowered = text.lower()
        if lowered in {"true", "1", "yes"}:
            return "new"
        if lowered in {"false", "0", "no"}:
            return "existing"
        return text

    @field_validator("elastic_ip", mode="before")
    @classmethod
    def _coerce_elastic_ip(cls, value: Any) -> dict[str, Any]:
        if isinstance(value, bool):
            return {"enabled": True, "associate_with": "ec2"} if value else {}
        return value if isinstance(value, dict) else {}

    @field_validator("load_balancer", mode="before")
    @classmethod
    def _coerce_load_balancer(cls, value: Any) -> dict[str, Any]:
        if isinstance(value, bool):
            return {"public": True, "type": "alb"} if value else {}
        return value if isinstance(value, dict) else {}


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
    profile_version: str = "2.0"
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
    planning_mode: Literal["autopilot", "guided", "expert"] = "guided"
    workload: WorkloadProfile = Field(default_factory=WorkloadProfile)
    storage: dict[str, Any] = Field(default_factory=dict)
    queues: list[dict[str, Any]] = Field(default_factory=list)
    security: dict[str, Any] = Field(default_factory=dict)
    reliability: dict[str, Any] = Field(default_factory=dict)
    observability: dict[str, Any] = Field(default_factory=dict)
    deployment: dict[str, Any] = Field(default_factory=dict)
    cost: dict[str, Any] = Field(default_factory=dict)
    aws_reuse: AwsDiscoveryContext = Field(default_factory=AwsDiscoveryContext)
    decisions: list[ArchitectureDecision] = Field(default_factory=list)
    architecture_conflicts: list[ArchitectureCriticFinding] = Field(default_factory=list)
    candidate_architectures: list[CandidateArchitecture] = Field(default_factory=list)


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
    decisions: list[ArchitectureDecision] = Field(default_factory=list)
    aws_context: AwsDiscoveryContext = Field(default_factory=AwsDiscoveryContext)
    planning_mode: Literal["autopilot", "guided", "expert"] = "guided"


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
    organization_id: str | None = None
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
    organization_id: str | None = None
    repo_full_name: str | None = None
    answers: dict[str, str] = Field(default_factory=dict)
    aws_context: AwsDiscoveryContext | None = None


class ArchitectureReviewCompleteResponse(BaseModel):
    success: bool
    workspace: str | None = None
    answers_json: ArchitectureAnswersDocument | None = None
    deployment_profile: DeploymentProfileDocument | None = None
    architecture_view: DerivedArchitectureView | None = None
    approval_payload: dict[str, Any] | None = None
    runtime_paths: dict[str, str] | None = None
    error: str | None = None


class AwsDiscoveryRequest(BaseModel):
    """One-time credentials are accepted in memory and are never part of the response."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    aws_access_key_id: str
    aws_secret_access_key: str
    aws_session_token: str | None = None
    aws_region: str = "eu-north-1"


class AwsDiscoveryResponse(BaseModel):
    success: bool
    context: AwsDiscoveryContext | None = None
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
