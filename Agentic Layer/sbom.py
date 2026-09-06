import os

from scanner_runtime import LogCallback, run_detached
from utils import get_docker_client, sanitize_name, decode_output, CODEBASE_VOLUME, SECURITY_REPORTS_VOLUME, GRYPE_DB_VOLUME

# Syft also needs more time for large repositories.
SCANNER_TIMEOUT_SECONDS = int(
    os.getenv(
        "SYFT_TIMEOUT_SECONDS",
        os.getenv("SCANNER_TIMEOUT_SECONDS", "1200"),
    )
)
GRYPE_TIMEOUT_SECONDS = int(os.getenv("GRYPE_TIMEOUT_SECONDS", "900"))
SYFT_IMAGE = "anchore/syft"
GRYPE_IMAGE = "anchore/grype"


def run_syft_scan(
    project_name: str,
    project_id: str,
    on_log: LogCallback | None = None,
    *, target_source: str | None = None, report_suffix: str = "sbom.json",
) -> tuple[bool, str]:
    """Generate an SBOM from the project's codebase subdirectory using Syft."""
    sbom_filename = f"{sanitize_name(project_name)}_{project_id}_{report_suffix}"
    return run_detached(
        image=SYFT_IMAGE,
        command=[target_source or f"dir:/src/{project_id}", "-o", f"json=/repo/{sbom_filename}"],
        volumes={
            CODEBASE_VOLUME: {"bind": "/src", "mode": "ro"},
            SECURITY_REPORTS_VOLUME: {"bind": "/repo", "mode": "rw"},
        },
        timeout_seconds=SCANNER_TIMEOUT_SECONDS,
        engine="Syft",
        on_log=on_log,
        success_codes=(0,),
    )


def run_grype_scan(
    project_name: str,
    project_id: str,
    on_log: LogCallback | None = None,
    *, sbom_suffix: str = "sbom.json", report_suffix: str = "Grype.json",
) -> tuple[bool, str]:
    """Run Grype vulnerability scanner against the Syft SBOM."""
    safe_name = sanitize_name(project_name)
    sbom_filename = f"{safe_name}_{project_id}_{sbom_suffix}"
    grype_filename = f"{safe_name}_{project_id}_{report_suffix}"
    ok, error = run_detached(
        image=GRYPE_IMAGE,
        command=[
            f"sbom:/repo/{sbom_filename}",
            "--output", "json",
            "--file", f"/repo/{grype_filename}",
        ],
        environment={"GRYPE_DB_CACHE_DIR": "/grype-db"},
        volumes={
            SECURITY_REPORTS_VOLUME: {"bind": "/repo", "mode": "rw"},
            GRYPE_DB_VOLUME: {"bind": "/grype-db", "mode": "rw"},
        },
        timeout_seconds=GRYPE_TIMEOUT_SECONDS,
        engine="Grype",
        on_log=on_log,
        success_codes=(0,),
    )
    if not ok:
        return (False, error)
    try:
        check = get_docker_client().containers.run(
            "alpine",
            command=["sh", "-lc", f"test -s /repo/{grype_filename} && echo ok || echo empty"],
            volumes={SECURITY_REPORTS_VOLUME: {"bind": "/repo", "mode": "ro"}},
            remove=True,
        )
        if "ok" in decode_output(check):
            return (True, "")
        return (False, "Grype report file is empty.")
    except Exception as exc:
        return (False, str(exc))
