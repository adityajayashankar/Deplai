"""Structured deployment error codes. LLM output never invents these."""

from __future__ import annotations

RETRYABLE = {
    "SSM_TIMEOUT",
    "SSM_OFFLINE",
    "IMAGE_PULL_FAILED",
    "TIMEOUT",
    "AWS_API_FAILURE",
    "HEALTH_CHECK_FAILED",
    "EXTERNAL_ENDPOINT_FAILED",
}

NON_RETRYABLE = {
    "TARGET_NOT_FOUND",
    "TARGET_UNAUTHORIZED",
    "ENVIRONMENT_LOCKED",
    "WRONG_ACCOUNT",
    "WRONG_REGION",
    "IAM_PERMISSION_DENIED",
    "SSM_PERMISSION_DENIED",
    "SSM_COMMAND_FAILED",
    "ARTIFACT_NOT_FOUND",
    "ARTIFACT_UNVERIFIED",
    "ARTIFACT_INTEGRITY_FAILED",
    "ECR_AUTH_FAILED",
    "DOCKER_NOT_AVAILABLE",
    "DOCKER_START_FAILED",
    "APPLICATION_START_FAILED",
    "PORT_CONFLICT",
    "CONFIGURATION_ERROR",
    "SECRET_RESOLUTION_FAILED",
    "SMOKE_TEST_FAILED",
    "ROLLBACK_FAILED",
    "CONTRACT_INVALID",
    "BLUEPRINT_INVALID",
    "UNVERIFIED_ARTIFACT",
    "CANCELLED",
}

SECURITY_BLOCKED = {
    "TARGET_UNAUTHORIZED",
    "WRONG_ACCOUNT",
    "WRONG_REGION",
    "UNVERIFIED_ARTIFACT",
    "ARTIFACT_UNVERIFIED",
}


def result_class(status: str, code: str = "") -> str:
    status_u = str(status or "").strip().upper()
    code_u = str(code or "").strip().upper()
    if status_u in {"COMPLETED"}:
        return "SUCCESS"
    if status_u in {"ROLLED_BACK"}:
        return "ROLLED_BACK"
    if code_u == "ROLLBACK_FAILED" or status_u == "ROLLBACK_FAILED":
        return "ROLLBACK_FAILED"
    if status_u in {"CANCELLED"} or code_u == "CANCELLED":
        return "CANCELLED"
    if code_u in SECURITY_BLOCKED:
        return "SECURITY_BLOCKED"
    if status_u in {"FAILED"}:
        return "FAILED"
    return "PENDING"

CODES = {
    "CONTRACT_INVALID": "Deployment contract failed validation.",
    "BLUEPRINT_INVALID": "Deployment blueprint failed validation.",
    "TARGET_NOT_FOUND": "The deployment target was not found.",
    "TARGET_UNAUTHORIZED": "The target is not associated with this project and environment.",
    "ENVIRONMENT_LOCKED": "Another deployment is already modifying this environment.",
    "WRONG_ACCOUNT": "AWS account does not match the environment contract.",
    "WRONG_REGION": "AWS region does not match the environment contract.",
    "SSM_OFFLINE": "SSM agent is not online for this instance.",
    "SSM_TIMEOUT": "SSM command timed out.",
    "SSM_PERMISSION_DENIED": "SSM denied the deployment command.",
    "SSM_COMMAND_FAILED": "The SSM command failed on the instance.",
    "IAM_PERMISSION_DENIED": "IAM denied a required deployment action.",
    "ARTIFACT_INTEGRITY_FAILED": "The pulled image digest does not match the approved artifact.",
    "EXTERNAL_ENDPOINT_FAILED": "The public endpoint did not return the expected response.",
    "ARTIFACT_NOT_FOUND": "No immutable image is in ECR yet. Redeploy infrastructure so DeplAI builds the app on the instance from your repository.",
    "ARTIFACT_UNVERIFIED": "The artifact has not been promoted for deployment.",
    "UNVERIFIED_ARTIFACT": "Refusing to deploy an artifact that is not verified.",
    "ECR_AUTH_FAILED": "ECR authentication failed.",
    "IMAGE_PULL_FAILED": "Pulling the immutable image failed.",
    "DOCKER_NOT_AVAILABLE": "Docker is not installed or not running on the host.",
    "DOCKER_START_FAILED": "The container failed to start.",
    "PORT_CONFLICT": "The required host port is already in use.",
    "CONFIGURATION_ERROR": "Runtime configuration is invalid.",
    "SECRET_RESOLUTION_FAILED": "A referenced secret could not be resolved.",
    "APPLICATION_START_FAILED": "The application process failed to start.",
    "HEALTH_CHECK_FAILED": "The health endpoint did not return the expected response.",
    "SMOKE_TEST_FAILED": "A smoke test failed.",
    "TIMEOUT": "A deployment operation exceeded its timeout.",
    "ROLLBACK_FAILED": "Rollback to the previous artifact failed.",
    "AWS_API_FAILURE": "An AWS API call failed.",
    "CANCELLED": "Deployment was cancelled at a safe checkpoint.",
}


def retryable(code: str) -> bool:
    return str(code or "").strip().upper() in RETRYABLE
