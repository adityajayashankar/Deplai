import re
from enum import Enum
from datetime import datetime, timezone
from pydantic import BaseModel, Field, field_validator
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


class ScanValidationRequest(BaseModel):
    project_id: str
    project_name: str
    project_type: str
    user_id: str

    @field_validator('project_id')
    @classmethod
    def project_id_safe(cls, v: str) -> str:
        return _validate_project_id(v)
    # Which scanners to run: sast (Bearer), sca (Syft+Grype), or all
    scan_type: Literal["sast", "sca", "all"] = "all"
    # GitHub-specific fields (only for github projects)
    github_token: Optional[str] = None
    repository_url: Optional[str] = None


class ScanValidationResponse(BaseModel):
    success: bool
    message: str
    data: ScanValidationRequest


class WebSocketCommand(BaseModel):
    action: Literal["start", "continue_round", "push_current", "approve_push"]


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
    # GitHub-specific fields (only for github projects)
    github_token: Optional[str] = None
    repository_url: Optional[str] = None
    # Optional context from external knowledge graph agent (Cortex)
    cortex_context: Optional[str] = None
    # User-supplied LLM provider override (ollama | claude | openai | gemini | groq | openrouter)
    llm_provider: Optional[str] = None
    llm_api_key: Optional[str] = None
    llm_model: Optional[str] = None
    remediation_scope: Literal["major", "all"] = "all"


class RemediationResponse(BaseModel):
    success: bool
    message: str


# ---------------------------------------------------------------------------
# Architecture generation
# ---------------------------------------------------------------------------

class ArchitectureGenRequest(BaseModel):
    prompt: str
    provider: str = "aws"
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
    state_bucket: Optional[str] = None
    lock_table: Optional[str] = None
    files: list[TerraformApplyFile] = Field(default_factory=list)
    aws_access_key_id: Optional[str] = None
    aws_secret_access_key: Optional[str] = None
    aws_region: Optional[str] = None
    enforce_free_tier_ec2: Optional[bool] = True


class TerraformApplyResponse(BaseModel):
    success: bool
    provider: str = ""
    project_name: str = ""
    outputs: Optional[dict] = None
    cloudfront_url: Optional[str] = None
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


class AwsRuntimeDetailsRequest(BaseModel):
    project_name: str = "deplai-project"
    aws_access_key_id: str
    aws_secret_access_key: str
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
    aws_region: str = "eu-north-1"


class AwsDestroyResponse(BaseModel):
    success: bool
    details: Optional[dict] = None
    error: Optional[str] = None


class AwsInstanceActionRequest(BaseModel):
    project_name: str = "deplai-project"
    aws_access_key_id: str
    aws_secret_access_key: str
    aws_region: str = "eu-north-1"
    instance_id: str
    action: str  # start | stop | reboot


class AwsInstanceActionResponse(BaseModel):
    success: bool
    details: Optional[dict] = None
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Stage 7 approval payload (diagram + cost + budget gate)
# ---------------------------------------------------------------------------

class Stage7ApprovalRequest(BaseModel):
    infra_plan: dict
    budget_cap_usd: float = 100.0
    pipeline_run_id: str = ""
    environment: str = "dev"


class Stage7ApprovalResponse(BaseModel):
    success: bool
    approval_payload: Optional[dict] = None
    error: Optional[str] = None
