import asyncio
import os
from fastapi import WebSocket

from models import ScanContext, StreamStatus
from runner_base import RunnerBase
from bearer import run_bearer_scan
from sbom import run_syft_scan, run_grype_scan
from utils import get_docker_client, decode_output, VOLUME_NAMES, CODEBASE_VOLUME, SECURITY_REPORTS_VOLUME, resolve_host_projects_dir, set_current_project_id

TOTAL_STEPS = 12
CONTAINER_OP_TIMEOUT = int(os.getenv("CONTAINER_OP_TIMEOUT", "120"))  # seconds for volume/clone ops


class EnvironmentInitializer(RunnerBase):
    def __init__(self, websocket: WebSocket, scan_context: ScanContext):
        super().__init__(websocket, TOTAL_STEPS)
        self.scan_context = scan_context
        self._docker = get_docker_client()

    def _check_docker_running(self) -> bool:
        """Verify the Docker Engine is reachable."""
        try:
            self._docker.ping()
            return True
        except Exception:
            return False

    def _check_volumes_exist(self) -> bool:
        try:
            for name in VOLUME_NAMES:
                self._docker.volumes.get(name)
            return True
        except Exception:
            return False

    def _create_volumes(self) -> tuple[bool, str]:
        try:
            for name in VOLUME_NAMES:
                self._docker.volumes.create(name=name)
            return (True, "")
        except Exception as e:
            return (False, str(e))

    def _clear_codebase_volume(self) -> tuple[bool, str]:
        """Remove and recreate the project's own subdirectory in the codebase volume.

        Only the calling project's directory is touched — other projects' code is
        left intact, which is essential for correct multi-project behaviour.
        """
        try:
            project_id = self.scan_context.project_id
            container = self._docker.containers.run(
                "alpine",
                command=["sh", "-c", "rm -rf /vol/${PID} && mkdir -p /vol/${PID}"],
                environment={"PID": project_id},
                volumes={CODEBASE_VOLUME: {"bind": "/vol", "mode": "rw"}},
                detach=True,
            )
            container.wait(timeout=CONTAINER_OP_TIMEOUT)
            container.remove(force=True)
            return (True, "")
        except Exception as e:
            return (False, str(e))

    def _clear_project_reports(self) -> tuple[bool, str]:
        """Remove previous scan reports for this project to avoid stale UI results."""
        try:
            project_id = self.scan_context.project_id
            container = self._docker.containers.run(
                "alpine",
                command=[
                    "sh", "-c",
                    # Use env-var expansion — $PID is never interpreted as shell syntax
                    "rm -f /vol/*_${PID}_Bearer.json /vol/*_${PID}_sbom.json /vol/*_${PID}_Grype.json",
                ],
                environment={"PID": project_id},
                volumes={SECURITY_REPORTS_VOLUME: {"bind": "/vol", "mode": "rw"}},
                detach=True,
            )
            container.wait(timeout=CONTAINER_OP_TIMEOUT)
            container.remove(force=True)
            return (True, "")
        except Exception as e:
            return (False, str(e))

    def _ingest_github_repo(self) -> tuple[bool, str]:
        """Clone a GitHub repository into a per-project subdirectory of the codebase volume."""
        try:
            token = self.scan_context.github_token
            repo_url = self.scan_context.repository_url
            project_id = self.scan_context.project_id

            if not repo_url or not token:
                return (False, "Missing repository URL or GitHub token")

            if not repo_url.endswith(".git"):
                repo_url = repo_url + ".git"

            # Embed the installation token as x-access-token (GitHub's official method
            # for App installation tokens with git HTTP smart protocol).
            # Using http.extraHeader Bearer does NOT work because GitHub's git endpoint
            # returns a WWW-Authenticate: Basic challenge; Bearer causes git to
            # re-prompt for credentials and fail with exit 128.
            auth_url = repo_url.replace("https://", f"https://x-access-token:{token}@")

            container = self._docker.containers.run(
                "alpine/git",
                command=[
                    "clone", "--depth", "1",
                    auth_url,
                    f"/repo/{project_id}",
                ],
                environment={"GIT_TERMINAL_PROMPT": "0"},
                volumes={CODEBASE_VOLUME: {"bind": "/repo", "mode": "rw"}},
                detach=True,
            )
            result = container.wait(timeout=CONTAINER_OP_TIMEOUT)
            container.remove(force=True)
            exit_code = result.get("StatusCode", -1)
            if exit_code != 0:
                return (False, f"git clone failed with exit code {exit_code}")

            # Strip the embedded token from .git/config by resetting the remote URL to
            # the plain https:// form — the token never lingers in the volume.
            # We intentionally keep .git so the remediation pipeline can later commit
            # and push fixes without needing to re-clone.
            cleanup = self._docker.containers.run(
                "alpine/git",
                command=["git", "-C", f"/repo/{project_id}", "remote", "set-url", "origin", repo_url],
                volumes={CODEBASE_VOLUME: {"bind": "/repo", "mode": "rw"}},
                detach=True,
            )
            cleanup.wait(timeout=CONTAINER_OP_TIMEOUT)
            cleanup.remove(force=True)

            return (True, "")
        except Exception as e:
            return (False, str(e))

    def _ingest_local_project(self) -> tuple[bool, str]:
        """Copy local project files into the codebase_deplai volume."""
        try:
            user_id = self.scan_context.user_id
            project_id = self.scan_context.project_id

            host_base = resolve_host_projects_dir()
            if host_base:
                check_path = os.path.join("/local-projects", user_id, project_id)
                host_path = os.path.join(host_base, user_id, project_id)
            else:
                host_path = os.path.abspath(
                    os.path.join(
                        os.path.dirname(__file__), "..", "Connector", "tmp",
                        "local-projects", user_id, project_id,
                    )
                )
                check_path = host_path

            if not os.path.isdir(check_path):
                return (False, f"Local project directory not found at {check_path}")

            output = self._docker.containers.run(
                "alpine",
                command=["sh", "-c", "mkdir -p /repo/${PID} && cp -a /src/. /repo/${PID}/ && echo Success || echo Failed"],
                environment={"PID": project_id},
                volumes={
                    CODEBASE_VOLUME: {"bind": "/repo", "mode": "rw"},
                    host_path: {"bind": "/src", "mode": "ro"},
                },
                remove=True,
            )
            decoded = decode_output(output)
            if "Success" in decoded:
                return (True, "")
            return (False, f"Copy failed: {decoded}")
        except Exception as e:
            return (False, str(e))

    async def _run_pipeline(self) -> bool:
        self._check_cancelled()
        await self._send_message("phase", "Initializing Scan")

        # Scope all codebase volume operations to this project's subdirectory.
        set_current_project_id(self.scan_context.project_id)

        docker_ok = await self._run_step(self._check_docker_running)
        if not docker_ok:
            return await self._terminate(
                "Docker Engine is not running. Please start Docker Desktop and try again."
            )

        already_exist = await self._run_step(self._check_volumes_exist)

        if already_exist:
            await self._send_message("success", "Setup already available. Skipping initialization and proceeding.")

            success, error_msg = await self._run_step(self._clear_codebase_volume)
            if not success:
                return await self._terminate(f"Error: Terminating workflow — {error_msg}")
            await self._send_message("info", "Clearing out old content")

            success, error_msg = await self._run_step(self._clear_project_reports)
            if not success:
                return await self._terminate(f"Error: Terminating workflow — {error_msg}")
            await self._send_message("info", "Removed previous scan reports for this project")
            await self._send_message("success", "Setup is ready")
        else:
            success, error_msg = await self._run_step(self._create_volumes)
            if not success:
                return await self._terminate(f"Error: Terminating workflow — {error_msg}")
            await self._send_message("info", "Docker volumes created successfully")

            success, error_msg = await self._run_step(self._clear_project_reports)
            if not success:
                return await self._terminate(f"Error: Terminating workflow — {error_msg}")
            await self._send_message("info", "Removed previous scan reports for this project")
            await self._send_message("success", "Setup is ready")

        ingest = self._ingest_github_repo if self.scan_context.project_type == "github" else self._ingest_local_project
        success, error_msg = await self._run_step(ingest)
        if not success:
            return await self._terminate(f"Error: Terminating workflow — {error_msg}")
        await self._send_message("success", "Project successfully copied to volume.")

        self._check_cancelled()
        await self._send_message("phase", "Executing security tools")

        p_name = self.scan_context.project_name
        p_id = self.scan_context.project_id
        scan_type = getattr(self.scan_context, "scan_type", "all")

        async def bearer_branch() -> tuple[bool, str, str]:
            success, error_msg = await self._run_step(
                lambda: run_bearer_scan(p_name, p_id)
            )
            return (success, error_msg, "Bearer")

        async def sbom_branch() -> tuple[bool, str, str]:
            success, error_msg = await self._run_step(
                lambda: run_syft_scan(p_name, p_id)
            )
            if not success:
                return (False, error_msg, "Syft")
            success, error_msg = await self._run_step(
                lambda: run_grype_scan(p_name, p_id)
            )
            return (success, error_msg, "Syft+Grype")

        tasks = []
        if scan_type in ("sast", "all"):
            await self._send_message("info", "Starting Bearer code security scanner (large repos may take 10-30+ minutes)...")
            tasks.append(bearer_branch())
        if scan_type in ("sca", "all"):
            await self._send_message("info", "Starting Syft SBOM generation and Grype vulnerability scan (can be long on large repos)...")
            tasks.append(sbom_branch())

        async def heartbeat(interval: int = 30):
            elapsed = 0
            while True:
                await asyncio.sleep(interval)
                elapsed += interval
                await self._send_message("info", f"Scanners still running... ({elapsed}s elapsed)")

        hb_task = asyncio.create_task(heartbeat())
        try:
            results = await asyncio.gather(*tasks)
        finally:
            hb_task.cancel()
            try:
                await hb_task
            except asyncio.CancelledError:
                pass

        for success, error_msg, tool_name in results:
            if success:
                await self._send_message("success", f"{tool_name} scan completed successfully")
            else:
                await self._send_message("error", f"{tool_name} scan failed: {error_msg}")

        if not all(success for success, _, _ in results):
            await self._send_status(StreamStatus.error)
            return False

        return True

