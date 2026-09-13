"""Public DAST agent entrypoint used by the existing scan pipeline."""

from __future__ import annotations

import json
import os
import uuid
from typing import Any
from urllib import error, request

from dast_agent import store
from dast_agent.authorization import authorize_target
from dast_agent.codes import DAST_TARGET_NOT_AUTHORIZED, USER_NOT_AUTHORIZED
from dast_agent.graph import get_dast_graph
from dast_agent.nodes import _SCANNERS
from dast_agent.state import DASTAgentState


def _settle_successful_dast_usage(context: Any, state: DASTAgentState) -> None:
    """DAST has its own successful-run rate, independent of the base scan."""
    organization_id = str(getattr(context, "organization_id", "") or "").strip()
    scan_id = str(state.get("scan_id") or "").strip()
    if not organization_id or not scan_id:
        return
    try:
        from product_usage import settle_product_usage

        result = settle_product_usage(
            kind="dast",
            outcome="succeeded",
            organization_id=organization_id,
            user_id=str(getattr(context, "user_id", "") or "").strip() or None,
            project_id=str(state.get("project_id") or "").strip() or None,
            run_id=scan_id,
        )
        store.write_checkpoint(scan_id, "usage_settlement", {
            "settled": bool(result.get("ok")),
            "credits": result.get("credits") if result.get("ok") else None,
            "reason": result.get("reason") if result.get("ok") else result.get("error"),
        })
    except Exception as exc:
        # Metering has a durable idempotency key. Preserve the successful ZAP
        # result and expose that the ledger delivery needs reconciliation.
        store.write_checkpoint(scan_id, "usage_settlement", {
            "settled": False,
            "reason": f"Billing settlement unavailable: {type(exc).__name__}.",
        })


def _connector_url() -> str:
    return (
        os.getenv("CONNECTOR_URL", "").strip()
        or os.getenv("NEXT_PUBLIC_APP_URL", "").strip()
    )


def _service_key() -> str:
    return os.getenv("DEPLAI_SERVICE_KEY", "").strip()


def fetch_live_asset(asset_id: str) -> dict[str, Any] | None:
    asset_id = str(asset_id or "").strip()
    base = _connector_url().rstrip("/")
    if not asset_id or not base:
        return None
    url = f"{base}/api/dast/internal/assets/{asset_id}"
    headers = {"Accept": "application/json"}
    key = _service_key()
    if key:
        headers["X-API-Key"] = key
        headers["X-Deplai-Service-Key"] = key
    req = request.Request(url, headers=headers, method="GET")
    try:
        with request.urlopen(req, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    asset = payload.get("asset") if isinstance(payload.get("asset"), dict) else payload
    return asset if isinstance(asset, dict) else None


def initial_state_from_context(context: Any, target_url: str) -> DASTAgentState:
    grant = getattr(context, "dast_authorization", None)
    if hasattr(grant, "model_dump"):
        grant = grant.model_dump()
    grant = grant if isinstance(grant, dict) else None
    scan_id = str(getattr(context, "dast_scan_id", None) or uuid.uuid4())
    live = None
    asset_id = str((grant or {}).get("asset_id") or "")
    if asset_id:
        live = fetch_live_asset(asset_id)
    return {
        "scan_id": scan_id,
        "project_id": str(getattr(context, "project_id", "") or ""),
        "requested_by_user_id": str(getattr(context, "user_id", "") or ""),
        "project_name": str(getattr(context, "project_name", "") or ""),
        "target_url": str(target_url or ""),
        "grant": grant or {},
        "live_asset": live or {},
        "asset_id": asset_id,
        "scan_profile": str(getattr(context, "dast_scan_profile", None) or "BASELINE"),
        "scan_intent": str(getattr(context, "dast_scan_intent", None) or "PASSIVE"),
        "api_spec_url": str(getattr(context, "dast_api_spec_url", None) or ""),
        "retry_count": 0,
        "errors": [],
        "warnings": [],
        "audit_events": [],
        "findings": [],
    }


def execute_dast_scan(
    project_name: str,
    project_id: str,
    target_url: str,
    *,
    context: Any = None,
    cancelled_check: Any = None,
) -> tuple[bool, str]:
    """Run the LangGraph DAST agent. Returns pipeline (ok, error) tuple.

    ok=False means the module failed. Authorization blocks are failures with a
    policy code so the UI can distinguish them from scanner crashes.
    """
    if context is None:
        context = type("Ctx", (), {
            "project_id": project_id,
            "project_name": project_name,
            "user_id": "",
            "dast_authorization": None,
            "dast_scan_id": "",
            "dast_scan_profile": "BASELINE",
            "dast_scan_intent": "PASSIVE",
            "dast_api_spec_url": "",
        })()

    state = initial_state_from_context(context, target_url)
    # Fail closed before the graph if the request cannot possibly be authorized.
    pre = authorize_target(
        project_id=str(project_id),
        requested_target=str(target_url or ""),
        grant=state.get("grant"),
        live_asset=state.get("live_asset") or None,
    )
    if not pre.authorized:
        store.write_checkpoint(str(state.get("scan_id") or "unknown"), "authorization_verified", {
            "authorized": False,
            "code": pre.code,
        })
        return False, f"{pre.code}: {pre.message}"

    if not store.acquire_slot(str(project_id)):
        return False, "Another dynamic test is already running for this project."

    if cancelled_check:
        try:
            if cancelled_check():
                store.release_slot(str(project_id))
                return False, "cancelled"
        except Exception as exc:
            store.release_slot(str(project_id))
            return False, str(exc) or "cancelled"

    try:
        graph = get_dast_graph()
        final = graph.invoke(state, config={"configurable": {"thread_id": state["scan_id"]}})
    except Exception as exc:
        return False, str(exc)
    finally:
        store.release_slot(str(project_id))
        scanner = _SCANNERS.pop(str(state.get("scan_id") or ""), None)
        if scanner is not None:
            scanner.cleanup()

    status = str((final or {}).get("scan_status") or "")
    if status == "completed":
        _settle_successful_dast_usage(context, state)
        return True, ""
    errors = list((final or {}).get("errors") or [])
    code = str((final or {}).get("authorization_code") or "")
    if status == "blocked":
        detail = errors[-1] if errors else f"{code or DAST_TARGET_NOT_AUTHORIZED}: {USER_NOT_AUTHORIZED}"
        return False, detail
    if status == "cancelled":
        return False, "cancelled"
    if errors:
        return False, str(errors[-1])
    return False, status or "Dynamic testing failed."


def cancel_scan(scan_id: str) -> None:
    store.request_cancel(scan_id)
    scanner = _SCANNERS.get(str(scan_id))
    if scanner is not None:
        scanner.stop()
