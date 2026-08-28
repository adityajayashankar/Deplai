"""Deterministic LangGraph nodes. No LLM. Authorization is never inferred."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from dast_agent import audit, store
from dast_agent.authorization import authorize_target
from dast_agent.codes import (
    AUDIT_SCAN_AUTHORIZED,
    AUDIT_SCAN_CANCELLED,
    AUDIT_SCAN_COMPLETED,
    AUDIT_SCAN_REJECTED,
    AUDIT_SCAN_RESULTS_PERSISTED,
    AUDIT_SCAN_STARTED,
    AUDIT_SCAN_TIMED_OUT,
    AUDIT_ZAP_FAILED,
    AUDIT_ZAP_STARTED,
    AUTHZ_REJECTED,
    AUTHZ_VERIFIED,
    BLOCKED_UNAUTHORIZED,
    BLOCKED_UNSAFE_TARGET,
    DAST_TARGET_NOT_AUTHORIZED,
    INTENT_ACTIVE,
    INTENT_API_ACTIVE,
    INTENT_PASSIVE,
    PROFILE_API,
    PROFILE_BASELINE,
    PROFILE_FULL,
    SCAN_FAILED,
    SCAN_INCOMPLETE,
)
from dast_agent.scanner import ZapScanner, ZAP_IMAGE
from dast_agent.ssrf import inspect_outbound_target, revalidate_resolution
from dast_agent.state import DASTAgentState
from dast_agent.zap_plan import compliance_from_findings, normalize_zap_findings, render_zap_plan
from utils import find_volume_file, read_volume_file

_SCANNERS: dict[str, ZapScanner] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _err(state: DASTAgentState, message: str) -> list[str]:
    current = list(state.get("errors") or [])
    current.append(message)
    return current


def _audit(state: DASTAgentState, action: str, decision: str, reason: str = "", extra: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    event = audit.emit(
        scan_id=str(state.get("scan_id") or ""),
        action=action,
        decision=decision,
        reason=reason,
        project_id=str(state.get("project_id") or ""),
        actor=str(state.get("requested_by_user_id") or ""),
        target=str(state.get("normalized_target_url") or state.get("target_url") or ""),
        extra=extra,
    )
    events = list(state.get("audit_events") or [])
    events.append(event)
    return events


def load_scan_context(state: DASTAgentState) -> dict[str, Any]:
    scan_id = str(state.get("scan_id") or f"{state.get('project_id')}-{int(datetime.now(timezone.utc).timestamp())}")
    store.write_checkpoint(scan_id, "load_scan_context", {"scan_id": scan_id, "project_id": state.get("project_id")})
    return {
        "scan_id": scan_id,
        "scan_stage": "load_scan_context",
        "scan_status": "running",
        "scan_started_at": state.get("scan_started_at") or _now(),
        "retry_count": int(state.get("retry_count") or 0),
        "errors": list(state.get("errors") or []),
        "warnings": list(state.get("warnings") or []),
        "audit_events": list(state.get("audit_events") or []),
        "findings": list(state.get("findings") or []),
        "cancelled": bool(store.is_cancelled(scan_id)),
    }


def validate_project_access(state: DASTAgentState) -> dict[str, Any]:
    if not str(state.get("project_id") or "").strip():
        return {
            "authorization_status": AUTHZ_REJECTED,
            "authorization_reason": "INVALID_TARGET",
            "authorization_code": DAST_TARGET_NOT_AUTHORIZED,
            "scan_stage": "validate_project_access",
            "errors": _err(state, "Missing project_id"),
        }
    return {"scan_stage": "validate_project_access"}


def resolve_target_asset(state: DASTAgentState) -> dict[str, Any]:
    grant = state.get("grant") or {}
    return {
        "scan_stage": "resolve_target_asset",
        "asset_id": str(grant.get("asset_id") or state.get("asset_id") or ""),
        "asset_scope": str(grant.get("scope_mode") or state.get("asset_scope") or ""),
    }


def validate_target_authorization(state: DASTAgentState) -> dict[str, Any]:
    result = authorize_target(
        project_id=str(state.get("project_id") or ""),
        requested_target=str(state.get("target_url") or ""),
        grant=state.get("grant"),
        live_asset=state.get("live_asset"),
    )
    if not result.authorized:
        _audit(state, AUDIT_SCAN_REJECTED, "deny", result.reason, {"code": result.code})
        store.write_checkpoint(str(state.get("scan_id") or ""), "authorization_verified", {"authorized": False, "code": result.code})
        return {
            "scan_stage": "validate_target_authorization",
            "authorization_status": AUTHZ_REJECTED,
            "authorization_reason": result.reason,
            "authorization_code": result.code,
            "compliance_status": compliance_from_findings([], blocked_code=result.code),
            "scan_status": "blocked",
            "errors": _err(state, f"{result.code}: {result.message}"),
            "audit_events": list(state.get("audit_events") or []),
        }
    _audit(state, AUDIT_SCAN_AUTHORIZED, "allow", result.reason)
    store.write_checkpoint(str(state.get("scan_id") or ""), "authorization_verified", {"authorized": True, "reason": result.reason})
    normalized = result.scope
    return {
        "scan_stage": "validate_target_authorization",
        "authorization_status": AUTHZ_VERIFIED,
        "authorization_reason": result.reason,
        "authorization_code": "",
        "asset_id": result.asset_id,
        "asset_scope": result.scope_mode,
        "ownership_method": result.verification_method,
        "ownership_status": AUTHZ_VERIFIED,
        "target_hostname": result.hostname,
        "resolved_ips": list(result.resolved_ips or []),
        "dns_resolution": list(result.resolved_ips or []),
        "normalized_target_url": (result.scope and str(state.get("target_url") or "")) or str(state.get("target_url") or ""),
        "evidence": {"scope": result.scope_mode, "asset_id": result.asset_id},
        "audit_events": list(state.get("audit_events") or []),
        "target_scheme": normalized.scheme if normalized else "",
    }


def verify_target_scope(state: DASTAgentState) -> dict[str, Any]:
    if str(state.get("authorization_status") or "") != AUTHZ_VERIFIED:
        return {
            "scope_validation_status": "REJECTED",
            "scan_stage": "verify_target_scope",
        }
    result = authorize_target(
        project_id=str(state.get("project_id") or ""),
        requested_target=str(state.get("target_url") or ""),
        grant=state.get("grant"),
        live_asset=state.get("live_asset"),
    )
    if not result.authorized or result.scope is None:
        return {
            "scope_validation_status": "REJECTED",
            "authorization_status": AUTHZ_REJECTED,
            "authorization_code": result.code,
            "authorization_reason": result.reason,
            "compliance_status": compliance_from_findings([], blocked_code=result.code),
            "scan_status": "blocked",
            "scan_stage": "verify_target_scope",
            "errors": _err(state, f"{result.code}: {result.message}"),
        }
    store.write_checkpoint(str(state.get("scan_id") or ""), "scope_verified", {"hostname": result.hostname})
    return {
        "scope_validation_status": "VERIFIED",
        "scan_stage": "verify_target_scope",
        "target_scheme": result.scope.scheme,
        "target_hostname": result.hostname,
    }


def perform_ssrf_safety_validation(state: DASTAgentState) -> dict[str, Any]:
    if str(state.get("authorization_status") or "") != AUTHZ_VERIFIED:
        return {"ssrf_validation_status": "REJECTED", "scan_stage": "perform_ssrf_safety_validation"}
    check = inspect_outbound_target(str(state.get("target_url") or ""))
    if not check.ok:
        _audit(state, AUDIT_SCAN_REJECTED, "deny", check.code)
        return {
            "ssrf_validation_status": "REJECTED",
            "authorization_status": AUTHZ_REJECTED,
            "authorization_code": check.code,
            "compliance_status": compliance_from_findings([], blocked_code=check.code),
            "scan_status": "blocked",
            "scan_stage": "perform_ssrf_safety_validation",
            "errors": _err(state, f"{check.code}: {check.message}"),
            "audit_events": list(state.get("audit_events") or []),
        }
    pinned = list(state.get("resolved_ips") or check.resolved_ips)
    pinned_check = revalidate_resolution(str(state.get("target_url") or ""), pinned)
    if not pinned_check.ok:
        return {
            "ssrf_validation_status": "REJECTED",
            "authorization_status": AUTHZ_REJECTED,
            "authorization_code": pinned_check.code,
            "compliance_status": compliance_from_findings([], blocked_code=pinned_check.code),
            "scan_status": "blocked",
            "scan_stage": "perform_ssrf_safety_validation",
            "errors": _err(state, f"{pinned_check.code}: {pinned_check.message}"),
        }
    return {
        "ssrf_validation_status": "VERIFIED",
        "resolved_ips": list(pinned_check.resolved_ips),
        "normalized_target_url": pinned_check.normalized.url if pinned_check.normalized else str(state.get("target_url") or ""),
        "target_hostname": pinned_check.normalized.hostname if pinned_check.normalized else "",
        "target_scheme": pinned_check.normalized.scheme if pinned_check.normalized else "",
        "target_port": pinned_check.normalized.port if pinned_check.normalized else None,
        "scan_stage": "perform_ssrf_safety_validation",
    }


def build_scan_plan(state: DASTAgentState) -> dict[str, Any]:
    profile = str(state.get("scan_profile") or PROFILE_BASELINE).upper()
    intent = str(state.get("scan_intent") or INTENT_PASSIVE).upper()
    if profile == PROFILE_FULL and intent != INTENT_ACTIVE:
        return {
            "scan_status": "blocked",
            "authorization_code": DAST_TARGET_NOT_AUTHORIZED,
            "errors": _err(state, "Active DAST requires explicit ACTIVE intent."),
            "scan_stage": "build_scan_plan",
        }
    if profile == PROFILE_API and intent != INTENT_API_ACTIVE:
        return {
            "scan_status": "blocked",
            "authorization_code": DAST_TARGET_NOT_AUTHORIZED,
            "errors": _err(state, "API DAST requires explicit API_ACTIVE intent."),
            "scan_stage": "build_scan_plan",
        }
    if profile == PROFILE_BASELINE and intent not in {INTENT_PASSIVE, ""}:
        profile = PROFILE_BASELINE
        intent = INTENT_PASSIVE
    result = authorize_target(
        project_id=str(state.get("project_id") or ""),
        requested_target=str(state.get("target_url") or ""),
        grant=state.get("grant"),
        live_asset=state.get("live_asset"),
    )
    if not result.authorized or result.scope is None:
        return {"scan_status": "blocked", "authorization_code": result.code, "scan_stage": "build_scan_plan"}
    plan = render_zap_plan(
        target_url=str(state.get("normalized_target_url") or state.get("target_url") or ""),
        report_filename="Dast.json",
        profile=profile,
        scope=result.scope,
        api_spec_url=str(state.get("api_spec_url") or "") or None,
    )
    return {
        "scan_stage": "build_scan_plan",
        "scan_profile": profile,
        "scan_intent": intent,
        "zap_plan": plan,
        "zap_image": ZAP_IMAGE,
    }


def checkpoint_before_scan(state: DASTAgentState) -> dict[str, Any]:
    store.write_checkpoint(str(state.get("scan_id") or ""), "pre_scan", {
        "authorization_status": state.get("authorization_status"),
        "ssrf_validation_status": state.get("ssrf_validation_status"),
        "target": state.get("normalized_target_url"),
    })
    return {"scan_stage": "checkpoint_before_scan", "dast_checkpoint_id": "pre_scan"}


def launch_zap(state: DASTAgentState) -> dict[str, Any]:
    scan_id = str(state.get("scan_id") or "")
    if store.is_cancelled(scan_id):
        return {"cancelled": True, "scan_status": "cancelled", "scan_stage": "launch_zap"}
    # Execution-time revalidation (revocation + DNS TOCTOU).
    result = authorize_target(
        project_id=str(state.get("project_id") or ""),
        requested_target=str(state.get("target_url") or ""),
        grant=state.get("grant"),
        live_asset=state.get("live_asset"),
    )
    if not result.authorized or result.scope is None:
        return {
            "authorization_status": AUTHZ_REJECTED,
            "authorization_code": result.code,
            "scan_status": "blocked",
            "scan_stage": "launch_zap",
            "errors": _err(state, f"{result.code}: {result.message}"),
        }
    pinned = revalidate_resolution(str(state.get("target_url") or ""), list(state.get("resolved_ips") or result.resolved_ips or []))
    if not pinned.ok:
        return {
            "authorization_status": AUTHZ_REJECTED,
            "authorization_code": pinned.code,
            "scan_status": "blocked",
            "compliance_status": compliance_from_findings([], blocked_code=pinned.code),
            "scan_stage": "launch_zap",
            "errors": _err(state, f"{pinned.code}: {pinned.message}"),
        }

    scanner = ZapScanner(
        project_name=str(state.get("project_name") or state.get("project_id") or "project"),
        project_id=str(state.get("project_id") or ""),
        target_url=str(state.get("normalized_target_url") or state.get("target_url") or ""),
        profile=str(state.get("scan_profile") or PROFILE_BASELINE),
        scope=result.scope,
        api_spec_url=str(state.get("api_spec_url") or "") or None,
        cancelled=lambda: store.is_cancelled(scan_id),
    )
    _audit(state, AUDIT_SCAN_STARTED, "allow", result.reason)
    ok, error = scanner.start()
    if not ok:
        scanner.cleanup()
        _audit(state, AUDIT_ZAP_FAILED, "fail", error)
        return {
            "zap_ok": False,
            "scan_stage": "launch_zap",
            "errors": _err(state, error),
            "audit_events": list(state.get("audit_events") or []),
        }
    _SCANNERS[scan_id] = scanner
    _audit(state, AUDIT_ZAP_STARTED, "allow", scanner.container_id)
    store.write_checkpoint(scan_id, "zap_started", {"container_id": scanner.container_id, "image": ZAP_IMAGE})
    return {
        "zap_ok": True,
        "zap_container_id": scanner.container_id,
        "zap_image": ZAP_IMAGE,
        "scan_stage": "launch_zap",
        "audit_events": list(state.get("audit_events") or []),
    }


def monitor_zap(state: DASTAgentState) -> dict[str, Any]:
    scan_id = str(state.get("scan_id") or "")
    scanner = _SCANNERS.get(scan_id)
    if scanner is None:
        return {"zap_ok": False, "scan_stage": "monitor_zap", "errors": _err(state, "ZAP worker was not started.")}
    ok, error = scanner.collect_results()
    if error == "cancelled":
        scanner.cleanup()
        _audit(state, AUDIT_SCAN_CANCELLED, "cancel")
        return {"cancelled": True, "zap_ok": False, "scan_status": "cancelled", "scan_stage": "monitor_zap"}
    if error == "timed_out":
        scanner.cleanup()
        _audit(state, AUDIT_SCAN_TIMED_OUT, "fail")
        return {"zap_ok": False, "scan_status": "timed_out", "scan_stage": "monitor_zap", "errors": _err(state, error)}
    if not ok:
        retry = int(state.get("retry_count") or 0)
        scanner.cleanup()
        if retry < 1:
            return {"zap_ok": False, "retry_count": retry + 1, "scan_stage": "retry_scan", "errors": _err(state, error)}
        _audit(state, AUDIT_ZAP_FAILED, "fail", error)
        return {"zap_ok": False, "scan_status": "failed", "scan_stage": "monitor_zap", "errors": _err(state, error)}
    return {"zap_ok": True, "scan_stage": "monitor_zap"}


def retry_scan(state: DASTAgentState) -> dict[str, Any]:
    return {"scan_stage": "retry_scan", "retry_count": int(state.get("retry_count") or 0) + 1, "zap_ok": False}


def collect_zap_results(state: DASTAgentState) -> dict[str, Any]:
    scan_id = str(state.get("scan_id") or "")
    scanner = _SCANNERS.pop(scan_id, None)
    if scanner is not None:
        scanner.cleanup()
    store.write_checkpoint(scan_id, "zap_results_collected", {"zap_ok": bool(state.get("zap_ok"))})
    return {"scan_stage": "collect_zap_results"}


def normalize_findings(state: DASTAgentState) -> dict[str, Any]:
    filename = find_volume_file(str(state.get("project_id") or ""), "Dast.json")
    raw = read_volume_file(filename) if filename else None
    report = None
    if raw:
        try:
            report = json.loads(raw)
        except json.JSONDecodeError:
            report = None
    findings = normalize_zap_findings(
        report if isinstance(report, dict) else None,
        scan_id=str(state.get("scan_id") or ""),
        asset_id=str(state.get("asset_id") or ""),
    )
    return {
        "scan_stage": "normalize_findings",
        "findings": findings,
        "finding_count": len(findings),
    }


def evaluate_compliance(state: DASTAgentState) -> dict[str, Any]:
    blocked = str(state.get("authorization_code") or "")
    status = compliance_from_findings(list(state.get("findings") or []), blocked_code=blocked)
    if str(state.get("scan_status") or "") in {"failed", "timed_out"} and not blocked:
        status = SCAN_FAILED if state.get("scan_status") == "failed" else SCAN_INCOMPLETE
    return {"scan_stage": "evaluate_compliance", "compliance_status": status}


def persist_results(state: DASTAgentState) -> dict[str, Any]:
    store.write_checkpoint(str(state.get("scan_id") or ""), "findings_persisted", {
        "finding_count": state.get("finding_count") or 0,
        "compliance_status": state.get("compliance_status"),
    })
    _audit(state, AUDIT_SCAN_RESULTS_PERSISTED, "allow", str(state.get("finding_count") or 0))
    return {"scan_stage": "persist_results", "audit_events": list(state.get("audit_events") or [])}


def persist_audit_evidence(state: DASTAgentState) -> dict[str, Any]:
    store.write_checkpoint(str(state.get("scan_id") or ""), "audit", {
        "authorization_status": state.get("authorization_status"),
        "compliance_status": state.get("compliance_status"),
        "errors": state.get("errors") or [],
    })
    return {"scan_stage": "persist_audit_evidence"}


def finalize_scan(state: DASTAgentState) -> dict[str, Any]:
    status = str(state.get("scan_status") or "completed")
    if str(state.get("authorization_status") or "") == AUTHZ_REJECTED:
        status = "blocked"
    elif state.get("cancelled"):
        status = "cancelled"
    elif status not in {"blocked", "failed", "timed_out", "cancelled"}:
        status = "completed"
        _audit(state, AUDIT_SCAN_COMPLETED, "allow")
    return {
        "scan_stage": "finalize_scan",
        "scan_status": status,
        "scan_finished_at": _now(),
        "audit_events": list(state.get("audit_events") or []),
    }


def authorization_failed(state: DASTAgentState) -> dict[str, Any]:
    return {
        "scan_stage": "authorization_failed",
        "scan_status": "blocked",
        "compliance_status": state.get("compliance_status") or BLOCKED_UNAUTHORIZED,
    }


def scope_failed(state: DASTAgentState) -> dict[str, Any]:
    return {"scan_stage": "scope_failed", "scan_status": "blocked", "compliance_status": BLOCKED_UNAUTHORIZED}


def safety_failed(state: DASTAgentState) -> dict[str, Any]:
    return {"scan_stage": "safety_failed", "scan_status": "blocked", "compliance_status": BLOCKED_UNSAFE_TARGET}


def route_after_auth(state: DASTAgentState) -> str:
    if str(state.get("authorization_status") or "") != AUTHZ_VERIFIED:
        return "authorization_failed"
    return "verify_target_scope"


def route_after_scope(state: DASTAgentState) -> str:
    if str(state.get("scope_validation_status") or "") != "VERIFIED":
        return "scope_failed"
    return "perform_ssrf_safety_validation"


def route_after_ssrf(state: DASTAgentState) -> str:
    if str(state.get("ssrf_validation_status") or "") != "VERIFIED":
        return "safety_failed"
    return "build_scan_plan"


def route_after_plan(state: DASTAgentState) -> str:
    if str(state.get("scan_status") or "") == "blocked":
        return "authorization_failed"
    return "checkpoint_before_scan"


def route_after_launch(state: DASTAgentState) -> str:
    if str(state.get("scan_status") or "") == "blocked" or str(state.get("authorization_status") or "") == AUTHZ_REJECTED:
        return "authorization_failed"
    if state.get("cancelled"):
        return "collect_zap_results"
    if not state.get("zap_ok") and int(state.get("retry_count") or 0) < 1:
        return "retry_scan"
    if not state.get("zap_ok"):
        return "collect_zap_results"
    return "monitor_zap"


def route_after_monitor(state: DASTAgentState) -> str:
    if str(state.get("scan_stage") or "") == "retry_scan":
        return "retry_scan"
    return "collect_zap_results"
