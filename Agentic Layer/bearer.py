import os

from utils import get_docker_client, sanitize_name, CODEBASE_VOLUME, SECURITY_REPORTS_VOLUME

# Bearer can take significantly longer on large monorepos. Keep a generous default,
# while still allowing strict overrides via environment variables.
SCANNER_TIMEOUT_SECONDS = int(
    os.getenv(
        "BEARER_TIMEOUT_SECONDS",
        os.getenv("SCANNER_TIMEOUT_SECONDS", "1800"),
    )
)


def run_bearer_scan(project_name: str, project_id: str) -> tuple[bool, str]:
    """Run the Bearer security scanner against the project's codebase subdirectory."""
    container = None
    try:
        filename = f"{sanitize_name(project_name)}_{project_id}_Bearer.json"
        container = get_docker_client().containers.run(
            "bearer/bearer:latest-amd64",
            command=["scan", f"/tmp/scan/{project_id}", "--format", "json", "--output", f"/output/{filename}"],
            user="0:0",
            volumes={
                CODEBASE_VOLUME: {"bind": "/tmp/scan", "mode": "rw"},
                SECURITY_REPORTS_VOLUME: {"bind": "/output", "mode": "rw"},
            },
            detach=True,
        )
        result = container.wait(timeout=SCANNER_TIMEOUT_SECONDS)
        container.remove(force=True)
        exit_code = result.get("StatusCode", -1)
        if exit_code in (0, 1):
            return (True, "")
        return (False, f"Bearer exited with code {exit_code}")
    except Exception as e:
        if container is not None:
            try:
                container.remove(force=True)
            except Exception:
                pass
        return (False, str(e))
