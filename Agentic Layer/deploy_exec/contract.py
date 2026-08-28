from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$")
_DIGEST_RE = re.compile(r"^sha256:[a-f0-9]{64}$")
_IMAGE_RE = re.compile(r"^[a-z0-9][a-z0-9.\-_/:]{1,500}$")
_PATH_RE = re.compile(r"^/[A-Za-z0-9._~!$&'()*+,;=:@/\-]*$")
_ARN_RE = re.compile(r"^arn:aws:(secretsmanager|ssm):[a-z0-9-]+:\d{12}:.+$")


def _require_id(value: str, field: str) -> str:
    raw = str(value or "").strip()
    if not _ID_RE.match(raw):
        raise ValueError(f"{field} must be a safe identifier")
    return raw


class ContractMetadata(BaseModel):
    project_id: str
    deployment_id: str = ""
    environment_id: str
    source_commit: str = ""
    created_at: str = ""
    requested_by: str = ""

    @field_validator("project_id", "environment_id", "requested_by")
    @classmethod
    def ids_safe(cls, value: str) -> str:
        raw = str(value or "").strip()
        if not raw:
            raise ValueError("required")
        if not re.match(r"^[a-zA-Z0-9._:-]{1,128}$", raw):
            raise ValueError("unsafe identifier")
        return raw


class ArtifactRef(BaseModel):
    artifact_id: str
    type: Literal["docker_image"] = "docker_image"
    registry: Literal["ecr"] = "ecr"
    repository: str
    image: str
    tag: str = ""
    digest: str
    status: Literal["SOURCE", "BUILD", "SECURITY_VALIDATED", "CREATED", "VERIFIED", "PROMOTED"] = "PROMOTED"
    build_id: str = ""

    @field_validator("artifact_id")
    @classmethod
    def artifact_id_safe(cls, value: str) -> str:
        return _require_id(value, "artifact_id")

    @field_validator("repository")
    @classmethod
    def repository_safe(cls, value: str) -> str:
        raw = str(value or "").strip()
        if not re.match(r"^[a-zA-Z0-9][a-zA-Z0-9._\-/:]{0,255}$", raw) or any(ch in raw for ch in ";|&`$()<>"):
            raise ValueError("repository must be a safe identifier")
        return raw

    @field_validator("digest")
    @classmethod
    def digest_immutable(cls, value: str) -> str:
        raw = str(value or "").strip().lower()
        if not _DIGEST_RE.match(raw):
            raise ValueError("digest must be sha256:<64 hex chars>")
        return raw

    @field_validator("image")
    @classmethod
    def image_safe(cls, value: str) -> str:
        raw = str(value or "").strip()
        if not _IMAGE_RE.match(raw) or any(ch in raw for ch in ";|&`$()<>"):
            raise ValueError("image reference is unsafe")
        return raw

    @property
    def pull_ref(self) -> str:
        return f"{self.image}@{self.digest}"


class TargetRef(BaseModel):
    provider: Literal["aws"] = "aws"
    account_id: str
    region: str
    environment: str
    target_id: str
    instance_id: str = ""

    @field_validator("account_id")
    @classmethod
    def account_digits(cls, value: str) -> str:
        raw = str(value or "").strip()
        if not raw:
            return ""
        if not re.match(r"^\d{12}$", raw):
            raise ValueError("account_id must be a 12-digit AWS account")
        return raw

    @field_validator("region")
    @classmethod
    def region_safe(cls, value: str) -> str:
        raw = str(value or "").strip()
        if not re.match(r"^[a-z]{2}-[a-z]+-\d$", raw):
            raise ValueError("invalid AWS region")
        return raw

    @field_validator("target_id", "environment")
    @classmethod
    def env_safe(cls, value: str) -> str:
        return _require_id(value, "target")

    @field_validator("instance_id")
    @classmethod
    def instance_safe(cls, value: str) -> str:
        raw = str(value or "").strip()
        if raw and not re.match(r"^i-[0-9a-f]{8,17}$", raw):
            raise ValueError("instance_id must look like i-...")
        return raw


class NetworkSpec(BaseModel):
    container_port: int = Field(ge=1, le=65535, default=3000)
    host_port: int = Field(ge=1, le=65535, default=80)
    public_endpoint: str = ""
    health_endpoint: str = "/health"

    @field_validator("health_endpoint")
    @classmethod
    def health_path(cls, value: str) -> str:
        raw = str(value or "/health").strip() or "/health"
        if not _PATH_RE.match(raw):
            raise ValueError("health_endpoint must be a URL path")
        return raw


class SecretReference(BaseModel):
    name: str
    arn: str

    @field_validator("name")
    @classmethod
    def name_safe(cls, value: str) -> str:
        return _require_id(value, "secret name")

    @field_validator("arn")
    @classmethod
    def arn_safe(cls, value: str) -> str:
        raw = str(value or "").strip()
        if not _ARN_RE.match(raw):
            raise ValueError("secret_reference must be a Secrets Manager or SSM ARN")
        return raw


class VerificationSpec(BaseModel):
    health_checks: list[dict[str, Any]] = Field(default_factory=list)
    smoke_tests: list[dict[str, Any]] = Field(default_factory=list)
    expected_status: int = 200
    timeout_seconds: int = Field(ge=5, le=300, default=60)
    interval_seconds: int = Field(ge=1, le=30, default=5)
    retries: int = Field(ge=1, le=20, default=8)
    dast_policy: str = ""


class RollbackSpec(BaseModel):
    enabled: bool = True
    previous_artifact: ArtifactRef | None = None
    strategy: Literal["replace"] = "replace"


class ExecutionSpec(BaseModel):
    adapter: Literal["ssm", "ssh"] = "ssm"
    timeout_seconds: int = Field(ge=30, le=3600, default=900)
    retry_max_attempts: int = Field(ge=1, le=5, default=3)


class DeploymentContract(BaseModel):
    metadata: ContractMetadata
    artifact: ArtifactRef
    target: TargetRef
    runtime: dict[str, Any] = Field(default_factory=lambda: {"type": "docker", "version": "24"})
    application: dict[str, Any] = Field(default_factory=dict)
    network: NetworkSpec = Field(default_factory=NetworkSpec)
    configuration: dict[str, Any] = Field(default_factory=dict)
    secret_references: list[SecretReference] = Field(default_factory=list)
    strategy: dict[str, Any] = Field(default_factory=lambda: {"deployment_type": "replace"})
    execution: ExecutionSpec = Field(default_factory=ExecutionSpec)
    verification: VerificationSpec = Field(default_factory=VerificationSpec)
    rollback: RollbackSpec = Field(default_factory=RollbackSpec)
    policy: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def runtime_docker(self) -> "DeploymentContract":
        runtime_type = str((self.runtime or {}).get("type") or "docker").strip().lower()
        if runtime_type != "docker":
            raise ValueError("first release only supports runtime.type=docker")
        strategy = str((self.strategy or {}).get("deployment_type") or "replace").strip().lower()
        if strategy != "replace":
            raise ValueError("first release only supports replace strategy")
        app_name = str((self.application or {}).get("name") or (self.application or {}).get("container_name") or "app")
        if not _ID_RE.match(app_name):
            raise ValueError("application name must be a safe identifier")
        return self

    @property
    def container_name(self) -> str:
        return str(
            (self.application or {}).get("container_name")
            or (self.application or {}).get("name")
            or "app"
        )

    @property
    def environment_key(self) -> str:
        return f"{self.metadata.project_id}:{self.metadata.environment_id}"
