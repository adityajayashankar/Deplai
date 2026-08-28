import os
import re

from dast_scan import is_module_only_run
from utils import get_docker_client, sanitize_name, decode_output, SECURITY_REPORTS_VOLUME

SCANNER_TIMEOUT_SECONDS = int(os.getenv("CLOUD_TIMEOUT_SECONDS", os.getenv("SCANNER_TIMEOUT_SECONDS", "1800")))
PROWLER_IMAGE = os.getenv("PROWLER_IMAGE", "prowlercloud/prowler:5.8.0")
_REGION_RE = re.compile(r"^[a-z]{2}(-[a-z]+)+-\d+$")


def cloud_credentials_present(access_key: str | None, secret_key: str | None) -> bool:
    return bool(str(access_key or "").strip() and str(secret_key or "").strip())


def is_cloud_only_run(requested: list[str] | None, access_key: str | None, secret_key: str | None) -> bool:
    return is_module_only_run(requested, "cloud") and cloud_credentials_present(access_key, secret_key)


def validate_cloud_scan_request(
    access_key: str | None,
    secret_key: str | None,
    region: str | None,
) -> tuple[bool, str, str]:
    key = str(access_key or "").strip()
    secret = str(secret_key or "").strip()
    aws_region = str(region or "eu-north-1").strip() or "eu-north-1"
    if not key or not secret:
        return (False, "AWS credentials are required for live cloud scanning.", aws_region)
    if len(key) > 128 or len(secret) > 128:
        return (False, "AWS credentials are invalid.", aws_region)
    if not _REGION_RE.match(aws_region):
        return (False, "AWS region is invalid.", aws_region)
    return (True, "", aws_region)


def run_cloud_scan(
    project_name: str,
    project_id: str,
    access_key: str,
    secret_key: str,
    session_token: str | None = None,
    region: str = "eu-north-1",
) -> tuple[bool, str]:
    """Run live AWS account scanning against the authorized operator credentials."""
    ok, error, aws_region = validate_cloud_scan_request(access_key, secret_key, region)
    if not ok:
        return (False, error)

    container = None
    stem = f"{sanitize_name(project_name)}_{project_id}_Cloud"
    environment = {
        "AWS_ACCESS_KEY_ID": str(access_key).strip(),
        "AWS_SECRET_ACCESS_KEY": str(secret_key).strip(),
        "AWS_DEFAULT_REGION": aws_region,
        "AWS_REGION": aws_region,
        "HOME": "/tmp",
    }
    token = str(session_token or "").strip()
    if token:
        environment["AWS_SESSION_TOKEN"] = token

    environment["STEM"] = stem
    try:
        # Prowler 5 dropped native JSON. json-ocsf writes {stem}.ocsf.json; copy
        # that to {stem}.json so the reports volume lookup for Cloud.json works.
        container = get_docker_client().containers.run(
            PROWLER_IMAGE,
            entrypoint="/bin/sh",
            command=[
                "-c",
                (
                    "prowler aws --region \"$AWS_REGION\" --filter-region \"$AWS_REGION\" "
                    "--output-formats json-ocsf --output-directory /home/prowler/output "
                    "--output-filename \"$STEM\"; "
                    "code=$?; "
                    "if [ -f \"/home/prowler/output/${STEM}.ocsf.json\" ]; then "
                    "cp \"/home/prowler/output/${STEM}.ocsf.json\" \"/home/prowler/output/${STEM}.json\"; "
                    "fi; "
                    "exit $code"
                ),
            ],
            user="0:0",
            environment=environment,
            volumes={
                SECURITY_REPORTS_VOLUME: {"bind": "/home/prowler/output", "mode": "rw"},
            },
            detach=True,
        )
        result = container.wait(timeout=SCANNER_TIMEOUT_SECONDS)
        logs = decode_output(container.logs(stdout=True, stderr=True, tail=40))
        container.remove(force=True)
        exit_code = result.get("StatusCode", -1)
        # 0 = no FAIL findings, 3 = FAIL findings present. Both are completed scans.
        if exit_code in (0, 3):
            return (True, "")
        detail = " ".join(logs.split())[:280]
        suffix = f": {detail}" if detail else ""
        return (False, f"Cloud scanning exited with code {exit_code}{suffix}")
    except Exception as exc:
        if container is not None:
            try:
                container.remove(force=True)
            except Exception:
                pass
        return (False, str(exc))
