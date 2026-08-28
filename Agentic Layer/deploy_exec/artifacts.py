from __future__ import annotations

import re
from typing import Any

from deploy_exec.contract import ArtifactRef
from deploy_exec.errors import DeployError

_DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
_ECR_IMAGE = re.compile(
    r"^(?P<account>\d{12})\.dkr\.ecr\.(?P<region>[a-z0-9-]+)\.amazonaws\.com/(?P<repo>[A-Za-z0-9][A-Za-z0-9._/-]{0,255})$"
)
PROMOTABLE = {"VERIFIED", "PROMOTED"}


def validate_artifact(artifact: ArtifactRef | dict) -> ArtifactRef:
    if isinstance(artifact, dict):
        try:
            artifact = ArtifactRef.model_validate(artifact)
        except Exception as exc:
            raise DeployError(code="ARTIFACT_UNVERIFIED", technical_message=str(exc)) from exc
    if not _DIGEST.match(artifact.digest):
        raise DeployError(code="ARTIFACT_UNVERIFIED", technical_message="digest is not immutable")
    if artifact.status not in PROMOTABLE:
        raise DeployError(
            code="UNVERIFIED_ARTIFACT",
            recommended_action="Promote a verified image digest before deploying.",
            details={"status": artifact.status},
        )
    return artifact


def promote(artifact: ArtifactRef) -> ArtifactRef:
    payload = artifact.model_dump()
    payload["status"] = "PROMOTED"
    return ArtifactRef.model_validate(payload)


def assert_local_digest(expected: str, stdout: str) -> None:
    wanted = str(expected or "").strip().lower()
    text = str(stdout or "").strip().lower()
    if not wanted.startswith("sha256:") or len(wanted) != 71:
        raise DeployError(code="ARTIFACT_UNVERIFIED", technical_message="approved digest is not immutable")
    hex_part = wanted.split(":", 1)[-1]
    if wanted not in text and hex_part not in text:
        raise DeployError(
            code="ARTIFACT_INTEGRITY_FAILED",
            recommended_action="Refuse this deployment and pull the approved digest again.",
            details={"expected": wanted},
        )


def normalize_ecr_image(image: str) -> str:
    raw = str(image or "").strip().split("@", 1)[0]
    last = raw.rsplit("/", 1)[-1]
    if ":" in last and not last.startswith("sha256:"):
        raw = raw.rsplit(":", 1)[0]
    return raw


def parse_ecr_image(image: str) -> dict[str, str]:
    raw = normalize_ecr_image(image)
    match = _ECR_IMAGE.match(raw)
    if not match:
        raise DeployError(code="ARTIFACT_NOT_FOUND", technical_message="image is not an ECR repository URI")
    repo = str(match.group("repo") or "")
    return {
        "account": match.group("account"),
        "region": match.group("region"),
        "repository": repo,
        "image": raw,
    }


def latest_ecr_digest(image: str, credentials: dict[str, Any] | None = None, *, client: Any = None) -> str:
    parsed = parse_ecr_image(image)
    ecr = client
    if ecr is None:
        import boto3

        creds = credentials or {}
        kwargs: dict[str, Any] = {"region_name": parsed["region"]}
        key = str(creds.get("aws_access_key_id") or "").strip()
        secret = str(creds.get("aws_secret_access_key") or "").strip()
        if key and secret:
            kwargs["aws_access_key_id"] = key
            kwargs["aws_secret_access_key"] = secret
            if creds.get("aws_session_token"):
                kwargs["aws_session_token"] = creds["aws_session_token"]
        ecr = boto3.client("ecr", **kwargs)
    try:
        response = ecr.describe_images(
            registryId=parsed["account"],
            repositoryName=parsed["repository"],
            filter={"tagStatus": "ANY"},
            maxResults=100,
        )
    except Exception as exc:
        raise DeployError(code="ARTIFACT_NOT_FOUND", technical_message=str(exc)[:200]) from exc
    details = list(response.get("imageDetails") or [])
    details.sort(key=lambda item: str(item.get("imagePushedAt") or ""), reverse=True)
    digest = str((details[0] if details else {}).get("imageDigest") or "").strip().lower()
    if not _DIGEST.match(digest):
        raise DeployError(code="ARTIFACT_NOT_FOUND", technical_message="ECR repository has no immutable image digest yet")
    return digest
