import os

from scanner_runtime import LogCallback, run_detached
from utils import sanitize_name, CODEBASE_VOLUME, SECURITY_REPORTS_VOLUME

SCANNER_TIMEOUT_SECONDS = int(os.getenv("GITLEAKS_TIMEOUT_SECONDS", os.getenv("SCANNER_TIMEOUT_SECONDS", "600")))
GITLEAKS_IMAGE = "zricethezav/gitleaks:v8.21.2"


def run_secrets_scan(
    project_name: str,
    project_id: str,
    on_log: LogCallback | None = None,
) -> tuple[bool, str]:
    """Run secret scanning against the project's codebase subdirectory.

    Gitleaks exit 0 = no leaks, 1 = leaks found. Both are successful scan outcomes.
    """
    filename = f"{sanitize_name(project_name)}_{project_id}_Secrets.json"
    return run_detached(
        image=GITLEAKS_IMAGE,
        command=[
            "detect",
            "--source", f"/src/{project_id}",
            "--no-git",
            "--report-format", "json",
            "--report-path", f"/output/{filename}",
            "--redact",
        ],
        user="0:0",
        volumes={
            CODEBASE_VOLUME: {"bind": "/src", "mode": "ro"},
            SECURITY_REPORTS_VOLUME: {"bind": "/output", "mode": "rw"},
        },
        timeout_seconds=SCANNER_TIMEOUT_SECONDS,
        engine="Gitleaks",
        on_log=on_log,
        success_codes=(0, 1),
    )
