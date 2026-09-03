from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Callable

from remediation_pipeline.models import Fix

_AGENTIC_LAYER = Path(__file__).resolve().parents[1] / "Agentic Layer"
if str(_AGENTIC_LAYER) not in sys.path:
    sys.path.insert(0, str(_AGENTIC_LAYER))


def _supervisor_enabled() -> bool:
    return os.getenv("REMEDIATION_USE_SUPERVISOR", "true").strip().lower() in {"1", "true", "yes", "on"}


def _critic_min_score() -> int:
    try:
        return max(0, min(100, int(os.getenv("REMEDIATION_LOCAL_REVIEW_MIN_SCORE", "80"))))
    except ValueError:
        return 80


def _max_supervisor_batches() -> int:
    # One bounded context packet per run keeps the workflow at exactly two LLM calls.
    return 1


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
    from remediation import _build_remediation_batches, _select_cycle_scan_strategy
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

    cycle_scan, strategy = _select_cycle_scan_strategy(scan_data, remediation_scope)
    if strategy.get("mode") == "large_repo_major_complete":
        await emit("success", "Critical and high findings are already cleared for this remediation stage.")
        return []

    all_batches = _build_remediation_batches(cycle_scan, remediation_scope)
    batches = all_batches[:_max_supervisor_batches()]
    if not batches:
        await emit("info", "Supervisor found no critical/high findings to remediate in this batch.")
        return []

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
            "policy": "highest-priority packet only",
        },
    )

    await emit(
        "supervisor_phase",
        (
            f"Starting two-call remediation on {len(batches)} bounded context packet "
            f"({strategy.get('stage_severity', 'critical/high')} scope)."
        ),
    )

    all_fixes: list[Fix] = []
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
            await emit("warning", f"Supervisor batch {index} failed: {result}")
            continue
        if not isinstance(result, dict):
            await emit("warning", f"Supervisor batch {index} returned an unexpected payload.")
            continue

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
