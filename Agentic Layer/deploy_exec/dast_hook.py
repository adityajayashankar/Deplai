"""Optional post-deployment DAST handoff. Does not replace the DAST agent."""

from __future__ import annotations

import os
import threading
from typing import Any, Callable

from deploy_exec import store


def should_trigger(environment_id: str, policy: dict[str, Any] | None) -> bool:
    env = str(environment_id or "").strip().lower()
    if env not in {"staging", "stage"}:
        return False
    if not policy:
        return True
    return bool(policy.get("dast_after_staging", True))


def context_payload(
    *,
    project_id: str,
    deployment_id: str,
    environment_id: str,
    deployed_url: str,
    authorization: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "project_id": project_id,
        "deployment_id": deployment_id,
        "environment_id": environment_id,
        "deployed_url": deployed_url,
        "authorization": authorization or {},
    }


def maybe_start(
    context: dict[str, Any],
    *,
    enabled: bool | None = None,
    runner: Callable[..., tuple[bool, str]] | None = None,
) -> dict[str, Any]:
    """Start authorized DAST against the deployed URL. Never blocks deployment success."""
    env_on = str(os.getenv("DEPLOY_EXEC_TRIGGER_DAST") or "1").strip().lower() not in {"0", "false", "no"}
    if enabled is False or (enabled is None and not env_on):
        return {"started": False, "reason": "disabled"}
    if not should_trigger(str(context.get("environment_id") or ""), {"dast_after_staging": True}):
        return {"started": False, "reason": "policy"}
    url = str(context.get("deployed_url") or "").strip()
    if not url:
        return {"started": False, "reason": "no_url"}
    grant = context.get("authorization") if isinstance(context.get("authorization"), dict) else {}
    if not grant:
        return {"started": False, "reason": "no_authorization"}

    deployment_id = str(context.get("deployment_id") or "")
    project_id = str(context.get("project_id") or "")

    def _run() -> None:
        try:
            execute = runner
            if execute is None:
                from dast_agent.service import execute_dast_scan

                execute = execute_dast_scan
            ctx = type("Ctx", (), {
                "project_id": project_id,
                "project_name": project_id,
                "user_id": "",
                "dast_authorization": grant,
                "dast_scan_id": "",
                "dast_scan_profile": "BASELINE",
                "dast_scan_intent": "PASSIVE",
                "dast_api_spec_url": "",
            })()
            ok, detail = execute(project_id, project_id, url, context=ctx)
            store.append_event(deployment_id, {
                "event": "POST_DEPLOYMENT_DAST_COMPLETED" if ok else "POST_DEPLOYMENT_DAST_FAILED",
                "ok": ok,
                "detail": str(detail or "")[:300],
            })
        except Exception as exc:
            store.append_event(deployment_id, {
                "event": "POST_DEPLOYMENT_DAST_FAILED",
                "ok": False,
                "detail": str(exc)[:300],
            })

    store.append_event(deployment_id, {
        "event": "POST_DEPLOYMENT_DAST_STARTED",
        "deployed_url": url,
        "project_id": project_id,
        "environment_id": context.get("environment_id"),
        "deployment_id": deployment_id,
    })
    thread = threading.Thread(target=_run, daemon=True, name=f"deploy-dast-{deployment_id[:8] or 'x'}")
    thread.start()
    return {"started": True, "reason": "started"}
