from __future__ import annotations

import asyncio
import os
import hashlib
import json
import sys
from pathlib import Path
from typing import Callable

from remediation_pipeline.models import Fix

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
    # Process several small packets until critical/high work is exhausted or the cheap budget is hit.
    try:
        return max(1, min(8, int(os.getenv("REMEDIATION_SUPERVISOR_MAX_PACKETS", "8"))))
    except ValueError:
        return 8


def _is_context_limit_failure(result: object) -> bool:
    """A packet-size failure is isolated work, not a failed remediation run."""
    return "CONTEXT_LIMIT" in str(result or "").upper()


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
    from remediation_pipeline.remediation_store import remediation_runs
    all_batches = []
    cached_fixes = []
    # Packet construction is a final severity gate for direct/stale callers.
    severities = {"critical", "high"}
    for key in ("code_security", "supply_chain"):
        for finding in scan_data.get(key, []):
            if str(finding.get("severity", "")).lower() not in severities:
                continue
            occurrences = finding.get("occurrences", []) if key == "code_security" else []
            for occurrence in occurrences or [None]:
                item = {**finding, **({"occurrences": [occurrence]} if occurrence else {})}
                packet = {"code_security": [], "supply_chain": [], key: [item],
                    "project_id": scan_data.get("project_id"), "source_revision": scan_data.get("source_revision")}
                packet_id = hashlib.sha256(json.dumps(packet, sort_keys=True).encode()).hexdigest()
                cached = remediation_runs.packet_result(remediation_run_id or "", packet_id)
                if cached:
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
            "policy": "critical/high packets until cleared or cheap packet budget",
        },
    )

    await emit(
        "supervisor_phase",
        (
            f"Starting cheap two-call remediation on up to {len(batches)} context packet(s) "
            f"({strategy.get('stage_severity', 'critical/high')} scope)."
        ),
    )

    all_fixes: list[Fix] = list(cached_fixes)
    for index, (batch_scan, batch_stats) in enumerate(batches, start=1):
        code_count = len(batch_scan.get("code_security", []) or [])
        supply_count = len(batch_scan.get("supply_chain", []) or [])
        await emit(
            "supervisor_phase",
            (
                f"Run {index}/{len(batches)}: Master -> Planner -> Implementor -> Local Reviewer "
                f"({code_count} code root cause(s), {supply_count} supply root cause(s))."
            ),
        )

        async def on_message(msg_type: str, content: str) -> None:
            await emit(msg_type, content)

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
            raise RuntimeError(str(result))
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
