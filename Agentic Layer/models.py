import re
from enum import Enum
from datetime import datetime, timezone
from pydantic import BaseModel, field_validator
from typing import Literal, Optional
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
    action: Literal["start", "approve_rescan"]


class StreamStatus(str, Enum):
    running = "running"
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
    architecture_json: ArchitectureDocument
    provider: str = "aws"
    project_name: str = "deplai-project"
    qa_summary: Optional[str] = None
    openai_api_key: Optional[str] = None


class TerraformGenResponse(BaseModel):
    success: bool
    provider: str = ""
    project_name: str = ""
    files: Optional[list] = None
    readme: Optional[str] = None
    source: Optional[str] = None
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Terraform apply (runtime deployment)
# ---------------------------------------------------------------------------

class TerraformApplyFile(BaseModel):
    path: str
    content: str
    encoding: Optional[Literal["utf-8", "base64"]] = None


class TerraformApplyRequest(BaseModel):
    project_name: str = "deplai-project"
    provider: str = "aws"
    files: list[TerraformApplyFile]
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
