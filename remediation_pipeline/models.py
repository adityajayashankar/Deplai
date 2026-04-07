from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


Severity = Literal["critical", "high", "medium", "low"]
VulnType = Literal["sast", "sca"]
FixStatus = Literal["auto", "needs_review"]


class Vulnerability(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: str
    file: str
    line_start: int = Field(ge=1)
    line_end: int = Field(ge=1)
    rule_id: str
    severity: Severity
    description: str
    cwe: Optional[str] = None
    type: VulnType


class FileGroup(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    filepath: str
    language: str
    vulns: list[Vulnerability]
    max_severity: Severity


class Snippet(BaseModel):
    model_config = ConfigDict(extra="forbid")

    vuln_id: str
    line_start: int = Field(ge=1)
    line_end: int = Field(ge=1)
    code: str


class SnippetBundle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    filepath: str
    language: str
    imports_block: str
    snippets: list[Snippet]
    token_estimate: int = Field(ge=0)


class Fix(BaseModel):
    model_config = ConfigDict(extra="forbid")

    filepath: str
    diff: str
    vulns_addressed: list[str]
    provider_used: str
    tokens_used: int = Field(ge=0)
    status: FixStatus
    raw_response: Optional[str] = None
    warnings: list[str] = Field(default_factory=list)


class RemediationRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    project_id: str
    project_name: Optional[str] = None
    github_token: Optional[str] = None
    repository_url: Optional[str] = None


class ProviderQuota(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    provider: str
    model: str
    quota_daily: int
    calls_used_today: int
    reset_at_utc: datetime


class ProviderStatusResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    providers: list[ProviderQuota]


class RemediationPRRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    project_id: Optional[str] = None
    repository_url: str
    github_token: str
    fixes: list[Fix]
    accepted_filepaths: list[str] = Field(default_factory=list)


class RemediationPRResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    success: bool
    pr_url: Optional[str] = None
    branch: Optional[str] = None
    message: str


class RemediationRefreshRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    project_id: str


class RemediationNavigateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    track: Literal["deployment", "customization", "security"]
