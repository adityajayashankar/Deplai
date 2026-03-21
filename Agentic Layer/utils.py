import re
import os
from contextvars import ContextVar

import docker

_docker_client: docker.DockerClient | None = None

SEVERITY_LEVELS = ["critical", "high", "medium", "low"]
SCANNER_SUFFIXES = ["Bearer.json", "sbom.json", "Grype.json"]

CODEBASE_VOLUME = "codebase_deplai"
SECURITY_REPORTS_VOLUME = "security_reports"
LLM_OUTPUT_VOLUME = "LLM_Output"
GRYPE_DB_VOLUME = "grype_db_cache"
VOLUME_NAMES = [CODEBASE_VOLUME, SECURITY_REPORTS_VOLUME, LLM_OUTPUT_VOLUME, GRYPE_DB_VOLUME]

# Per-task project-scope tracking — safe for concurrent async tasks and executor threads
# (asyncio.run_in_executor copies the current context to the thread).
_current_project_id: ContextVar[str] = ContextVar("current_project_id", default="")


def set_current_project_id(project_id: str) -> None:
    """Set the active project id for this async task / executor thread."""
    _current_project_id.set(project_id)


def get_repo_root() -> str:
    """Return the in-container path to the current project's codebase directory.

    With per-project isolation every project is cloned into
    ``/repo/{project_id}/`` inside the codebase volume.  Falls back to
    ``/repo`` when no project scope has been set (backwards compatibility).
    """
    pid = _current_project_id.get()
    return f"/repo/{pid}" if pid else "/repo"


def get_docker_client() -> docker.DockerClient:
    """Return a shared Docker client (singleton)."""
    global _docker_client
    if _docker_client is None:
        _docker_client = docker.from_env()
    return _docker_client


def resolve_host_projects_dir() -> str | None:
    """Resolve host path mapped to /local-projects for helper containers.

    Preferred order:
    1) Source path of this container's /local-projects bind mount
    2) HOST_PROJECTS_DIR env var (legacy fallback)
    """
    try:
        container_id = os.environ.get("HOSTNAME")
        if container_id:
            container = get_docker_client().containers.get(container_id)
            mounts = container.attrs.get("Mounts", [])
            for mount in mounts:
                if mount.get("Destination") == "/local-projects":
                    source = mount.get("Source")
                    if source:
                        return source
    except Exception:
        pass

    return os.environ.get("HOST_PROJECTS_DIR")


def sanitize_name(name: str) -> str:
    """Make a project name safe for use in filenames."""
    return re.sub(r"[^a-zA-Z0-9_-]", "_", name)


def decode_output(output: bytes | str) -> str:
    """Decode Docker container output to a string."""
    return output.decode() if isinstance(output, bytes) else str(output)


# Regex that matches a GitHub x-access-token embedded in a URL, e.g.
# https://x-access-token:ghs_ABC123@github.com/
_GIT_TOKEN_RE = re.compile(r"x-access-token:[^@\s]+@", re.IGNORECASE)


def redact_git_token(text: str) -> str:
    """Replace any embedded GitHub access tokens in *text* with '***'."""
    return _GIT_TOKEN_RE.sub("x-access-token:***@", text)


def read_volume_file(filename: str) -> str | None:
    """Read a file from the security_reports Docker volume."""
    try:
        output = get_docker_client().containers.run(
            "alpine",
            command=["cat", f"/vol/{filename}"],
            volumes={"security_reports": {"bind": "/vol", "mode": "ro"}},
            remove=True,
        )
        return decode_output(output)
    except Exception:
        return None


def find_volume_file(project_id: str, suffix: str) -> str | None:
    """Find a file in the volume matching *_{project_id}_{suffix}."""
    try:
        # Pass project_id via environment variable to avoid shell metacharacter injection.
        output = get_docker_client().containers.run(
            "alpine",
            command=["sh", "-c", 'ls /vol/*_${PID}_${SFX} 2>/dev/null'],
            environment={"PID": project_id, "SFX": suffix},
            volumes={"security_reports": {"bind": "/vol", "mode": "ro"}},
            remove=True,
        )
        result = decode_output(output).strip()
        if result:
            return result.split("\n")[0].replace("/vol/", "")
        return None
    except Exception:
        return None
