import os

from scanner_runtime import LogCallback, run_detached
from utils import sanitize_name, CODEBASE_VOLUME, SECURITY_REPORTS_VOLUME

# Bearer can take significantly longer on large monorepos. Keep a generous default,
# while still allowing strict overrides via environment variables.
SCANNER_TIMEOUT_SECONDS = int(
    os.getenv(
        "BEARER_TIMEOUT_SECONDS",
        os.getenv("SCANNER_TIMEOUT_SECONDS", "1800"),
    )
)
BEARER_IMAGE = "bearer/bearer:latest-amd64"


def run_bearer_scan(
    project_name: str,
    project_id: str,
    on_log: LogCallback | None = None,
) -> tuple[bool, str]:
    """Run the Bearer security scanner against the project's codebase subdirectory."""
    filename = f"{sanitize_name(project_name)}_{project_id}_Bearer.json"
    return run_detached(
        image=BEARER_IMAGE,
        command=["scan", f"/tmp/scan/{project_id}", "--format", "json", "--output", f"/output/{filename}"],
        user="0:0",
        volumes={
            CODEBASE_VOLUME: {"bind": "/tmp/scan", "mode": "rw"},
            SECURITY_REPORTS_VOLUME: {"bind": "/output", "mode": "rw"},
        },
        timeout_seconds=SCANNER_TIMEOUT_SECONDS,
        engine="Bearer",
        on_log=on_log,
        success_codes=(0, 1),
    )
