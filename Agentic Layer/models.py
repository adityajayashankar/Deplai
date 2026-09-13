import re
from enum import Enum
from datetime import datetime, timezone
from pydantic import BaseModel, Field, field_validator, model_validator
from typing import Any, Literal, Optional
from architecture_contract import ArchitectureDocument

# Allowlist for project_id — alphanumeric, hyphens, underscores only, 1-80 chars.
# This prevents shell metacharacters from reaching Docker exec commands.
_PROJECT_ID_RE = re.compile(r'^[a-zA-Z0-9_-]{1,80}$')


def _validate_project_id(v: str) -> str:
    if not _PROJECT_ID_RE.match(v):
        raise ValueError(
            'project_id must be 1-80 characters and contain only '
            'letters, digits, hyphens, and underscores'
        )
    return v


class RepositorySourceOverride(BaseModel):
    kind: Literal["customization_snapshot"]
    project_id: str
    tenant_id: str
    snapshot_id: str
    source_root: str
    source_tree_hash: str


class GeneratedScanFile(BaseModel):
    path: str = Field(max_length=500)
    content: str = Field(max_length=500_000)

    @field_validator("path")
    @classmethod
    def safe_relative_path(cls, value):
        from pathlib import PurePosixPath
        value = value.replace("\\", "/")
        path = PurePosixPath(value)
        if path.is_absolute() or any(p in {"..", ".git"} for p in path.parts) or ":" in value or not path.parts:
            raise ValueError("Generated scan file must have a safe relative path")
        return value


class ScanValidationRequest(BaseModel):
    project_id: str
    project_name: str
    project_type: str
    user_id: str
    organization_id: Optional[str] = None

    @field_validator('project_id')
    @classmethod
    def project_id_safe(cls, v: str) -> str:
        return _validate_project_id(v)
    # Which scanners to run: sast (Bearer), sca (Syft+Grype), or all
    scan_type: Literal["sast", "sca", "all"] = "all"
    enabled_modules: Optional[list[str]] = None
    trigger: Literal["manual", "push", "pull_request", "build", "predeploy", "deployment", "schedule"] = "manual"
    source_revision: Optional[str] = Field(default=None, pattern=r"^[a-fA-F0-9]{40,64}$")
    artifact_digest: Optional[str] = Field(default=None, pattern=r"^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$")
    generated_files: list[GeneratedScanFile] = Field(default_factory=list, max_length=100)
    dast_target_url: Optional[str] = None
    dast_asset_id: Optional[str] = None
    dast_scan_id: Optional[str] = None
    dast_scan_profile: Optional[Literal["BASELINE", "FULL", "API"]] = None
    dast_scan_intent: Optional[Literal["PASSIVE", "ACTIVE", "API_ACTIVE"]] = None
    dast_api_spec_url: Optional[str] = None
    dast_authorization: Optional[dict[str, Any]] = None
    aws_access_key_id: Optional[str] = None
    aws_secret_access_key: Optional[str] = None
    aws_session_token: Optional[str] = None
    aws_region: Optional[str] = None
    # GitHub-specific fields (only for github projects)
    github_token: Optional[str] = None
    repository_url: Optional[str] = None
    source_override: Optional[RepositorySourceOverride] = None

    @field_validator("enabled_modules")
    @classmethod
    def modules_safe(cls, v: Optional[list[str]]) -> Optional[list[str]]:
        allowed = {
            "sast", "sca", "sbom", "secrets", "iac", "containers",
            "kubernetes", "cicd", "api", "dast", "cloud",
        }
        if not v:
            return None
        cleaned: list[str] = []
        for item in v:
            name = str(item or "").strip().lower()
            if name in allowed and name not in cleaned:
                cleaned.append(name)
        return cleaned or None

    @field_validator("dast_target_url")
    @classmethod
    def dast_target_safe(cls, v: Optional[str]) -> Optional[str]:
        raw = str(v or "").strip()
        if not raw:
            return None
        from dast_scan import validate_dast_target
        ok, error = validate_dast_target(raw)
        if not ok:
            raise ValueError(error)
        return raw

    @model_validator(mode="after")
    def dast_requires_authorization(self):
        url = str(self.dast_target_url or "").strip()
        requested = self.enabled_modules or []
        if not url and "dast" not in requested:
            self.dast_authorization = None
            return self
        if not url:
            return self
        from dast_agent.authorization import authorize_target
        from dast_agent.codes import DAST_TARGET_NOT_AUTHORIZED, USER_NOT_AUTHORIZED
        grant = self.dast_authorization if isinstance(self.dast_authorization, dict) else None
        result = authorize_target(
            project_id=self.project_id,
            requested_target=url,
            grant=grant,
        )
        if not result.authorized:
            raise ValueError(f"{result.code or DAST_TARGET_NOT_AUTHORIZED}: {result.message or USER_NOT_AUTHORIZED}")
        profile = str(self.dast_scan_profile or "BASELINE").upper()
        intent = str(self.dast_scan_intent or "PASSIVE").upper()
        if profile == "FULL" and intent != "ACTIVE":
            raise ValueError("Active DAST requires explicit ACTIVE intent.")
        if profile == "API" and intent != "API_ACTIVE":
            raise ValueError("API DAST requires explicit API_ACTIVE intent.")
        if profile == "BASELINE":
            self.dast_scan_profile = "BASELINE"
            self.dast_scan_intent = "PASSIVE"
        spec = str(self.dast_api_spec_url or "").strip()
        if spec:
            from dast_agent.ssrf import inspect_outbound_target
            check = inspect_outbound_target(spec)
            if not check.ok:
                raise ValueError(f"{check.code}: {check.message}")
            if result.scope and not result.scope.covers_url(check.normalized.url if check.normalized else spec):
                raise ValueError("API specification URL is outside the authorized scan scope.")
        return self

    @model_validator(mode="after")
    def cloud_credentials_when_requested(self):
        requested = self.enabled_modules or []
        if "cloud" not in requested:
            self.aws_access_key_id = None
            self.aws_secret_access_key = None
            self.aws_session_token = None
            return self
        if not self.aws_access_key_id and not self.aws_secret_access_key:
            # Missing prerequisites are explicit tool skips, not fabricated clean scans.
            return self
        from cloud_scan import validate_cloud_scan_request
        ok, error, region = validate_cloud_scan_request(
            self.aws_access_key_id,
            self.aws_secret_access_key,
            self.aws_region,
        )
        if not ok:
            raise ValueError(error)
        self.aws_region = region
        return self


def public_scan_validation(request: ScanValidationRequest) -> dict[str, Any]:
    """Serialize a scan request for HTTP responses without re-running inbound validators.

    Cloud/DAST model validators require secrets. Echoing them is wrong, but
    constructing ScanValidationRequest with those fields cleared raises
    ValidationError and becomes an HTML 500 in the UI.
    """
    payload = request.model_dump(mode="json")
    payload["aws_secret_access_key"] = None
    payload["aws_session_token"] = None
    payload["dast_authorization"] = None
    payload["github_token"] = None
    payload["aws_access_key_id"] = None
    payload.pop("generated_files", None)
    return payload


class ScanValidationResponse(BaseModel):
    success: bool
    message: str
    data: dict[str, Any]


class WebSocketCommand(BaseModel):
    action: Literal["start", "continue_round", "push_current", "approve_push", "cancel"]


class StreamStatus(str, Enum):
    running = "running"
    waiting_decision = "waiting_decision"
    waiting_approval = "waiting_approval"
    completed = "completed"
    error = "error"


ScanContext = ScanValidationRequest


class ScanMessage(BaseModel):
    index: int
    total: int
    type: str
    content: str
    timestamp: str

    @classmethod
    def create(cls, index: int, total: int, msg_type: str, content: str) -> "ScanMessage":
        return cls(
            index=index,
            total=total,
            type=msg_type,
            content=content,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )


class RemediationRequest(BaseModel):
    project_id: str
    project_name: str
    project_type: Literal["local", "github"]

    @field_validator('project_id')
    @classmethod
    def project_id_safe(cls, v: str) -> str:
        return _validate_project_id(v)
    user_id: str
    organization_id: Optional[str] = None
    # GitHub-specific fields (only for github projects)
    github_token: Optional[str] = None
    repository_url: Optional[str] = None
    # User-supplied LLM provider override (ollama | claude | openai | gemini | groq | openrouter)
    llm_provider: Optional[str] = None
    llm_api_key: Optional[str] = None
    llm_model: Optional[str] = None
    llm_access_mode: Optional[Literal["platform", "byok", "auto"]] = "auto"
    llm_credential_id: Optional[str] = None
    remediation_scope: Literal["major", "all"] = "major"
    # Created server-side after validation. Never accepted as a client identity.
    remediation_run_id: Optional[str] = None
    resume_publication: bool = False


class RemediationResponse(BaseModel):
    success: bool
    message: str
    run_id: Optional[str] = None


# ---------------------------------------------------------------------------
# Architecture generation
# ---------------------------------------------------------------------------

class ArchitectureGenRequest(BaseModel):
    prompt: str
    provider: str = "aws"
    user_id: Optional[str] = None
    organization_id: Optional[str] = None
    llm_provider: Optional[str] = None
    llm_api_key: Optional[str] = None
    llm_model: Optional[str] = None


class ArchitectureGenResponse(BaseModel):
    success: bool
    architecture_json: Optional[ArchitectureDocument] = None
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Cost estimation
# ---------------------------------------------------------------------------

class CostEstimateRequest(BaseModel):
    architecture_json: ArchitectureDocument
    provider: str = "aws"
    aws_access_key_id: Optional[str] = None
    aws_secret_access_key: Optional[str] = None


class CostEstimateResponse(BaseModel):
    success: bool
    provider: str = ""
    total_monthly_usd: Optional[float] = None
    currency: Optional[str] = None
    breakdown: Optional[list] = None
    note: Optional[str] = None
    errors: Optional[list] = None
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Terraform generation
# ---------------------------------------------------------------------------

class TerraformGenRequest(BaseModel):
    project_id: Optional[str] = None
    architecture_json: dict[str, Any]
    repository_context: Optional[dict[str, Any]] = None
    deployment_profile: Optional[dict[str, Any]] = None
    approval_payload: Optional[dict[str, Any]] = None
    security_context: Optional[dict[str, Any]] = None
    website_asset_stats: Optional[dict[str, Any]] = None
    frontend_entrypoint_detection: Optional[dict[str, Any]] = None
    detected: Optional[dict[str, Any]] = None
    user_answers: Optional[dict[str, Any]] = None
    consultant_decision: Optional[dict[str, Any]] = None
    provider: str = "aws"
    project_name: str = "deplai-project"
    workspace: str = "default"
    state_bucket: str = ""
    lock_table: str = ""
    aws_region: str = "eu-north-1"
    aws_access_key_id: Optional[str] = None
    aws_secret_access_key: Optional[str] = None
    qa_summary: Optional[str] = None
    openai_api_key: Optional[str] = None
    refresh_docs: Optional[bool] = False
    iac_mode: Optional[str] = None
    llm_provider: Optional[str] = None
    llm_api_key: Optional[str] = None
    llm_model: Optional[str] = None
    llm_api_base_url: Optional[str] = None
    website_index_html: Optional[str] = None
    terraform_renderer: Optional[str] = None
    source_root: Optional[str] = None
    source_root_candidates: Optional[list[str]] = None
    repository_url: Optional[str] = None
    source_metadata: Optional[dict[str, Any]] = None
    user_id: Optional[str] = None
    organization_id: Optional[str] = None


class TerraformConsultRequest(BaseModel):
    architecture_json: dict[str, Any]
    repository_context: Optional[dict[str, Any]] = None
    deployment_profile: Optional[dict[str, Any]] = None
    detected: Optional[dict[str, Any]] = None
    aws_region: str = "eu-north-1"
    conversation_history: list[dict[str, str]] = Field(default_factory=list)
    turn_count: int = 0
    force_decision: bool = False
    workspace: Optional[str] = None
    project_id: Optional[str] = None
    project_name: Optional[str] = None
    user_answers: Optional[dict[str, Any]] = None
    prior_decision: Optional[dict[str, Any]] = None
    llm_provider: Optional[str] = None
    llm_api_key: Optional[str] = None
    llm_model: Optional[str] = None
    llm_api_base_url: Optional[str] = None
    user_id: Optional[str] = None
    organization_id: Optional[str] = None


class TerraformConsultResponse(BaseModel):
    success: bool
    assistant_message: Optional[str] = None
    ready: bool = False
    decision: Optional[dict[str, Any]] = None
    open_questions: Optional[list[str]] = None
    repo_detection_summary: Optional[str] = None
    turn_count: int = 0
    decision_summary: Optional[str] = None
    source: Optional[str] = None
    fallback_reason: Optional[str] = None
    error: Optional[str] = None


class InfraAdviseRequest(BaseModel):
    architecture_json: dict[str, Any] = Field(default_factory=dict)
    repository_context: Optional[dict[str, Any]] = None
    deployment_profile: Optional[dict[str, Any]] = None
    detected: Optional[dict[str, Any]] = None
    aws_region: str = "eu-north-1"
    conversation_history: list[dict[str, str]] = Field(default_factory=list)
    turn_count: int = 0
    force_decision: bool = False
    workspace: Optional[str] = None
    project_id: Optional[str] = None
    project_name: Optional[str] = None
    user_answers: Optional[dict[str, Any]] = None
    prior_decision: Optional[dict[str, Any]] = None
    budget_cap_usd: Optional[float] = None
    selected_tier: Optional[str] = None
    requirements: Optional[dict[str, Any]] = None
    llm_provider: Optional[str] = None
    llm_api_key: Optional[str] = None
    llm_model: Optional[str] = None
    llm_api_base_url: Optional[str] = None
    user_id: Optional[str] = None
    organization_id: Optional[str] = None


class InfraAdviseResponse(BaseModel):
    success: bool
    assistant_message: Optional[str] = None
    ready: bool = False
    decision: Optional[dict[str, Any]] = None
    open_questions: Optional[list[str]] = None
    repo_detection_summary: Optional[str] = None
    turn_count: int = 0
    decision_summary: Optional[str] = None
    source: Optional[str] = None
    fallback_reason: Optional[str] = None
    budget_cap_usd: Optional[float] = None
    selected_tier: Optional[str] = None
    cost_estimate: Optional[dict[str, Any]] = None
    budget_gate: Optional[dict[str, Any]] = None
    upgrade_suggestions: Optional[list[dict[str, Any]]] = None
    plan_tiers: Optional[dict[str, Any]] = None
    requirements: Optional[dict[str, Any]] = None
    error: Optional[str] = None


class TerraformGenResponse(BaseModel):
    success: bool
    provider: str = ""
    project_name: str = ""
    run_id: Optional[str] = None
    workspace: Optional[str] = None
    provider_version: Optional[str] = None
    state_bucket: Optional[str] = None
    lock_table: Optional[str] = None
    manifest: Optional[list] = None
    dag_order: Optional[list[str]] = None
    warnings: Optional[list[str]] = None
    files: Optional[list] = None
    readme: Optional[str] = None
    source: Optional[str] = None
    requested_renderer: Optional[str] = None
    actual_renderer: Optional[str] = None
    unsupported_reason: Optional[str] = None
    renderer: Optional[str] = None
    component_catalog_version: Optional[str] = None
    execution_kind: Optional[str] = None
    llm_iac_calls: Optional[int] = None
    llm_iac_disabled: Optional[bool] = None
    decision_applied: Optional[bool] = None
    decision_drift: Optional[list[dict[str, Any]]] = None
    deployment_package_id: Optional[str] = None
    details: Optional[dict] = None
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Terraform apply (runtime deployment)
# ---------------------------------------------------------------------------

class TerraformApplyFile(BaseModel):
    path: str
    content: str
    encoding: Optional[Literal["utf-8", "base64"]] = None


class TerraformApplyRequest(BaseModel):
    project_id: Optional[str] = None
    project_name: str = "deplai-project"
    provider: str = "aws"
    run_id: Optional[str] = None
    workspace: Optional[str] = None
    deployment_metadata: Optional[dict[str, Any]] = None
    state_bucket: Optional[str] = None
    lock_table: Optional[str] = None
    files: list[TerraformApplyFile] = Field(default_factory=list)
    aws_access_key_id: Optional[str] = None
    aws_secret_access_key: Optional[str] = None
    aws_session_token: Optional[str] = None
    aws_region: Optional[str] = None
    enforce_free_tier_ec2: Optional[bool] = True
    confirm_plan_summary: Optional[bool] = False
    database_required: bool = False
    customer_database_url: Optional[str] = None
    customer_host: Optional[str] = None
    customer_port: Optional[str] = None
    customer_database_name: Optional[str] = None
    customer_username: Optional[str] = None
    customer_password: Optional[str] = None


class TerraformApplyResponse(BaseModel):
    success: bool
    provider: str = ""
    project_name: str = ""
    status: Optional[str] = None
    outputs: Optional[dict] = None
    cloudfront_url: Optional[str] = None
    plan_summary: Optional[dict] = None
    provisioning_report: Optional[dict] = None
    one_time_credentials: Optional[dict] = None
    has_database_resources: Optional[bool] = None
    requires_plan_confirmation: Optional[bool] = None
    details: Optional[dict] = None
    error: Optional[str] = None


class TerraformApplyStopRequest(BaseModel):
    project_id: Optional[str] = None
    project_name: Optional[str] = None


class TerraformApplyStopResponse(BaseModel):
    success: bool
    message: Optional[str] = None
    error: Optional[str] = None


class TerraformApplyStatusRequest(BaseModel):
    project_id: Optional[str] = None
    project_name: Optional[str] = None


class TerraformApplyStatusResponse(BaseModel):
    success: bool
    status: str = "idle"  # idle | running | completed | error
    result: Optional[dict] = None
    error: Optional[str] = None


class TerraformPreflightRequest(BaseModel):
    terraform_text: str = ""
    files: list[TerraformApplyFile] = Field(default_factory=list)
    database_required: bool = False
    customer_database_url: Optional[str] = None
    customer_host: Optional[str] = None
    customer_port: Optional[str] = None
    customer_database_name: Optional[str] = None
    customer_username: Optional[str] = None
    customer_password: Optional[str] = None


class TerraformPreflightResponse(BaseModel):
    success: bool
    stage: str = "static_preflight"
    code: Optional[str] = None
    message: Optional[str] = None
    details: Optional[dict] = None


class BootstrapStatusRequest(BaseModel):
    instance_id: str = Field(pattern=r"^i-[0-9a-f]{8,17}$")
    aws_access_key_id: str
    aws_secret_access_key: str
    aws_session_token: Optional[str] = None
    aws_region: str = "eu-north-1"
    wait: bool = False
    timeout_seconds: int = Field(default=900, ge=30, le=3600)
    interval_seconds: int = Field(default=15, ge=5, le=60)


class BootstrapStatusResponse(BaseModel):
    success: bool
    terraform_status: str = "unknown"
    application_status: str = "unknown"
    bootstrap_status: Optional[dict] = None
    verification_status: str = "unknown"
    details: Optional[dict] = None
    error: Optional[str] = None


class AwsRuntimeDetailsRequest(BaseModel):
    project_name: str = "deplai-project"
    aws_access_key_id: str
    aws_secret_access_key: str
    aws_session_token: Optional[str] = None
    aws_region: str = "eu-north-1"
    instance_id: Optional[str] = None


class AwsRuntimeDetailsResponse(BaseModel):
    success: bool
    details: Optional[dict] = None
    error: Optional[str] = None


class AwsDestroyRequest(BaseModel):
    project_name: str = "deplai-project"
    aws_access_key_id: str
    aws_secret_access_key: str
    aws_session_token: Optional[str] = None
    aws_region: str = "eu-north-1"


class AwsDestroyResponse(BaseModel):
    success: bool
    details: Optional[dict] = None
    error: Optional[str] = None


class AwsInstanceActionRequest(BaseModel):
    project_name: str = "deplai-project"
    aws_access_key_id: str
    aws_secret_access_key: str
    aws_session_token: Optional[str] = None
    aws_region: str = "eu-north-1"
    instance_id: str
    action: str  # start | stop | reboot


class AwsInstanceActionResponse(BaseModel):
    success: bool
    details: Optional[dict] = None
    error: Optional[str] = None


class AwsAppSecretEntry(BaseModel):
    key: str
    value: str


class AwsAppSecretsListRequest(BaseModel):
    project_name: str = "deplai-project"
    aws_access_key_id: str
    aws_secret_access_key: str
    aws_session_token: Optional[str] = None
    aws_region: str = "eu-north-1"
    secrets_manager_prefix: str = ""
    environment: str = "prod"


class AwsAppSecretsUpsertRequest(BaseModel):
    project_name: str = "deplai-project"
    aws_access_key_id: str
    aws_secret_access_key: str
    aws_session_token: Optional[str] = None
    aws_region: str = "eu-north-1"
    secrets_manager_prefix: str = ""
    environment: str = "prod"
    secrets: list[AwsAppSecretEntry]


class AwsAppSecretsDeleteRequest(BaseModel):
    project_name: str = "deplai-project"
    aws_access_key_id: str
    aws_secret_access_key: str
    aws_session_token: Optional[str] = None
    aws_region: str = "eu-north-1"
    secrets_manager_prefix: str = ""
    environment: str = "prod"
    key: str


class AwsAppSecretsResponse(BaseModel):
    success: bool
    prefix: Optional[str] = None
    secrets: Optional[list[dict]] = None
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Stage 7 approval payload (diagram + cost + budget gate)
# ---------------------------------------------------------------------------

class Stage7ApprovalRequest(BaseModel):
    infra_plan: dict
    budget_cap_usd: float = 100.0
    pipeline_run_id: str = ""
    environment: str = "dev"
    user_id: Optional[str] = None
    organization_id: Optional[str] = None


class Stage7ApprovalResponse(BaseModel):
    success: bool
    approval_payload: Optional[dict] = None
    error: Optional[str] = None
