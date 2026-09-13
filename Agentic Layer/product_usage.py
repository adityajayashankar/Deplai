"""Idempotent product-usage settlement through the Connector credit ledger."""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any
from urllib import error, request


logger = logging.getLogger(__name__)


def _connector_url() -> str:
    return (
        os.getenv("DEPLAI_AI_GATEWAY_URL", "").strip()
        or os.getenv("CONNECTOR_URL", "").strip()
        or os.getenv("NEXT_PUBLIC_APP_URL", "").strip()
    ).rstrip("/")


def _service_key() -> str:
    return os.getenv("DEPLAI_SERVICE_KEY", "").strip()


def settle_product_usage(
    *,
    kind: str,
    outcome: str,
    organization_id: str | None,
    user_id: str | None,
    project_id: str | None,
    run_id: str | None,
    usage: dict[str, Any] | None = None,
    dast_only: bool = False,
) -> dict[str, Any]:
    """Settle one terminal run. Repeated delivery is safe by Connector key."""
    base = _connector_url()
    key = _service_key()
    organization = str(organization_id or "").strip()
    run = str(run_id or "").strip()
    if not base or not key:
        return {"ok": False, "error": "Billing gateway is not configured."}
    if not organization or not run:
        return {"ok": False, "error": "Billing identity is missing for this run."}

    payload = {
        "kind": str(kind),
        "outcome": str(outcome),
        "organization_id": organization,
        "user_id": str(user_id or "").strip() or None,
        "project_id": str(project_id or "").strip() or None,
        "run_id": run,
        "usage": usage if isinstance(usage, dict) else None,
        "dast_only": bool(dast_only),
    }
    body = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "X-API-Key": key,
        "X-Deplai-Service-Key": key,
    }
    target = f"{base}/api/billing/product-usage/settle"
    last_error = "Billing settlement did not complete."
    for attempt in range(3):
        try:
            req = request.Request(target, data=body, headers=headers, method="POST")
            with request.urlopen(req, timeout=10) as response:
                parsed = json.loads(response.read().decode("utf-8"))
            return {"ok": True, **(parsed if isinstance(parsed, dict) else {})}
        except error.HTTPError as exc:
            try:
                parsed = json.loads(exc.read().decode("utf-8", errors="replace"))
                last_error = str(parsed.get("error") or f"Billing settlement returned HTTP {exc.code}.")
            except Exception:
                last_error = f"Billing settlement returned HTTP {exc.code}."
            # A validation or credit-balance failure will not become successful
            # by retrying. Network/server failures may be retried safely.
            if exc.code < 500:
                return {"ok": False, "status": exc.code, "error": last_error}
        except (error.URLError, TimeoutError, ValueError) as exc:
            last_error = f"Billing settlement unavailable: {type(exc).__name__}."
        if attempt < 2:
            time.sleep(0.25 * (attempt + 1))
    logger.warning("Product usage settlement pending kind=%s run=%s reason=%s", kind, run, last_error)
    return {"ok": False, "error": last_error}
