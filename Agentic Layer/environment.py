import asyncio
import os
from urllib.parse import quote
from fastapi import WebSocket

from models import ScanContext, StreamStatus
from repository_sources import resolve_snapshot_source_override
from runner_base import RunnerBase
from bearer import run_bearer_scan
from sbom import run_syft_scan, run_grype_scan
from secrets_scan import run_secrets_scan, GITLEAKS_IMAGE
from iac_scan import (
    detect_scan_targets,
    run_iac_scan,
    run_container_scan,
    run_kubernetes_scan,
    run_cicd_scan,
    run_api_scan,
    CHECKOV_IMAGE,
)
from dast_scan import dast_should_run, is_dast_only_run, run_dast_scan, ZAP_IMAGE
from cloud_scan import (
    PROWLER_IMAGE,
    is_cloud_only_run,
    run_cloud_scan,
)
from datetime import datetime, timezone
from utils import (
    ensure_docker_image,
    get_docker_client,
    decode_output,
    VOLUME_NAMES,
    CODEBASE_VOLUME,
    SECURITY_REPORTS_VOLUME,
    SCANNER_SUFFIXES,
    resolve_host_mounted_path,
    resolve_host_projects_dir,
    set_current_project_id,
    sanitize_name,
)
import json

TOTAL_STEPS = 24
CONTAINER_OP_TIMEOUT = int(os.getenv("CONTAINER_OP_TIMEOUT", "120"))  # seconds for volume/clone ops
SCAN_IMAGES = (
    "alpine",
    "alpine/git",
    "bearer/bearer:latest-amd64",
    "anchore/syft",
    "anchore/grype",
    GITLEAKS_IMAGE,
    CHECKOV_IMAGE,
)
PIPELINE_MODULES = (
    "sast", "sca", "sbom", "secrets", "iac", "containers",
    "kubernetes", "cicd", "api", "dast", "cloud",
)


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

    def _ensure_scan_images(self) -> tuple[bool, str]:
        """Pull scanner worker images before mutating a project workspace.

        This gives a direct error when the Docker host has no registry access,
        instead of appearing to stall on the first Docker operation.
        """
        try:
            for image in SCAN_IMAGES:
                ensure_docker_image(image)
            return (True, "")
        except Exception as exc:
            return (False, str(exc))

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

    def _clear_project_reports(self, suffixes: list[str] | None = None) -> tuple[bool, str]:
        """Remove previous scan reports for this project to avoid stale UI results."""
        try:
            project_id = self.scan_context.project_id
            selected = suffixes or SCANNER_SUFFIXES
            patterns = " ".join(f"/vol/*_${{PID}}_{suffix}" for suffix in selected)
            container = self._docker.containers.run(
                "alpine",
                command=["sh", "-c", f"rm -f {patterns}"],
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

            def _clone(remote_url: str) -> tuple[bool, str]:
                clone_container = None
                try:
                    clone_container = self._docker.containers.run(
                        "alpine/git",
                        command=[
                            "clone", "--depth", "1",
                            remote_url,
                            f"/repo/{project_id}",
                        ],
                        environment={"GIT_TERMINAL_PROMPT": "0"},
                        volumes={CODEBASE_VOLUME: {"bind": "/repo", "mode": "rw"}},
                        detach=True,
                    )
                    result = clone_container.wait(timeout=CONTAINER_OP_TIMEOUT)
                    logs = decode_output(clone_container.logs(tail=40))
                    clone_container.remove(force=True)
                    exit_code = result.get("StatusCode", -1)
                    if exit_code == 0:
                        return (True, "")
                    detail = (logs or f"git clone exited with code {exit_code}").strip()
                    return (False, detail)
                except Exception as clone_exc:
                    if clone_container is not None:
                        try:
                            clone_container.remove(force=True)
                        except Exception:
                            pass
                    return (False, str(clone_exc))

            # Embed the installation token as x-access-token (GitHub's official method
            # for App installation tokens with git HTTP smart protocol).
            # Using http.extraHeader Bearer does NOT work because GitHub's git endpoint
            # returns a WWW-Authenticate: Basic challenge; Bearer causes git to
            # re-prompt for credentials and fail with exit 128.
            encoded_token = quote(token, safe="")
            auth_url = repo_url.replace("https://", f"https://x-access-token:{encoded_token}@")

            ok, clone_error = _clone(auth_url)
            if not ok:
                # Some GitHub App installations are scoped to selected repositories and
                # can fail auth even for publicly readable repos. Retry anonymously so
                # scans still work for public repositories.
                ok_public, public_error = _clone(repo_url)
                if not ok_public:
                    detail = clone_error or public_error or "git clone failed"
                    return (False, f"Git clone failed. {detail}")

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

    def _ingest_snapshot_source(self) -> tuple[bool, str]:
        """Copy a validated immutable customization snapshot into the scan volume."""
        try:
            source = resolve_snapshot_source_override(
                self.scan_context.source_override,
                project_id=self.scan_context.project_id,
            )
            host_path = resolve_host_mounted_path(str(source))
            output = self._docker.containers.run(
                "alpine",
                command=[
                    "sh",
                    "-c",
                    "mkdir -p /repo/${PID} && cp -a /src/. /repo/${PID}/ && echo Success || echo Failed",
                ],
                environment={"PID": self.scan_context.project_id},
                volumes={
                    CODEBASE_VOLUME: {"bind": "/repo", "mode": "rw"},
                    host_path: {"bind": "/src", "mode": "ro"},
                },
                remove=True,
            )
            decoded = decode_output(output)
            return (True, "") if "Success" in decoded else (False, f"Copy failed: {decoded}")
        except Exception as exc:
            return (False, f"Snapshot source validation failed: {exc}")

    def _ensure_image(self, image: str) -> tuple[bool, str]:
        try:
            ensure_docker_image(image)
            return (True, "")
        except Exception as exc:
            return (False, str(exc))

    def _write_pipeline_summary(self, modules: list[dict]) -> tuple[bool, str]:
        try:
            filename = f"{sanitize_name(self.scan_context.project_name)}_{self.scan_context.project_id}_Pipeline.json"
            payload = json.dumps({
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "modules": modules,
            })
            container = self._docker.containers.run(
                "alpine",
                command=["sh", "-c", "printf '%s' \"$PAYLOAD\" > /vol/$FILE"],
                environment={"PAYLOAD": payload, "FILE": filename},
                volumes={SECURITY_REPORTS_VOLUME: {"bind": "/vol", "mode": "rw"}},
                detach=True,
            )
            container.wait(timeout=CONTAINER_OP_TIMEOUT)
            container.remove(force=True)
            return (True, "")
        except Exception as exc:
            return (False, str(exc))

    async def _send_module(self, module: str, status: str, **extra) -> None:
        payload = {"module": module, "status": status, **extra}
        await self._send_message("module", json.dumps(payload))

    async def _run_single_module(
        self,
        module_id: str,
        label: str,
        report_suffix: str,
        image: str,
        runner,
    ) -> bool:
        """Run one module without wiping or re-running the rest of the pipeline."""
        self._check_cancelled()
        await self._send_message("phase", "Initializing Scan")
        set_current_project_id(self.scan_context.project_id)
        await self._send_module(module_id, "QUEUED")

        docker_ok = await self._run_step(self._check_docker_running)
        if not docker_ok:
            return await self._terminate(
                "Docker Engine is not running. Please start Docker Desktop and try again."
            )

        already_exist = await self._run_step(self._check_volumes_exist)
        if not already_exist:
            success, error_msg = await self._run_step(self._create_volumes)
            if not success:
                return await self._terminate(f"Error: Terminating workflow — {error_msg}")
            await self._send_message("info", "Docker volumes created successfully")

        success, error_msg = await self._run_step(lambda: self._clear_project_reports(suffixes=[report_suffix]))
        if not success:
            return await self._terminate(f"Error: Terminating workflow — {error_msg}")
        await self._send_message("info", f"Cleared previous {label} report")

        await self._send_message("phase", "Executing security tools")
        image_ok, image_error = await self._run_step(lambda: self._ensure_image(image))
        if not image_ok:
            await self._send_module(module_id, "FAILED", error=f"{label[0].upper() + label[1:]} image could not be prepared.")
            await self._send_message("error", f"{label[0].upper() + label[1:]} image could not be prepared. {image_error}")
            await self._run_step(lambda: self._write_pipeline_summary([{
                "id": module_id,
                "status": "FAILED",
                "error": f"{label[0].upper() + label[1:]} image could not be prepared.",
            }]))
            await self._send_status(StreamStatus.error)
            return False

        await self._send_module(module_id, "RUNNING")
        await self._send_message("info", f"Starting {label}...")
        success, error_msg = await self._run_step(runner)
        if success:
            record = {"id": module_id, "status": "COMPLETED"}
            await self._send_module(module_id, "COMPLETED")
            await self._send_message("success", f"{label[0].upper() + label[1:]} completed")
        else:
            record = {
                "id": module_id,
                "status": "FAILED",
                "error": error_msg or f"{label[0].upper() + label[1:]} failed.",
            }
            await self._send_module(module_id, "FAILED", error=record["error"])
            await self._send_message("error", f"{label[0].upper() + label[1:]} failed. {error_msg}")

        await self._run_step(lambda: self._write_pipeline_summary([record]))
        return True

    async def _run_dast_only(self, dast_url: str) -> bool:
        """Test an authorized URL without wiping or re-running other modules."""
        return await self._run_single_module(
            "dast",
            "dynamic testing",
            "Dast.json",
            ZAP_IMAGE,
            lambda: run_dast_scan(
                self.scan_context.project_name,
                self.scan_context.project_id,
                dast_url,
                context=self.scan_context,
                cancelled_check=lambda: self._cancelled,
            ),
        )

    async def _run_cloud_only(self) -> bool:
        """Scan the authorized AWS account without wiping or re-running other modules."""
        return await self._run_single_module(
            "cloud",
            "cloud account scanning",
            "Cloud.json",
            PROWLER_IMAGE,
            lambda: run_cloud_scan(
                self.scan_context.project_name,
                self.scan_context.project_id,
                str(getattr(self.scan_context, "aws_access_key_id", "") or ""),
                str(getattr(self.scan_context, "aws_secret_access_key", "") or ""),
                str(getattr(self.scan_context, "aws_session_token", "") or "") or None,
                str(getattr(self.scan_context, "aws_region", "") or "eu-north-1"),
            ),
        )

    async def _run_pipeline(self) -> bool:
        requested = getattr(self.scan_context, "enabled_modules", None) or None
        dast_url = getattr(self.scan_context, "dast_target_url", None)
        if is_dast_only_run(requested, dast_url):
            return await self._run_dast_only(str(dast_url))
        if is_cloud_only_run(
            requested,
            getattr(self.scan_context, "aws_access_key_id", None),
            getattr(self.scan_context, "aws_secret_access_key", None),
        ):
            return await self._run_cloud_only()

        self._check_cancelled()
        await self._send_message("phase", "Initializing Scan")

        # Scope all codebase volume operations to this project's subdirectory.
        set_current_project_id(self.scan_context.project_id)

        docker_ok = await self._run_step(self._check_docker_running)
        if not docker_ok:
            return await self._terminate(
                "Docker Engine is not running. Please start Docker Desktop and try again."
            )

        await self._send_message("info", "Preparing security scanner images...")
        images_ready, image_error = await self._run_step(self._ensure_scan_images)
        if not images_ready:
            return await self._terminate(
                f"Unable to prepare required scanner images. Verify Docker Hub access from the production host. {image_error}"
            )
        await self._send_message("success", "Security scanner images are ready.")

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

            # Newly created volumes may contain leftover project directories
            # (e.g., from a previous host-mounted volume). Ensure the project's
            # code subdirectory is cleared so `git clone` can target an empty
            # directory. This mirrors the behaviour when volumes already exist.
            success, error_msg = await self._run_step(self._clear_codebase_volume)
            if not success:
                return await self._terminate(f"Error: Terminating workflow — {error_msg}")
            await self._send_message("info", "Clearing out old content")

            success, error_msg = await self._run_step(self._clear_project_reports)
            if not success:
                return await self._terminate(f"Error: Terminating workflow — {error_msg}")
            await self._send_message("info", "Removed previous scan reports for this project")
            await self._send_message("success", "Setup is ready")

        if self.scan_context.source_override is not None:
            ingest = self._ingest_snapshot_source
        else:
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
        requested = getattr(self.scan_context, "enabled_modules", None) or None
        dast_url = getattr(self.scan_context, "dast_target_url", None)
        module_records: dict[str, dict] = {}

        def wants(module: str) -> bool:
            if module == "cloud":
                return False
            if module == "dast":
                return dast_should_run(dast_url)
            if requested:
                if module == "sbom":
                    return "sbom" in requested or "sca" in requested
                return module in requested
            if scan_type == "sast":
                return module == "sast"
            if scan_type == "sca":
                return module in ("sca", "sbom")
            return True

        async def emit_module(module: str, status: str, **extra) -> None:
            record = {"id": module, "status": status, **extra}
            module_records[module] = record
            await self._send_module(module, status, **extra)

        for module_id in PIPELINE_MODULES:
            await emit_module(module_id, "QUEUED")

        targets = {"iac": False, "container": False, "kubernetes": False, "cicd": False, "api": False}
        needs_detection = any(wants(name) for name in ("iac", "containers", "kubernetes", "cicd", "api"))
        if needs_detection:
            await self._send_message("info", "Detecting infrastructure, API, and workflow files...")
            detected = await self._run_step(lambda: detect_scan_targets(p_id))
            if isinstance(detected, dict):
                targets = {
                    "iac": bool(detected.get("iac")),
                    "container": bool(detected.get("container")),
                    "kubernetes": bool(detected.get("kubernetes")),
                    "cicd": bool(detected.get("cicd")),
                    "api": bool(detected.get("api")),
                }

        async def sast_branch() -> tuple[bool, str, str]:
            await emit_module("sast", "RUNNING")
            await self._send_message("info", "Starting static code analysis (large repos may take 10-30+ minutes)...")
            success, error_msg = await self._run_step(lambda: run_bearer_scan(p_name, p_id))
            if success:
                await emit_module("sast", "COMPLETED")
                await self._send_message("success", "Static code analysis completed")
                return (True, "", "sast")
            await emit_module("sast", "FAILED", error="Static code analysis failed.")
            await self._send_message("error", f"Static code analysis failed: {error_msg}")
            return (False, error_msg, "sast")

        async def sca_branch() -> tuple[bool, str, str]:
            await emit_module("sbom", "RUNNING")
            await self._send_message("info", "Generating software bill of materials and scanning dependencies...")
            success, error_msg = await self._run_step(lambda: run_syft_scan(p_name, p_id))
            if not success:
                await emit_module("sbom", "FAILED", error="Software bill of materials could not be generated.")
                await emit_module("sca", "FAILED", error="Dependency scanning requires an SBOM.")
                await self._send_message("error", f"SBOM generation failed: {error_msg}")
                return (False, error_msg, "sca")
            await emit_module("sbom", "COMPLETED")
            if not wants("sca"):
                await emit_module("sca", "SKIPPED", reason="Not selected for this run.")
                return (True, "", "sca")
            await emit_module("sca", "RUNNING")
            success, error_msg = await self._run_step(lambda: run_grype_scan(p_name, p_id))
            if success:
                await emit_module("sca", "COMPLETED")
                await self._send_message("success", "Dependency scanning completed")
                return (True, "", "sca")
            await emit_module("sca", "FAILED", error="Dependency scanning failed.")
            await self._send_message("error", f"Dependency scanning failed: {error_msg}")
            return (False, error_msg, "sca")

        async def policy_branch(module: str, label: str, runner) -> tuple[bool, str, str]:
            await emit_module(module, "RUNNING")
            await self._send_message("info", f"Starting {label}...")
            success, error_msg = await self._run_step(lambda: runner(p_name, p_id))
            if success:
                await emit_module(module, "COMPLETED")
                await self._send_message("success", f"{label[0].upper() + label[1:]} completed")
                return (True, "", module)
            await emit_module(module, "FAILED", error=f"{label[0].upper() + label[1:]} failed. Other modules continued.")
            await self._send_message("error", f"{label[0].upper() + label[1:]} failed. Other modules continued.")
            return (True, error_msg, module)

        async def secrets_branch() -> tuple[bool, str, str]:
            return await policy_branch("secrets", "secret scanning", run_secrets_scan)

        async def iac_branch() -> tuple[bool, str, str]:
            return await policy_branch("iac", "infrastructure-as-code scanning", run_iac_scan)

        async def containers_branch() -> tuple[bool, str, str]:
            return await policy_branch("containers", "container configuration scanning", run_container_scan)

        async def kubernetes_branch() -> tuple[bool, str, str]:
            return await policy_branch("kubernetes", "Kubernetes scanning", run_kubernetes_scan)

        async def cicd_branch() -> tuple[bool, str, str]:
            return await policy_branch("cicd", "CI/CD scanning", run_cicd_scan)

        async def api_branch() -> tuple[bool, str, str]:
            return await policy_branch("api", "API specification scanning", run_api_scan)

        async def dast_branch() -> tuple[bool, str, str]:
            await emit_module("dast", "RUNNING")
            await self._send_message("info", "Starting dynamic application testing against the authorized target...")
            success, error_msg = await self._run_step(lambda: run_dast_scan(
                p_name,
                p_id,
                str(dast_url),
                context=self.scan_context,
                cancelled_check=lambda: self._cancelled,
            ))
            if success:
                await emit_module("dast", "COMPLETED")
                await self._send_message("success", "Dynamic testing completed")
                return (True, "", "dast")
            await emit_module(
                "dast",
                "FAILED",
                error=error_msg or "Dynamic testing failed. Other modules continued.",
            )
            await self._send_message("error", f"Dynamic testing failed. Other modules continued. {error_msg}")
            return (True, error_msg, "dast")

        skip_reasons = {
            "sast": "Not selected for this run.",
            "sca": "Not selected for this run.",
            "sbom": "Not selected for this run.",
            "secrets": "Not selected for this run.",
            "iac": "No supported infrastructure files detected.",
            "containers": "No container definition files detected.",
            "kubernetes": "No Kubernetes manifests detected.",
            "cicd": "No CI/CD workflow files detected.",
            "api": "No API specification files detected.",
            "dast": "Configure an authorized target URL to enable dynamic testing.",
            "cloud": "Run Cloud after this project is deployed. Open the Cloud tab.",
        }

        tasks = []
        if wants("sast"):
            tasks.append(sast_branch())
        else:
            await emit_module("sast", "SKIPPED", reason=skip_reasons["sast"])

        if wants("sca") or wants("sbom"):
            tasks.append(sca_branch())
        else:
            await emit_module("sbom", "SKIPPED", reason=skip_reasons["sbom"])
            await emit_module("sca", "SKIPPED", reason=skip_reasons["sca"])

        if wants("secrets"):
            tasks.append(secrets_branch())
        else:
            await emit_module("secrets", "SKIPPED", reason=skip_reasons["secrets"])

        checkov_jobs = []
        if wants("iac") and targets["iac"]:
            checkov_jobs.append(("iac", iac_branch))
        elif wants("iac"):
            await emit_module("iac", "SKIPPED", reason=skip_reasons["iac"])
        else:
            await emit_module("iac", "SKIPPED", reason="Not selected for this run.")

        if wants("containers") and targets["container"]:
            checkov_jobs.append(("containers", containers_branch))
        elif wants("containers"):
            await emit_module("containers", "SKIPPED", reason=skip_reasons["containers"])
        else:
            await emit_module("containers", "SKIPPED", reason="Not selected for this run.")

        if wants("kubernetes") and targets["kubernetes"]:
            checkov_jobs.append(("kubernetes", kubernetes_branch))
        elif wants("kubernetes"):
            await emit_module("kubernetes", "SKIPPED", reason=skip_reasons["kubernetes"])
        else:
            await emit_module("kubernetes", "SKIPPED", reason="Not selected for this run.")

        if wants("cicd") and targets["cicd"]:
            checkov_jobs.append(("cicd", cicd_branch))
        elif wants("cicd"):
            await emit_module("cicd", "SKIPPED", reason=skip_reasons["cicd"])
        else:
            await emit_module("cicd", "SKIPPED", reason="Not selected for this run.")

        if wants("api") and targets["api"]:
            checkov_jobs.append(("api", api_branch))
        elif wants("api"):
            await emit_module("api", "SKIPPED", reason=skip_reasons["api"])
        else:
            await emit_module("api", "SKIPPED", reason="Not selected for this run.")

        if checkov_jobs:
            image_ok, image_error = await self._run_step(lambda: self._ensure_image(CHECKOV_IMAGE))
            if not image_ok:
                reason = "Infrastructure scanner image could not be prepared."
                for module_id, _ in checkov_jobs:
                    await emit_module(module_id, "FAILED", error=reason)
                await self._send_message("error", f"{reason} {image_error}")
            else:
                for _, branch in checkov_jobs:
                    tasks.append(branch())

        if wants("dast") and dast_url:
            image_ok, image_error = await self._run_step(lambda: self._ensure_image(ZAP_IMAGE))
            if not image_ok:
                await emit_module("dast", "FAILED", error="Dynamic testing image could not be prepared.")
                await self._send_message("error", f"Dynamic testing image could not be prepared. {image_error}")
            else:
                tasks.append(dast_branch())
        elif wants("dast"):
            await emit_module("dast", "SKIPPED", reason=skip_reasons["dast"])
        else:
            await emit_module("dast", "SKIPPED", reason=skip_reasons["dast"])

        await emit_module("cloud", "SKIPPED", reason=skip_reasons["cloud"])

        async def heartbeat(interval: int = 30):
            elapsed = 0
            while True:
                await asyncio.sleep(interval)
                elapsed += interval
                await self._send_message("info", f"Scanners still running... ({elapsed}s elapsed)")

        hb_task = asyncio.create_task(heartbeat())
        try:
            results = await asyncio.gather(*tasks) if tasks else []
        finally:
            hb_task.cancel()
            try:
                await hb_task
            except asyncio.CancelledError:
                pass

        await self._run_step(lambda: self._write_pipeline_summary(list(module_records.values())))

        blocking_failed = any(
            (not success) and name in ("sast", "sca")
            for success, _, name in results
        )
        if blocking_failed:
            await self._send_status(StreamStatus.error)
            return False

        return True

