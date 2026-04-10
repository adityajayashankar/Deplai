from __future__ import annotations

import asyncio
import json
import os

from fastapi import WebSocket

from models import RemediationRequest, StreamStatus, WebSocketCommand
from remediation_pipeline.models import RemediationPRRequest
from remediation_pipeline.orchestrator import RemediationOrchestrator
from runner_base import RunnerBase
from utils import set_current_project_id


MAX_ROUNDS = 2
TOTAL_STEPS = 8


class RemediationTrackRunner(RunnerBase):
    """WebSocket runner that executes the remediation pipeline inside the security track."""

    def __init__(self, websocket: WebSocket, context: RemediationRequest, orchestrator: RemediationOrchestrator):
        super().__init__(websocket, TOTAL_STEPS)
        self.context = context
        self.orchestrator = orchestrator
        self._command_event = asyncio.Event()
        self._pending_action: str | None = None
        self._decision_requested = False
        self._approval_requested = False
        self._latest_fixes = []

    async def handle_command(self, command: WebSocketCommand):
        if command.action == "continue_round":
            if not self._decision_requested:
                await self._send_message("warning", "Continue ignored: remediation is not waiting for a round decision.")
                return
            self._pending_action = "continue_round"
            self._decision_requested = False
            self._command_event.set()
            return

        if command.action == "push_current":
            if not self._decision_requested:
                await self._send_message("warning", "Use current fixes ignored: remediation is not waiting for a round decision.")
                return
            self._pending_action = "push_current"
            self._decision_requested = False
            self._command_event.set()
            return

        if command.action == "approve_push":
            if not self._approval_requested:
                await self._send_message("warning", "Approval ignored: remediation is not waiting for final approval.")
                return
            self._pending_action = "approve_push"
            self._approval_requested = False
            self._command_event.set()

    async def _run_pipeline(self) -> bool:
        set_current_project_id(self.context.project_id)
        await self._send_message("phase", "Initializing remediation pipeline")

        approved_for_push = False
        current_round = 1

        while current_round <= MAX_ROUNDS:
            await self._send_message("phase", f"Round {current_round}: ingesting findings and generating fixes")

            try:
                snapshot = self.orchestrator.refresh(
                    self.context.project_id,
                    remediation_scope=self.context.remediation_scope,
                )
            except Exception as exc:
                return await self._terminate(f"Failed to refresh remediation inputs: {exc}")
            await self._send_message(
                "info",
                (
                    f"Loaded {snapshot.get('vulnerabilities', 0)} vulnerabilities across {snapshot.get('groups', 0)} file groups "
                    f"(critical={snapshot.get('critical', 0)}, high={snapshot.get('high', 0)}, "
                    f"medium={snapshot.get('medium', 0)}, low={snapshot.get('low', 0)})."
                ),
            )
            if snapshot.get("strategy_mode") == "major_complete":
                await self._send_message(
                    "success",
                    "Critical and high findings are already cleared. Stopping remediation before medium/low severities.",
                )
                return True
            if snapshot.get("strategy_mode") in {"critical_only", "high_only"}:
                stage = str(snapshot.get("selected_severity") or "major").upper()
                reason = "Large repository mode active" if snapshot.get("strategy_reason") == "large_repo" else "Major-only remediation scope active"
                await self._send_message(
                    "phase",
                    (
                        f"{reason}: processing {stage} findings only "
                        f"({snapshot.get('selected_findings', 0)} finding(s) across {snapshot.get('selected_groups', 0)} file group(s))."
                    ),
                )
            if snapshot.get("force_claude"):
                claude_model = (
                    self.context.llm_model
                    or os.getenv("REMEDIATION_CLAUDE_MODEL", "").strip()
                    or os.getenv("CLAUDE_MODEL", "").strip()
                    or "claude-sonnet-4-5"
                )
                await self._send_message("info", f"Using Claude SDK for the active staged run ({claude_model}).")

            fix_events: list = []

            def on_fix(fix):
                fix_events.append(fix)

            async def on_progress(msg_type: str, content: str):
                await self._send_message(msg_type, content)

            try:
                fixes = await self.orchestrator.run(
                    self.context.project_id,
                    on_fix=on_fix,
                    on_progress=on_progress,
                    remediation_scope=self.context.remediation_scope,
                    llm_provider=self.context.llm_provider,
                    llm_api_key=self.context.llm_api_key,
                    llm_model=self.context.llm_model,
                    force_claude=bool(snapshot.get("force_claude")),
                )
            except Exception as exc:
                return await self._terminate(f"Remediation pipeline execution failed: {type(exc).__name__}: {exc}")
            self._latest_fixes = fixes

            for fix in fix_events:
                if fix.diff:
                    await self._send_message("info", f"Updated {fix.filepath}")
                if fix.status == "needs_review":
                    await self._send_message("warning", f"{fix.filepath} flagged for manual review")
                    if not fix.diff and fix.warnings:
                        await self._send_message("warning", f"{fix.filepath}: {fix.warnings[0]}")
                else:
                    await self._send_message("success", f"Validated fix for {fix.filepath}")

            if not fixes:
                await self._send_message(
                    "warning",
                    "No candidate fixes were generated. Current scan artifacts may have no actionable vulnerabilities.",
                )
                return True

            actionable_fixes = [fix for fix in fixes if fix.diff]
            if not actionable_fixes:
                reasons: list[str] = []
                for fix in fixes:
                    for warning in fix.warnings:
                        if warning not in reasons:
                            reasons.append(warning)
                if reasons:
                    await self._send_message("warning", f"No patchable unified diff was produced. Primary reason: {reasons[0]}")
                else:
                    await self._send_message("warning", "No patchable unified diff was produced by the remediation pipeline.")
                return True

            changed = [
                {
                    "path": fix.filepath,
                    "reason": f"status={fix.status}",
                    "diff": fix.diff,
                }
                for fix in actionable_fixes
            ]
            await self._send_message("changed_files", json.dumps(changed))

            auto_count = sum(1 for fix in fixes if fix.status == "auto")
            review_count = sum(1 for fix in fixes if fix.status == "needs_review")
            await self._send_message(
                "success",
                f"Round {current_round} complete: {auto_count} auto, {review_count} needs review.",
            )

            self._decision_requested = True
            await self._send_status(StreamStatus.waiting_decision)
            action = await self._wait_for_action()

            if action == "continue_round":
                if current_round >= MAX_ROUNDS:
                    await self._send_message("warning", "Maximum remediation rounds reached; continuing with current fixes.")
                    approved_for_push = True
                    break
                current_round += 1
                continue

            approved_for_push = True
            break

        if not approved_for_push:
            return True

        self._approval_requested = True
        await self._send_status(StreamStatus.waiting_approval)
        action = await self._wait_for_action()
        if action != "approve_push":
            await self._send_message("error", "Final approval was not provided.")
            return False

        if self.context.project_type != "github":
            await self._send_message("success", "Remediation completed for local project. PR creation is skipped.")
            return True

        github_token = (self.context.github_token or "").strip()
        repository_url = (self.context.repository_url or "").strip()
        if not github_token or not repository_url:
            await self._send_message("warning", "Missing GitHub token or repository URL. Skipping PR creation.")
            return True

        candidate_fixes = [fix for fix in self._latest_fixes if fix.diff]
        accepted_paths = [fix.filepath for fix in candidate_fixes if fix.status == "auto"]
        if not accepted_paths:
            accepted_paths = [fix.filepath for fix in candidate_fixes]

        try:
            pr = self.orchestrator.create_pr(
                RemediationPRRequest(
                    project_id=self.context.project_id,
                    repository_url=repository_url,
                    github_token=github_token,
                    fixes=candidate_fixes,
                    accepted_filepaths=accepted_paths,
                )
            )
            if pr.success:
                await self._send_message("success", f"PR created: {pr.pr_url}")
            else:
                await self._send_message("warning", pr.message)
        except Exception as exc:
            await self._send_message("warning", f"PR creation failed: {exc}")

        return True

    async def _wait_for_action(self) -> str:
        self._pending_action = None
        self._command_event.clear()
        await self._command_event.wait()
        return self._pending_action or ""
