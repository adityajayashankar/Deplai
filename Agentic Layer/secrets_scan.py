import os

from utils import get_docker_client, sanitize_name, CODEBASE_VOLUME, SECURITY_REPORTS_VOLUME

SCANNER_TIMEOUT_SECONDS = int(os.getenv("GITLEAKS_TIMEOUT_SECONDS", os.getenv("SCANNER_TIMEOUT_SECONDS", "600")))
GITLEAKS_IMAGE = "zricethezav/gitleaks:v8.21.2"


def run_secrets_scan(project_name: str, project_id: str) -> tuple[bool, str]:
    """Run secret scanning against the project's codebase subdirectory.

    Gitleaks exit 0 = no leaks, 1 = leaks found. Both are successful scan outcomes.
    """
    container = None
    try:
        filename = f"{sanitize_name(project_name)}_{project_id}_Secrets.json"
        container = get_docker_client().containers.run(
            GITLEAKS_IMAGE,
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
            detach=True,
        )
        result = container.wait(timeout=SCANNER_TIMEOUT_SECONDS)
        container.remove(force=True)
        exit_code = result.get("StatusCode", -1)
        if exit_code in (0, 1):
            return (True, "")
        return (False, f"Secret scanner exited with code {exit_code}")
    except Exception as e:
        if container is not None:
            try:
                container.remove(force=True)
            except Exception:
                pass
        return (False, str(e))
