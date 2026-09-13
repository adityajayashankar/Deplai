from __future__ import annotations

import asyncio
import os
import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
import sys
from pathlib import Path
from typing import Callable

from remediation_pipeline.models import Fix, Vulnerability

_AGENTIC_LAYER = Path(__file__).resolve().parents[1] / "Agentic Layer"
if str(_AGENTIC_LAYER) not in sys.path:
    sys.path.insert(0, str(_AGENTIC_LAYER))


def _supervisor_enabled() -> bool:
    return True  # All product remediation entrypoints use the same bounded workflow.


def _critic_min_score() -> int:
    try:
        return max(0, min(100, int(os.getenv("REMEDIATION_LOCAL_REVIEW_MIN_SCORE", "80"))))
    except ValueError:
        return 80


def _max_supervisor_batches() -> int:
    # Process critical/high packets under the shared run token allowance.
    try:
        return max(1, min(512, int(os.getenv("REMEDIATION_SUPERVISOR_MAX_PACKETS", "256"))))
    except ValueError:
        return 256


def _is_context_limit_failure(result: object) -> bool:
    """A packet-size failure is isolated work, not a failed remediation run."""
    return "CONTEXT_LIMIT" in str(result or "").upper()


def _capacity_retry_after(result: object) -> int | None:
    text = str(result or "")
    if not any(marker in text.lower() for marker in ('rate_limit', 'quota_exceeded', 'ai gateway http 429')):
        return None
    match = re.search(r'"retryAfterSeconds"\s*:\s*(\d+)', text)
    seconds = int(match.group(1)) if match else 0
    return seconds if 0 < seconds <= 86400 else None


def _manual_context_result(result: object) -> dict:
    reason = str(result or "Source context could not fit safely in the remediation packet.")
    return {
        "summary": "Manual source review required for an oversized remediation context packet.",
        "changed_files": [],
        "rejected_changes": [{"path": "", "reason": reason}],
        "manual_actions": [{"action": "manual_source_review", "reason": reason}],
        "proposed_change_count": 0,
        "applied_change_count": 0,
        "critic_verdict": "reject",
        "critic_score": 0,
        "workflow": "manual_context_review",
    }


def supervisor_result_to_fixes(result: dict, *, min_score: int | None = None) -> list[Fix]:
    """Convert a remediation supervisor result into pipeline Fix objects."""
    threshold = _critic_min_score() if min_score is None else min_score
    score = int(result.get("critic_score", 0) or 0)
    verdict = str(result.get("critic_verdict", "reject") or "reject").strip().lower()
    accepted = verdict == "accept" and score >= threshold
    status = "auto" if accepted else "needs_review"
    warnings: list[str] = []
    if not accepted:
        warnings.append(
            f"Local reviewer {verdict} (quality {score}/100; threshold {threshold}/100) — manual review recommended."
        )

    fixes: list[Fix] = []
    for item in result.get("changed_files", []) or []:
        if not isinstance(item, dict):
            continue
        path = str(item.get("path") or "").strip()
        diff = str(item.get("diff") or "").strip()
        if not path or not diff:
            continue
        fixes.append(
            Fix(
                filepath=path,
                diff=diff,
                vulns_addressed=[
                    str(value)
                    for value in (item.get("vulns_addressed") or [])
                    if str(value).strip()
                ],
                provider_used="supervisor",
                tokens_used=0,
                status=status,
                raw_response=str(result.get("summary") or ""),
                warnings=list(warnings),
            )
        )
    return fixes


async def run_supervised_remediation(
    project_id: str,
    remediation_scope: str,
    *,
    on_progress: Callable[[str, str], object] | None = None,
    llm_provider: str | None = None,
    llm_api_key: str | None = None,
    llm_model: str | None = None,
    user_id: str | None = None,
    organization_id: str | None = None,
    access_mode: str | None = None,
    llm_credential_id: str | None = None,
    remediation_run_id: str | None = None,
    selected_vulnerabilities: list[Vulnerability] | None = None,
) -> list[Fix]:
    """Run Master -> Planner -> Implementor -> Reviewer on filtered scan batches."""
    if not _supervisor_enabled():
        return []

    from agent import run_remediation_workflow
    from result_parser import get_scan_results

    async def emit(msg_type: str, content: str) -> None:
        if on_progress is None:
            return
        result = on_progress(msg_type, content)
        if hasattr(result, "__await__"):
            await result

    ok, scan_data = get_scan_results(project_id)
    if not ok or not isinstance(scan_data, dict) or not scan_data:
        await emit("warning", "Supervisor skipped: scan results unavailable.")
        return []

    scan_data = dict(scan_data)
    scan_data["code_security"] = list(scan_data.get("code_security", []))
    for finding in scan_data.get("findings", []):
        if finding.get("category") in {"iac", "containers", "kubernetes", "cicd", "api"}:
            location = str(finding.get("location") or "")
            line = location.rsplit(":", 1)[-1]
            scan_data["code_security"].append({"cwe_id": (finding.get("metadata") or {}).get("rule_id") or finding["id"],
                "root_cause_key": finding["id"], "title": finding["title"], "severity": finding["severity"],
                "occurrences": [{"filename": finding["asset"], "line_number": int(line) if line.isdigit() else 1}]})
    # Packetize before any model context is built; do not truncate the finding queue.
    if selected_vulnerabilities is not None:
        # Use the exact source-patch selection that survived ingestion/triage.
        # Re-reading raw scanner groups here used to reintroduce ignored work.
        scan_data["code_security"] = [
            {"root_cause_key": v.id, "cwe_id": v.cwe or v.rule_id,
             "title": v.description, "severity": v.severity, "type": v.type,
             "package": v.package_name, "version": v.installed_version,
             "fixed_version": v.fix_version, "source_revision": v.source_revision,
             "occurrences": [{"filename": v.file, "line_number": v.line_start,
                              "end_line_number": v.line_end}]}
            for v in selected_vulnerabilities
            if v.severity in {"critical", "high"}
            and v.remediation_capability == "source_patch" and v.triage_action != "ignore"
        ]
        scan_data["supply_chain"] = []
    from remediation_pipeline.remediation_store import remediation_runs
    all_batches = []
    cached_fixes = []
    # Packet construction is a final severity gate for direct/stale callers.
    severities = {"critical", "high"}
    grouped = {}
    for key in ("code_security", "supply_chain"):
        for finding in scan_data.get(key, []):
            if str(finding.get("severity", "")).lower() not in severities:
                continue
            occurrences = finding.get("occurrences", []) if key == "code_security" else []
            for occurrence in occurrences or [None]:
                item = {**finding, **({"occurrences": [occurrence]} if occurrence else {})}
                group = (key, str((occurrence or {}).get("filename") or finding.get("package") or finding.get("root_cause_key")))
                items = grouped.setdefault(group, [])
                if item not in items:
                    items.append(item)
    for (key, _path), items in sorted(grouped.items()):
        # Findings that edit the same file must share one plan, including
        # controllers and manifests. Existing context limits still apply.
        batch_size = len(items)
        for offset in range(0, len(items), batch_size):
            packet = {"code_security": [], "supply_chain": [], key: items[offset:offset + batch_size],
                "project_id": scan_data.get("project_id"), "source_revision": scan_data.get("source_revision"),
                "packet_schema": "file-group-v4-coherent"}
            packet_id = hashlib.sha256(json.dumps(packet, sort_keys=True).encode()).hexdigest()
            cached = remediation_runs.packet_result(remediation_run_id or "", packet_id)
            if cached and cached.get("critic_verdict") == "accept":
                cached_fixes.extend(supervisor_result_to_fixes(cached))
            else:
                all_batches.append((packet, {"packet_id": packet_id}))
    all_batches.sort(key=lambda pair: min({"critical": 0, "high": 1, "medium": 2, "low": 3}.get(x.get("severity"), 4)
        for key in ("code_security", "supply_chain") for x in pair[0][key]))
    batches = all_batches[:_max_supervisor_batches()]
    strategy = {"stage_severity": "major"}
    if not batches:
        await emit("info", "Supervisor found no critical/high findings to remediate in this batch.")
        return cached_fixes

    deferred_findings = sum(
        len(batch_scan.get("code_security", []) or []) + len(batch_scan.get("supply_chain", []) or [])
        for batch_scan, _ in all_batches[len(batches):]
    )
    from remediation_pipeline.remediation_store import remediation_runs
    remediation_runs.store_agent_artifact(
        remediation_run_id,
        "master",
        {
            "selected_packets": len(batches),
            "deferred_packets": max(0, len(all_batches) - len(batches)),
            "pending_findings": deferred_findings,
            "policy": "critical/high packets with source exploration and validation-driven repair",
        },
    )

    await emit(
        "supervisor_phase",
        (
            f"Starting validation-driven remediation on {len(batches)} context packet(s) "
            f"({strategy.get('stage_severity', 'critical/high')} scope); shared allowance "
            f"{remediation_runs.token_limit():,} tokens on {llm_model or 'openrouter/free'}."
        ),
    )

    all_fixes: list[Fix] = list(cached_fixes)
    for index, (batch_scan, batch_stats) in enumerate(batches, start=1):
        code_count = len(batch_scan.get("code_security", []) or [])
        supply_count = len(batch_scan.get("supply_chain", []) or [])
        await emit(
            "supervisor_phase",
            (
                f"Packet {index}/{len(batches)}: Master -> Planner -> Implementor -> Local Reviewer "
                f"({code_count} code root cause(s), {supply_count} supply root cause(s))."
            ),
        )

        async def on_message(msg_type: str, content: str) -> None:
            await emit(msg_type, content)

        for capacity_attempt in range(4):
            success, result = await run_remediation_workflow(
                batch_scan,
                project_id=project_id,
                llm_provider=llm_provider,
                llm_api_key=llm_api_key,
                llm_model=llm_model,
                on_message=on_message,
                user_id=user_id,
                organization_id=organization_id,
                access_mode=access_mode,
                llm_credential_id=llm_credential_id,
                remediation_run_id=remediation_run_id,
                persist_changes=False,
            )
            delay = None if success else _capacity_retry_after(result)
            if delay is None or capacity_attempt == 3:
                break
            retry_at = datetime.now(timezone.utc) + timedelta(seconds=delay)
            remediation_runs.packet_result(remediation_run_id or "", batch_stats["packet_id"],
                {"changed_files": [], "status": "waiting_for_capacity", "retry_at": retry_at.isoformat(),
                 "error": "Shared inference capacity is temporarily unavailable."})
            await emit("warning", f"Waiting for free-model capacity until {retry_at.strftime('%H:%M:%S UTC')} "
                       f"(about {(delay + 59) // 60} minute(s)). Packet {index}/{len(batches)} is saved; "
                       "the run will retry it automatically. No model calls are made during this wait.")
            remaining = delay
            while remaining > 0:
                interval = min(60, remaining)
                await asyncio.sleep(interval)
                remaining -= interval
                if remaining > 0 and remaining % 300 < 60:
                    await emit("info", f"Still waiting for free-model capacity; about {(remaining + 59) // 60} minute(s) remain.")
            await emit("info", f"Capacity retry time reached; retrying packet {index}/{len(batches)}.")

        if not success:
            if _is_context_limit_failure(result):
                manual_result = _manual_context_result(result)
                remediation_runs.packet_result(remediation_run_id or "", batch_stats["packet_id"], manual_result)
                await emit(
                    "warning",
                    (
                        f"Supervisor batch {index} requires manual source review because its context could not fit "
                        "safely; continuing with the remaining packets."
                    ),
                )
                continue
            await emit("warning", f"Supervisor batch {index} failed: {result}")
            remediation_runs.packet_result(remediation_run_id or "", batch_stats["packet_id"],
                {"changed_files": [], "status": "unresolved", "error": str(result)})
            # A bad packet must not erase accepted patches or prevent unrelated
            # files from being repaired. Stop dispatch on account exhaustion.
            failure = str(result).lower()
            context_failure = any(word in failure for word in (
                "organization_not_found", "organization not found",
                "organizations_schema_missing", "ai gateway http 401", "ai gateway http 403",
                "x-deplai-user-id is required", "x-deplai-organization-id is required",
            ))
            if context_failure or any(word in failure for word in ("quota", "rate_limit", "http 429", "authentication", "run_token_budget")):
                reason = ("AI gateway authorization is unavailable; check that the worker calls the same Connector that started this run and that organization access is active"
                          if context_failure else "The shared run token allowance is exhausted"
                          if "run_token_budget" in failure else "Inference capacity is unavailable")
                await emit("warning", reason + "; completed patches are retained and remaining findings are unresolved.")
                break
            continue
        if not isinstance(result, dict):
            await emit("warning", f"Supervisor batch {index} returned an unexpected payload.")
            continue

        remediation_runs.packet_result(remediation_run_id or "", batch_stats["packet_id"], result)
        batch_fixes = supervisor_result_to_fixes(result)
        if batch_fixes:
            all_fixes.extend(batch_fixes)
            await emit(
                "success",
                (
                    f"Supervisor batch {index}: {len(batch_fixes)} patch(es) ready "
                    f"(local review {result.get('critic_verdict', 'unknown')}, "
                    f"quality {result.get('critic_score', 0)}/100)."
                ),
            )
        else:
            proposed = int(result.get("proposed_change_count", 0) or 0)
            rejected = len(result.get("rejected_changes", []) or [])
            await emit(
                "warning",
                (
                    f"Supervisor batch {index}: no safe patches produced "
                    f"(proposed={proposed}, rejected={rejected})."
                ),
            )

    return all_fixes
