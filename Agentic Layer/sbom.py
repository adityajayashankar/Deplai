import os

from utils import get_docker_client, sanitize_name, decode_output, CODEBASE_VOLUME, SECURITY_REPORTS_VOLUME, GRYPE_DB_VOLUME

# Syft also needs more time for large repositories.
SCANNER_TIMEOUT_SECONDS = int(
    os.getenv(
        "SYFT_TIMEOUT_SECONDS",
        os.getenv("SCANNER_TIMEOUT_SECONDS", "1200"),
    )
)
GRYPE_TIMEOUT_SECONDS = int(os.getenv("GRYPE_TIMEOUT_SECONDS", "900"))


def run_syft_scan(project_name: str, project_id: str) -> tuple[bool, str]:
    """Generate an SBOM from the project's codebase subdirectory using Syft."""
    container = None
    try:
        sbom_filename = f"{sanitize_name(project_name)}_{project_id}_sbom.json"
        container = get_docker_client().containers.run(
            "anchore/syft",
            command=[f"dir:/src/{project_id}", "-o", f"json=/repo/{sbom_filename}"],
            volumes={
                CODEBASE_VOLUME: {"bind": "/src", "mode": "ro"},
                SECURITY_REPORTS_VOLUME: {"bind": "/repo", "mode": "rw"},
            },
            detach=True,
        )
        result = container.wait(timeout=SCANNER_TIMEOUT_SECONDS)
        container.remove(force=True)
        exit_code = result.get("StatusCode", -1)
        if exit_code == 0:
            return (True, "")
        return (False, f"Syft exited with code {exit_code}")
    except Exception as e:
        if container is not None:
            try:
                container.remove(force=True)
            except Exception:
                pass
        return (False, str(e))


def run_grype_scan(project_name: str, project_id: str) -> tuple[bool, str]:
    """Run Grype vulnerability scanner against the Syft SBOM."""
    container = None
    try:
        safe_name = sanitize_name(project_name)
        sbom_filename = f"{safe_name}_{project_id}_sbom.json"
        grype_filename = f"{safe_name}_{project_id}_Grype.json"
        container = get_docker_client().containers.run(
            "anchore/grype",
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
            detach=True,
        )
        result = container.wait(timeout=GRYPE_TIMEOUT_SECONDS)
        container.remove(force=True)
        exit_code = result.get("StatusCode", -1)
        if exit_code == 0:
            check = get_docker_client().containers.run(
                "alpine",
                command=["sh", "-lc", f"test -s /repo/{grype_filename} && echo ok || echo empty"],
                volumes={SECURITY_REPORTS_VOLUME: {"bind": "/repo", "mode": "ro"}},
                remove=True,
            )
            if "ok" in decode_output(check):
                return (True, "")
            return (False, "Grype report file is empty.")
        return (False, f"Grype exited with code {exit_code}")
    except Exception as e:
        if container is not None:
            try:
                container.remove(force=True)
            except Exception:
                pass
        return (False, str(e))
