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
    cloud_credentials_present,
    is_cloud_only_run,
    run_cloud_scan,
)
from sdlc_pipeline import SDLC_PHASES, TOOLS, engine_for, phase_for, validate_report
from scanner_runtime import execution_evidence
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
    read_volume_file,
)
import json


def scanner_log_callback(loop: asyncio.AbstractEventLoop, send_message, phase_label: str):
    """Return a scanner callback safe to invoke from Docker worker threads."""
    def on_log(message: str) -> None:
        text = message if message.startswith("[") else f"[{phase_label}] {message}"
        try:
            asyncio.run_coroutine_threadsafe(send_message("info", text), loop)
        except Exception:
            # Scanner output must never abort the underlying scanner process.
            pass

    return on_log

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
        self.run_id = getattr(websocket, "run_id", None)
        self.source_revision = scan_context.source_revision

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

            try:
                if self.scan_context.source_revision:
                    for command in (["-C", f"/repo/{project_id}", "fetch", "--depth", "1", "origin", self.scan_context.source_revision],
                                    ["-C", f"/repo/{project_id}", "checkout", "--detach", self.scan_context.source_revision]):
                        self._docker.containers.run("alpine/git", entrypoint="git", command=command,
                            volumes={CODEBASE_VOLUME: {"bind": "/repo", "mode": "rw"}}, remove=True)
                self.source_revision = decode_output(self._docker.containers.run("alpine/git", entrypoint="git",
                    command=["-C", f"/repo/{project_id}", "rev-parse", "HEAD"],
                    volumes={CODEBASE_VOLUME: {"bind": "/repo", "mode": "ro"}}, remove=True)).strip()
            finally:
                # Cleanup also runs when revision fetching or checkout fails.
                self._docker.containers.run(
                    "alpine/git", entrypoint="git",
                    command=["-C", f"/repo/{project_id}", "remote", "set-url", "origin", repo_url],
                    volumes={CODEBASE_VOLUME: {"bind": "/repo", "mode": "rw"}}, remove=True)

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
                "run_id": self.run_id,
                "project_id": self.scan_context.project_id,
                "source_revision": self.source_revision,
                "trigger": self.scan_context.trigger,
                "artifact_digest": self.scan_context.artifact_digest,
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
            result = container.wait(timeout=CONTAINER_OP_TIMEOUT)
            container.remove(force=True)
            if result.get("StatusCode") != 0:
                return False, "Cannot persist scan summary"
            if self.run_id:
                self._docker.containers.run("alpine", command=["sh", "-ec",
                    'if [ -d "/code/$PID" ] && [ ! -d "/code/scan_$RUN" ]; then mkdir "/code/scan_$RUN"; cp -a "/code/$PID/." "/code/scan_$RUN/"; fi'],
                    environment={"RUN": self.run_id, "PID": self.scan_context.project_id},
                    volumes={CODEBASE_VOLUME: {"bind": "/code", "mode": "rw"}}, remove=True)
                self._docker.containers.run("alpine", command=["sh", "-c",
                    'mkdir -p "/vol/history/$RUN" && for file in /vol/*_${PID}_*.json; do [ ! -f "$file" ] || cp "$file" "/vol/history/$RUN/"; done'],
                    environment={"RUN": self.run_id, "PID": self.scan_context.project_id},
                    volumes={SECURITY_REPORTS_VOLUME: {"bind": "/vol", "mode": "rw"}}, remove=True)
            return (True, "")
        except Exception as exc:
            return (False, str(exc))

    def _validated_report(self, module: str) -> dict:
        filename = f"{sanitize_name(self.scan_context.project_name)}_{self.scan_context.project_id}_{TOOLS[module].report_suffix}"
        result = validate_report(module, read_volume_file(filename))
        return {**result, "report_ref": filename}

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

        engine = engine_for(module_id)
        phase_id, phase_label = phase_for(module_id)
        await self._send_module(module_id, "RUNNING", engine=engine, phase=phase_id)
        await self._send_message("info", f"[{phase_label or 'scan'}] {engine}: starting {label}...")
        evidence = {}
        token = execution_evidence.set(evidence)
        try:
            success, error_msg = await self._run_step(runner)
        finally:
            execution_evidence.reset(token)
        report = {}
        if success:
            try:
                report = await self._run_step(lambda: self._validated_report(module_id))
            except Exception as exc:
                success, error_msg = False, str(exc)
        if success:
            status = "SKIPPED" if report.get("coverage") == "not_applicable" else "COMPLETED"
            record = {**report, **evidence, "id": module_id, "status": status, "engine": engine, "phase": phase_id}
            await self._send_module(module_id, status, engine=engine, phase=phase_id, **report, **evidence)
            await self._send_message("info", f"[{phase_label or 'scan'}] {engine}: {status.lower()}")
        else:
            record = {
                "id": module_id,
                "status": "FAILED",
                "engine": engine,
                "phase": phase_id,
                "error": error_msg or f"{engine} failed.",
            }
            await self._send_module(module_id, "FAILED", engine=engine, phase=phase_id, error=record["error"])
            await self._send_message("error", f"[{phase_label or 'scan'}] {engine}: failed. {error_msg}")

        summary_ok, _ = await self._run_step(lambda: self._write_pipeline_summary([record]))
        return success and summary_ok

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
        if self.scan_context.generated_files:
            def write_generated():
                import io
                import tarfile
                # Reject symlink destinations before Docker extracts the archive.
                # Generated artifacts must never follow repository-controlled links.
                self._docker.containers.run("alpine", entrypoint="sh",
                    command=["-ec", 'root="$1"; shift; test ! -L "$root"; for item do current="$root"; oldifs="$IFS"; IFS=/; for part in $item; do current="$current/$part"; test ! -L "$current" || exit 1; done; IFS="$oldifs"; done',
                        "guard", f"/repo/{self.scan_context.project_id}", *[item.path for item in self.scan_context.generated_files]],
                    volumes={CODEBASE_VOLUME: {"bind": "/repo", "mode": "ro"}}, remove=True)
                data = io.BytesIO()
                with tarfile.open(fileobj=data, mode="w") as archive:
                    for item in self.scan_context.generated_files:
                        raw = item.content.encode()
                        entry = tarfile.TarInfo(item.path)
                        entry.size = len(raw)
                        archive.addfile(entry, io.BytesIO(raw))
                worker = self._docker.containers.create("alpine", command=["true"],
                    volumes={CODEBASE_VOLUME: {"bind": "/repo", "mode": "rw"}})
                try:
                    if not worker.put_archive(f"/repo/{self.scan_context.project_id}", data.getvalue()):
                        raise RuntimeError("Generated scan files could not be staged")
                finally:
                    worker.remove(force=True)
            await self._run_step(write_generated)

        self._check_cancelled()
        await self._send_message("phase", "Executing security tools across SDLC stages")

        p_name = self.scan_context.project_name
        p_id = self.scan_context.project_id
        scan_type = getattr(self.scan_context, "scan_type", "all")
        requested = getattr(self.scan_context, "enabled_modules", None) or None
        dast_url = getattr(self.scan_context, "dast_target_url", None)
        aws_key = getattr(self.scan_context, "aws_access_key_id", None)
        aws_secret = getattr(self.scan_context, "aws_secret_access_key", None)
        cloud_ready = cloud_credentials_present(aws_key, aws_secret)
        module_records: dict[str, dict] = {}
        running_engines: set[str] = set()

        def wants(module: str) -> bool:
            if module == "cloud":
                if requested:
                    return "cloud" in requested and cloud_ready
                return False
            if module == "dast":
                if requested is not None and "dast" not in requested:
                    return False
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

        # Scanner adapters run in executor threads. Capture the event loop here,
        # before entering those threads, so an adapter log cannot raise
        # "no running event loop" and abort the scan.
        scan_loop = asyncio.get_running_loop()

        def make_log(phase_label: str, engine: str):
            del engine  # The adapter includes its engine name in emitted output.
            return scanner_log_callback(scan_loop, self._send_message, phase_label)

        async def emit_module(module: str, status: str, **extra) -> None:
            engine = extra.get("engine") or engine_for(module)
            phase_id, _ = phase_for(module)
            record = {**module_records.get(module, {}), "id": module, "status": status, "engine": engine, "phase": phase_id, **extra}
            module_records[module] = record
            await self._send_module(module, status, engine=engine, phase=phase_id, **{
                k: v for k, v in extra.items() if k not in {"engine", "phase"}
            })

        for module_id in PIPELINE_MODULES:
            await emit_module(module_id, "QUEUED")

        # Detection is informational only — selected Checkov modules always run.
        if any(wants(name) for name in ("iac", "containers", "kubernetes", "cicd", "api")):
            await self._send_message("info", "Detecting infrastructure, API, and workflow files (informational)...")
            detected = await self._run_step(lambda: detect_scan_targets(p_id))
            if isinstance(detected, dict):
                bits = [
                    f"{key}={'yes' if detected.get(key) else 'no'}"
                    for key in ("iac", "container", "kubernetes", "cicd", "api")
                ]
                await self._send_message("info", f"Target detection: {', '.join(bits)}")

        slots = asyncio.Semaphore(max(1, int(os.getenv("SECURITY_SCAN_CONCURRENCY", "3"))))

        async def run_named(module, phase_label, runner, *, blocking=False):
            engine = engine_for(module)
            async with slots:
                await emit_module(module, "STARTING", started_at=datetime.now(timezone.utc).isoformat())
                try:
                    image_ok, image_error = await self._run_step(lambda: self._ensure_image(TOOLS[module].image))
                    if not image_ok:
                        raise RuntimeError(image_error)
                    # RUNNING means an adapter is executing; container lifecycle is separate evidence.
                    await emit_module(module, "RUNNING")
                    running_engines.add(engine)
                    evidence = {}
                    token = execution_evidence.set(evidence)
                    try:
                        success, error_msg = await self._run_step(runner)
                    finally:
                        execution_evidence.reset(token)
                    await emit_module(module, "RUNNING", **evidence)
                    if not success:
                        raise RuntimeError(error_msg or f"{engine} failed")
                    report = await self._run_step(lambda: self._validated_report(module))
                    status = "SKIPPED" if report["coverage"] == "not_applicable" else "COMPLETED"
                    await emit_module(module, status, **report,
                        reason="No applicable targets were checked." if status == "SKIPPED" else None,
                        finished_at=datetime.now(timezone.utc).isoformat())
                    await self._send_message("info", f"[{phase_label}] {engine}: report validated ({report['coverage']})")
                    return (True, "", module)
                except Exception as exc:
                    error = str(exc)
                    await emit_module(module, "FAILED", error=error, finished_at=datetime.now(timezone.utc).isoformat())
                    await self._send_message("error", f"[{phase_label}] {engine}: {error}. Independent tools continue.")
                    return (False, error, module)
                finally:
                    running_engines.discard(engine)

        async def sast_branch(phase_label: str) -> tuple[bool, str, str]:
            return await run_named(
                "sast",
                phase_label,
                lambda: run_bearer_scan(p_name, p_id, on_log=make_log(phase_label, "Bearer")),
                blocking=True,
            )

        async def secrets_branch(phase_label: str) -> tuple[bool, str, str]:
            return await run_named(
                "secrets",
                phase_label,
                lambda: run_secrets_scan(p_name, p_id, on_log=make_log(phase_label, "Gitleaks")),
            )

        async def sca_branch(phase_label: str) -> tuple[bool, str, str]:
            success, error, _ = await run_named("sbom", phase_label,
                lambda: run_syft_scan(p_name, p_id, on_log=make_log(phase_label, "Syft")))
            if not success:
                await emit_module("sca", "SKIPPED", coverage="blocked", reason="Dependency blocked: Syft did not produce a valid SBOM.")
                return (False, error, "sca")
            if not wants("sca"):
                await emit_module("sca", "SKIPPED", reason="Not selected for this run.")
                return (True, "", "sca")
            result = await run_named("sca", phase_label,
                lambda: run_grype_scan(p_name, p_id, on_log=make_log(phase_label, "Grype")))
            if self.scan_context.artifact_digest:
                try:
                    await self._send_message("info", "Build artifact: executing Syft then Grype against the supplied image digest.")
                    for module, suffix, operation in (
                        ("sbom", "ImageSbom.json", lambda: run_syft_scan(p_name, p_id,
                            on_log=make_log("Build image", "Syft"), target_source="registry:" + self.scan_context.artifact_digest,
                            report_suffix="ImageSbom.json")),
                        ("sca", "ImageGrype.json", lambda: run_grype_scan(p_name, p_id,
                            on_log=make_log("Build image", "Grype"), sbom_suffix="ImageSbom.json", report_suffix="ImageGrype.json")),
                    ):
                        success, error = await self._run_step(operation)
                        if not success:
                            raise RuntimeError(error)
                        await self._run_step(lambda: validate_report(module, read_volume_file(f"{sanitize_name(p_name)}_{p_id}_{suffix}")))
                    await emit_module("sca", "COMPLETED" if result[0] else "FAILED", artifact_digest=self.scan_context.artifact_digest,
                        artifact_report_ref=f"{sanitize_name(p_name)}_{p_id}_ImageGrype.json")
                except Exception as exc:
                    await emit_module("sca", "FAILED", error=f"Built image coverage incomplete: {exc}")
                    return False, str(exc), "sca"
            return result

        async def containers_branch(phase_label: str) -> tuple[bool, str, str]:
            return await run_named(
                "containers",
                phase_label,
                lambda: run_container_scan(p_name, p_id, on_log=make_log(phase_label, "Checkov Containers")),
            )

        async def iac_branch(phase_label: str) -> tuple[bool, str, str]:
            return await run_named(
                "iac",
                phase_label,
                lambda: run_iac_scan(p_name, p_id, on_log=make_log(phase_label, "Checkov IaC")),
            )

        async def kubernetes_branch(phase_label: str) -> tuple[bool, str, str]:
            return await run_named(
                "kubernetes",
                phase_label,
                lambda: run_kubernetes_scan(p_name, p_id, on_log=make_log(phase_label, "Checkov Kubernetes")),
            )

        async def cicd_branch(phase_label: str) -> tuple[bool, str, str]:
            return await run_named(
                "cicd",
                phase_label,
                lambda: run_cicd_scan(p_name, p_id, on_log=make_log(phase_label, "Checkov CI/CD")),
            )

        async def api_branch(phase_label: str) -> tuple[bool, str, str]:
            return await run_named(
                "api",
                phase_label,
                lambda: run_api_scan(p_name, p_id, on_log=make_log(phase_label, "Checkov API")),
            )

        async def dast_branch(phase_label: str) -> tuple[bool, str, str]:
            return await run_named(
                "dast",
                phase_label,
                lambda: run_dast_scan(
                    p_name,
                    p_id,
                    str(dast_url),
                    context=self.scan_context,
                    cancelled_check=lambda: self._cancelled,
                ),
            )

        async def cloud_branch(phase_label: str) -> tuple[bool, str, str]:
            return await run_named(
                "cloud",
                phase_label,
                lambda: run_cloud_scan(
                    p_name,
                    p_id,
                    str(aws_key or ""),
                    str(aws_secret or ""),
                    str(getattr(self.scan_context, "aws_session_token", "") or "") or None,
                    str(getattr(self.scan_context, "aws_region", "") or "eu-north-1"),
                    on_log=make_log(phase_label, "Prowler"),
                ),
            )

        branch_builders = {
            "sast": sast_branch,
            "secrets": secrets_branch,
            "sca": sca_branch,
            "sbom": None,  # handled with sca
            "containers": containers_branch,
            "iac": iac_branch,
            "kubernetes": kubernetes_branch,
            "cicd": cicd_branch,
            "api": api_branch,
            "dast": dast_branch,
            "cloud": cloud_branch,
        }

        results: list[tuple[bool, str, str]] = []
        checkov_image_ready: bool | None = None

        for phase_id, phase_label, modules in SDLC_PHASES:
            phase_tasks = []
            await self._send_message("phase", f"SDLC · {phase_label}")

            for module in modules:
                if module == "sbom":
                    continue
                if module == "sca":
                    if wants("sca") or wants("sbom"):
                        phase_tasks.append(sca_branch(phase_label))
                    else:
                        await emit_module("sbom", "SKIPPED", reason="Not selected for this run.")
                        await emit_module("sca", "SKIPPED", reason="Not selected for this run.")
                    continue

                if not wants(module):
                    if module == "dast":
                        reason = "Configure an authorized target URL to enable dynamic testing."
                    elif module == "cloud":
                        reason = (
                            "AWS credentials required for live cloud scanning."
                            if not cloud_ready
                            else "Not selected for this run."
                        )
                    else:
                        reason = "Not selected for this run."
                    await emit_module(module, "SKIPPED", reason=reason)
                    continue

                if module == "dast":
                    if not dast_url:
                        await emit_module(
                            "dast",
                            "SKIPPED",
                            reason="Configure an authorized target URL to enable dynamic testing.",
                        )
                        continue
                    image_ok, image_error = await self._run_step(lambda: self._ensure_image(ZAP_IMAGE))
                    if not image_ok:
                        await emit_module("dast", "FAILED", error="Dynamic testing image could not be prepared.")
                        await self._send_message(
                            "error",
                            f"[{phase_label}] OWASP ZAP: image could not be prepared. {image_error}",
                        )
                        continue
                    phase_tasks.append(dast_branch(phase_label))
                    continue

                if module == "cloud":
                    if not cloud_ready:
                        await emit_module(
                            "cloud",
                            "SKIPPED",
                            reason="AWS credentials required for live cloud scanning.",
                        )
                        continue
                    image_ok, image_error = await self._run_step(lambda: self._ensure_image(PROWLER_IMAGE))
                    if not image_ok:
                        await emit_module("cloud", "FAILED", error="Cloud scanner image could not be prepared.")
                        await self._send_message(
                            "error",
                            f"[{phase_label}] Prowler: image could not be prepared. {image_error}",
                        )
                        continue
                    phase_tasks.append(cloud_branch(phase_label))
                    continue

                if module in ("iac", "containers", "kubernetes", "cicd", "api"):
                    if checkov_image_ready is None:
                        image_ok, image_error = await self._run_step(lambda: self._ensure_image(CHECKOV_IMAGE))
                        checkov_image_ready = image_ok
                        if not image_ok:
                            await self._send_message(
                                "error",
                                f"[{phase_label}] Checkov: image could not be prepared. {image_error}",
                            )
                    if not checkov_image_ready:
                        await emit_module(
                            module,
                            "FAILED",
                            error="Infrastructure scanner image could not be prepared.",
                        )
                        continue

                builder = branch_builders.get(module)
                if builder:
                    phase_tasks.append(builder(phase_label))

            if not phase_tasks:
                continue

            async def heartbeat(interval: int = 30):
                elapsed = 0
                while True:
                    await asyncio.sleep(interval)
                    elapsed += interval
                    engines = ", ".join(sorted(running_engines)) or "scanners"
                    await self._send_message(
                        "info",
                        f"Worker heartbeat [{phase_label}]: pending adapters {engines} ({elapsed}s elapsed)",
                    )

            hb_task = asyncio.create_task(heartbeat())
            try:
                phase_results = await asyncio.gather(*phase_tasks)
                results.extend(phase_results)
            finally:
                hb_task.cancel()
                try:
                    await hb_task
                except asyncio.CancelledError:
                    pass


        summary_ok, _ = await self._run_step(lambda: self._write_pipeline_summary(list(module_records.values())))
        return summary_ok and not any(r["status"] == "FAILED" for r in module_records.values())

