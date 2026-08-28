"""ZAP Automation Framework plan generation and findings normalization."""

from __future__ import annotations

from typing import Any

import yaml

from dast_agent.codes import PROFILE_API, PROFILE_BASELINE, PROFILE_FULL
from dast_agent.scope import DastScope


def zap_include_regex(hostname: str, scheme: str) -> str:
    host = str(hostname or "").replace(".", r"\.")
    return rf"{scheme}://{host}.*"


def build_zap_plan(
    *,
    target_url: str,
    report_filename: str,
    profile: str,
    scope: DastScope,
    api_spec_url: str | None = None,
    spider_minutes: int = 5,
) -> dict[str, Any]:
    include_paths = [zap_include_regex(scope.hostname, scope.scheme)]
    if scope.scope_mode == "VERIFIED_DOMAIN":
        escaped = scope.hostname.replace(".", r"\.")
        include_paths.append(rf"{scope.scheme}://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.{escaped}.*")

    jobs: list[dict[str, Any]] = [
        {
            "type": "spider",
            "parameters": {
                "context": "deplai",
                "url": target_url,
                "maxDuration": max(1, min(int(spider_minutes), 15)),
            },
        },
        {"type": "passiveScan-wait", "parameters": {"maxDuration": 5}},
    ]
    mode = str(profile or PROFILE_BASELINE).upper()
    if mode == PROFILE_FULL:
        jobs.append({
            "type": "activeScan",
            "parameters": {"context": "deplai", "maxDuration": max(5, min(int(spider_minutes) * 3, 40))},
        })
    elif mode == PROFILE_API:
        spec = str(api_spec_url or target_url)
        jobs.insert(0, {
            "type": "openapi",
            "parameters": {"apiUrl": spec, "context": "deplai"},
        })
        jobs.append({
            "type": "activeScan",
            "parameters": {"context": "deplai", "maxDuration": max(5, min(int(spider_minutes) * 2, 30))},
        })

    jobs.append({
        "type": "report",
        "parameters": {
            "template": "traditional-json",
            "reportDir": "/zap/wrk",
            "reportFile": report_filename.replace(".json", ""),
        },
    })

    return {
        "env": {
            "contexts": [
                {
                    "name": "deplai",
                    "urls": [target_url],
                    "includePaths": include_paths,
                    "excludePaths": list(scope.excluded_paths or []),
                }
            ],
            "parameters": {
                "failOnError": False,
                "failOnWarning": False,
                "progressToStdout": True,
            },
        },
        "jobs": jobs,
    }


def render_zap_plan(**kwargs: Any) -> str:
    return yaml.safe_dump(build_zap_plan(**kwargs), sort_keys=False)


def normalize_zap_findings(report: dict[str, Any] | None, *, scan_id: str, asset_id: str) -> list[dict[str, Any]]:
    if not isinstance(report, dict):
        return []
    sites = report.get("site")
    if not isinstance(sites, list):
        return []
    findings: list[dict[str, Any]] = []
    for site in sites:
        if not isinstance(site, dict):
            continue
        alerts = site.get("alerts") if isinstance(site.get("alerts"), list) else []
        for alert in alerts:
            if not isinstance(alert, dict):
                continue
            risk = str(alert.get("riskdesc") or alert.get("risk") or "medium").split(" ", 1)[0].lower()
            severity = {
                "informational": "low",
                "info": "low",
                "low": "low",
                "medium": "medium",
                "high": "high",
                "critical": "critical",
            }.get(risk, "medium")
            instances = alert.get("instances") if isinstance(alert.get("instances"), list) else []
            first = instances[0] if instances and isinstance(instances[0], dict) else {}
            uri = str(first.get("uri") or site.get("@name") or site.get("name") or "")
            plugin_id = str(alert.get("pluginid") or alert.get("pluginId") or "dast")
            findings.append({
                "id": f"{scan_id}:{plugin_id}:{uri}",
                "scan_id": scan_id,
                "asset_id": asset_id,
                "rule_id": plugin_id,
                "title": str(alert.get("alert") or alert.get("name") or "Dynamic finding"),
                "description": str(alert.get("desc") or alert.get("description") or "")[:2000],
                "severity": severity,
                "confidence": str(alert.get("confidence") or ""),
                "cwe_id": str(alert.get("cweid") or alert.get("cweId") or ""),
                "owasp": str(alert.get("wascid") or ""),
                "url": uri,
                "method": str(first.get("method") or ""),
                "parameter": str(first.get("param") or ""),
                "evidence": str(first.get("evidence") or "")[:120],
                "scanner": "zap",
            })
    return findings


def compliance_from_findings(findings: list[dict[str, Any]], *, blocked_code: str = "") -> str:
    from dast_agent.codes import (
        BLOCKED_UNAUTHORIZED,
        BLOCKED_UNSAFE_TARGET,
        COMPLIANT,
        NON_COMPLIANT,
        SCAN_FAILED,
    )
    if blocked_code in {"DAST_TARGET_NOT_AUTHORIZED", "DAST_DOMAIN_NOT_VERIFIED", "DAST_VERIFICATION_EXPIRED", "DAST_VERIFICATION_REVOKED", "DAST_TARGET_OUTSIDE_SCOPE", "DAST_GRANT_INVALID"}:
        return BLOCKED_UNAUTHORIZED
    if blocked_code in {"DAST_PRIVATE_IP_BLOCKED", "DAST_UNSAFE_TARGET", "DAST_DNS_REBINDING_BLOCKED", "DAST_REDIRECT_OUT_OF_SCOPE"}:
        return BLOCKED_UNSAFE_TARGET
    if blocked_code:
        return SCAN_FAILED
    if any(str(item.get("severity") or "") in {"high", "critical"} for item in findings):
        return NON_COMPLIANT
    return COMPLIANT
