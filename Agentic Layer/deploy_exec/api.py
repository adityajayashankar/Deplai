"""Agentic Layer deployment execution APIs."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from deploy_exec import store
from deploy_exec.errors import DeployError
from deploy_exec.service import (
    artifact_defaults,
    cancel_deployment,
    create_deployment,
    get_deployment,
    preflight,
    resume_deployment,
    retry_deployment,
    rollback_deployment,
)

router = APIRouter(prefix="/api/deploy-exec", tags=["deploy-exec"])


class AwsCredentials(BaseModel):
    aws_access_key_id: str = ""
    aws_secret_access_key: str = ""
    aws_session_token: str = ""
    aws_region: str = ""
    account_id: str = ""


class CreateDeploymentRequest(BaseModel):
    contract: dict[str, Any]
    dry_run: bool = False
    background: bool = True
    credentials: AwsCredentials = Field(default_factory=AwsCredentials)


class DeploymentIdBody(BaseModel):
    credentials: AwsCredentials = Field(default_factory=AwsCredentials)


def _creds(body: AwsCredentials | None) -> dict[str, str]:
    if body is None:
        return {}
    return {key: value for key, value in body.model_dump().items() if value}


@router.post("")
@router.post("/")
def post_create(body: CreateDeploymentRequest) -> dict[str, Any]:
    try:
        if body.dry_run:
            return preflight(body.contract, credentials=_creds(body.credentials))
        return create_deployment(
            body.contract,
            credentials=_creds(body.credentials),
            dry_run=False,
            background=body.background,
        )
    except DeployError as extra:
        status = 409 if extra.code == "ENVIRONMENT_LOCKED" else 400
        if extra.code in {"TARGET_UNAUTHORIZED", "WRONG_ACCOUNT", "UNVERIFIED_ARTIFACT"}:
            status = 403
        raise HTTPException(status_code=status, detail=extra.as_dict()) from extra


@router.get("/{deployment_id}")
def get_one(deployment_id: str) -> dict[str, Any]:
    record = get_deployment(deployment_id)
    if not record:
        raise HTTPException(status_code=404, detail="Deployment not found")
    return record


@router.get("/{deployment_id}/events")
def get_events(deployment_id: str) -> dict[str, Any]:
    if not store.read_latest(deployment_id):
        raise HTTPException(status_code=404, detail="Deployment not found")
    return {"deployment_id": deployment_id, "events": store.read_events(deployment_id)}


@router.get("/{deployment_id}/logs")
def get_logs(deployment_id: str) -> dict[str, Any]:
    if not store.read_latest(deployment_id):
        raise HTTPException(status_code=404, detail="Deployment not found")
    return {"deployment_id": deployment_id, "logs": store.read_logs(deployment_id)}


@router.post("/{deployment_id}/cancel")
def post_cancel(deployment_id: str) -> dict[str, Any]:
    if not store.read_latest(deployment_id):
        raise HTTPException(status_code=404, detail="Deployment not found")
    return cancel_deployment(deployment_id)


@router.post("/{deployment_id}/retry")
def post_retry(deployment_id: str, body: Optional[DeploymentIdBody] = None) -> dict[str, Any]:
    try:
        return retry_deployment(deployment_id, credentials=_creds(body.credentials if body else None))
    except DeployError as extra:
        raise HTTPException(status_code=400, detail=extra.as_dict()) from extra


@router.post("/{deployment_id}/resume")
def post_resume(deployment_id: str, body: Optional[DeploymentIdBody] = None) -> dict[str, Any]:
    try:
        return resume_deployment(deployment_id, credentials=_creds(body.credentials if body else None))
    except DeployError as extra:
        raise HTTPException(status_code=400, detail=extra.as_dict()) from extra


@router.post("/{deployment_id}/rollback")
def post_rollback(deployment_id: str, body: Optional[DeploymentIdBody] = None) -> dict[str, Any]:
    try:
        return rollback_deployment(deployment_id, credentials=_creds(body.credentials if body else None))
    except DeployError as extra:
        raise HTTPException(status_code=400, detail=extra.as_dict()) from extra


@router.post("/preflight")
def post_preflight(body: CreateDeploymentRequest) -> dict[str, Any]:
    try:
        return preflight(body.contract, credentials=_creds(body.credentials))
    except DeployError as extra:
        raise HTTPException(status_code=400, detail=extra.as_dict()) from extra


class ArtifactDefaultsRequest(BaseModel):
    image: str = ""
    credentials: AwsCredentials = Field(default_factory=AwsCredentials)


@router.post("/artifact-defaults")
def post_artifact_defaults(body: ArtifactDefaultsRequest) -> dict[str, Any]:
    return artifact_defaults(body.image, credentials=_creds(body.credentials))
