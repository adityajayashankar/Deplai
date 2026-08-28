"""OWASP ZAP scanner adapter. Isolated Docker worker, never in-process."""

from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Protocol

from dast_agent.codes import PROFILE_API, PROFILE_BASELINE, PROFILE_FULL
from dast_agent.scope import DastScope
from dast_agent.zap_plan import render_zap_plan
from utils import decode_output, get_docker_client, sanitize_name, SECURITY_REPORTS_VOLUME

ZAP_IMAGE = os.getenv("ZAP_IMAGE", "zaproxy/zap-stable:2.16.1")
SCANNER_TIMEOUT_SECONDS = int(os.getenv("DAST_TIMEOUT_SECONDS", os.getenv("SCANNER_TIMEOUT_SECONDS", "900")))
DAST_SPIDER_MINUTES = int(os.getenv("DAST_SPIDER_MINUTES", "5"))
ZAP_MEM_LIMIT = os.getenv("DAST_ZAP_MEM_LIMIT", "2g")
ZAP_CPUS = float(os.getenv("DAST_ZAP_CPUS", "2"))


class DastScanner(Protocol):
    def prepare(self) -> None: ...
    def validate(self) -> tuple[bool, str]: ...
    def start(self) -> tuple[bool, str]: ...
    def status(self) -> str: ...
    def stop(self) -> None: ...
    def collect_results(self) -> tuple[bool, str]: ...
    def cleanup(self) -> None: ...


class ZapScanner:
    def __init__(
        self,
        *,
        project_name: str,
        project_id: str,
        target_url: str,
        profile: str,
        scope: DastScope,
        api_spec_url: str | None = None,
        cancelled: Callable[[], bool] | None = None,
    ) -> None:
        self.project_name = project_name
        self.project_id = project_id
        self.target_url = target_url
        self.profile = str(profile or PROFILE_BASELINE).upper()
        self.scope = scope
        self.api_spec_url = api_spec_url
        self.cancelled = cancelled
        self.container = None
        self.container_id = ""
        self.plan_path: str | None = None
        self.report_filename = f"{sanitize_name(project_name)}_{project_id}_Dast.json"
        self._status = "pending"
        self.image_tag = ZAP_IMAGE

    def prepare(self) -> None:
        plan = render_zap_plan(
            target_url=self.target_url,
            report_filename=self.report_filename,
            profile=self.profile,
            scope=self.scope,
            api_spec_url=self.api_spec_url,
            spider_minutes=DAST_SPIDER_MINUTES,
        )
        handle = tempfile.NamedTemporaryFile(delete=False, suffix=".yaml", prefix="deplai-dast-")
        handle.write(plan.encode("utf-8"))
        handle.close()
        self.plan_path = handle.name

    def validate(self) -> tuple[bool, str]:
        if self.profile == PROFILE_FULL and os.getenv("DAST_ALLOW_ACTIVE", "true").strip().lower() not in {"1", "true", "yes", "on"}:
            return False, "Active DAST is disabled."
        if self.profile == PROFILE_API and not (self.api_spec_url or self.target_url):
            return False, "API DAST requires an OpenAPI or target URL in scope."
        if not self.plan_path or not Path(self.plan_path).is_file():
            return False, "ZAP plan was not prepared."
        return True, ""

    def start(self) -> tuple[bool, str]:
        if self.cancelled and self.cancelled():
            return False, "cancelled"
        self.prepare()
        ok, error = self.validate()
        if not ok:
            return False, error
        assert self.plan_path
        if self.profile == PROFILE_BASELINE:
            run_kwargs: dict[str, Any] = {
                "entrypoint": ["/zap/zap-baseline.py"],
                "command": [
                    "-t", self.target_url.strip(),
                    "-J", self.report_filename,
                    "-I",
                    "-m", str(max(1, min(DAST_SPIDER_MINUTES, 15))),
                ],
            }
        else:
            run_kwargs = {
                "entrypoint": ["/zap/zap.sh"],
                "command": ["-cmd", "-autorun", "/zap/plan.yaml"],
            }
        run_kwargs.update({
            "user": "0:0",
            "environment": {"HOME": "/tmp", "ZAP_HOME": "/tmp/zap"},
            "working_dir": "/zap/wrk",
            "tty": True,
            "network_mode": "bridge",
            "privileged": False,
            "extra_hosts": {
                "metadata.google.internal": "0.0.0.0",
                "metadata.internal": "0.0.0.0",
                "metadata": "0.0.0.0",
                "kubernetes": "0.0.0.0",
                "kubernetes.default": "0.0.0.0",
            },
            "volumes": {
                SECURITY_REPORTS_VOLUME: {"bind": "/zap/wrk", "mode": "rw"},
                self.plan_path: {"bind": "/zap/plan.yaml", "mode": "ro"},
            },
            "detach": True,
            "mem_limit": ZAP_MEM_LIMIT,
            "nano_cpus": int(max(0.5, ZAP_CPUS) * 1_000_000_000),
        })
        try:
            self.container = get_docker_client().containers.run(ZAP_IMAGE, **run_kwargs)
        except Exception:
            # Older Docker engines may reject nano_cpus / mem_limit combinations.
            run_kwargs.pop("nano_cpus", None)
            try:
                self.container = get_docker_client().containers.run(ZAP_IMAGE, **run_kwargs)
            except Exception as exc:
                self._status = "failed"
                return False, str(exc)
        self.container_id = getattr(self.container, "id", "") or ""
        self._status = "running"
        return True, ""

    def status(self) -> str:
        return self._status

    def stop(self) -> None:
        if self.container is None:
            return
        try:
            self.container.kill()
        except Exception:
            pass
        self._status = "stopped"

    def collect_results(self) -> tuple[bool, str]:
        if self.container is None:
            return False, "Scanner container was not started."
        deadline = time.time() + SCANNER_TIMEOUT_SECONDS
        try:
            while time.time() < deadline:
                if self.cancelled and self.cancelled():
                    self.stop()
                    return False, "cancelled"
                self.container.reload()
                if self.container.status not in {"created", "running"}:
                    break
                time.sleep(2)
            else:
                self.stop()
                self._status = "timed_out"
                return False, "timed_out"
            result = self.container.wait(timeout=30)
            logs = decode_output(self.container.logs(stdout=True, stderr=True, tail=40))
            exit_code = result.get("StatusCode", -1)
            # 0 = success, 1/2 = alerts found depending on ZAP wrapper.
            if exit_code in (0, 1, 2):
                self._status = "completed"
                return True, ""
            self._status = "failed"
            detail = " ".join(logs.split())[:280]
            suffix = f": {detail}" if detail else ""
            return False, f"Dynamic testing exited with code {exit_code}{suffix}"
        except Exception as exc:
            self._status = "failed"
            return False, str(exc)

    def cleanup(self) -> None:
        if self.container is not None:
            try:
                self.container.remove(force=True)
            except Exception:
                pass
            self.container = None
        if self.plan_path:
            try:
                os.unlink(self.plan_path)
            except OSError:
                pass
            self.plan_path = None
