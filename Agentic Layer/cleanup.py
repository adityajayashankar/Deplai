import logging

import docker

from utils import get_docker_client, SCANNER_SUFFIXES, VOLUME_NAMES

logger = logging.getLogger(__name__)


def cleanup_project_reports(project_id: str) -> tuple[bool, str]:
    """Remove scan report files for a specific project from the security_reports volume."""
    try:
        # Build the rm command using env-var expansion to prevent shell injection.
        # SCANNER_SUFFIXES are internal constants so they are safe to inline.
        patterns = " ".join(f"/vol/*_${{PID}}_{s}" for s in SCANNER_SUFFIXES)
        get_docker_client().containers.run(
            "alpine",
            command=["sh", "-c", f"rm -f {patterns}"],
            environment={"PID": project_id},
            volumes={"security_reports": {"bind": "/vol", "mode": "rw"}},
            remove=True,
        )
        return (True, "")
    except docker.errors.NotFound:
        return (True, "")
    except Exception as e:
        return (False, str(e))


def _stop_containers_using_volumes(client: docker.DockerClient) -> None:
    """Stop and remove any containers that reference our volumes."""
    volume_set = set(VOLUME_NAMES)
    try:
        for container in client.containers.list(all=True):
            try:
                mounts = container.attrs.get("Mounts", [])
                if any(m.get("Name") in volume_set for m in mounts):
                    logger.info("Stopping container %s using managed volume", container.short_id)
                    container.remove(force=True)
            except Exception as e:
                logger.debug("Could not remove container %s: %s", container.short_id, e)
    except Exception as e:
        logger.debug("Could not list containers for cleanup: %s", e)


def cleanup_volumes() -> tuple[bool, str]:
    """Remove Docker volumes created during scans."""
    client = get_docker_client()
    errors: list[str] = []

    # Stop any containers still referencing the volumes
    _stop_containers_using_volumes(client)

    # Remove each volume independently
    for name in VOLUME_NAMES:
        try:
            client.volumes.get(name).remove(force=True)
        except docker.errors.NotFound:
            pass
        except Exception as e:
            logger.error("Failed to remove volume %s: %s", name, e)
            errors.append(f"{name}: {e}")

    if errors:
        return (False, "; ".join(errors))
    return (True, "")
