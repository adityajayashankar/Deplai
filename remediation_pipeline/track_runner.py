from __future__ import annotations

import asyncio
import json
import os

from fastapi import WebSocket

from models import RemediationRequest, StreamStatus, WebSocketCommand
from remediation_pipeline.models import Fix, RemediationPRRequest
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
        self._latest_fixes: list[Fix] = []
        self._accepted_fixes: list[Fix] = []

    @staticmethod
    def _accepted_filepaths(fixes: list[Fix]) -> list[str]:
        accepted = [fix.filepath for fix in fixes if fix.diff and fix.status == "auto"]
        if not accepted:
            accepted = [fix.filepath for fix in fixes if fix.diff]
        return accepted

    @staticmethod
    def _select_fixes(fixes: list[Fix], accepted_filepaths: list[str]) -> list[Fix]:
        accepted = set(accepted_filepaths)
        return [fix for fix in fixes if fix.diff and (not accepted or fix.filepath in accepted)]

    def _remember_accepted_fixes(self, fixes: list[Fix]) -> None:
        seen = {(fix.filepath, fix.diff) for fix in self._accepted_fixes}
        for fix in fixes:
            key = (fix.filepath, fix.diff)
            if key in seen:
                continue
            self._accepted_fixes.append(fix)
            seen.add(key)

    async def _apply_fixes_to_volume(self, fixes: list[Fix], purpose: str) -> bool:
        candidate_fixes = [fix for fix in fixes if fix.diff]
        accepted_paths = self._accepted_filepaths(candidate_fixes)
        selected_fixes = self._select_fixes(candidate_fixes, accepted_paths)
        if not selected_fixes:
            await self._send_message("warning", f"No approved patchable fixes were available to apply for {purpose}.")
            return False

        try:
            updated_files = await self._run_step(
                lambda: self.orchestrator.apply_fixes_to_volume(
                    project_id=self.context.project_id,
                    fixes=candidate_fixes,
                    accepted_filepaths=accepted_paths,
                )
            )
        except Exception as exc:
            await self._terminate(f"Failed to apply remediation fixes to the working tree for {purpose}: {exc}")
            return False

        if not updated_files:
            await self._send_message("warning", f"No files were updated while applying fixes for {purpose}.")
            return False

        self._remember_accepted_fixes(selected_fixes)
        await self._send_message(
            "success",
            f"Applied {len(updated_files)} file(s) to the remediation working tree for {purpose}.",
        )
        return True

    async def _run_verification_rescan(self) -> bool:
        from bearer import run_bearer_scan
        from result_parser import invalidate_cache
        from sbom import run_grype_scan, run_syft_scan

        await self._send_message("phase", "Running verification security scan")
        await self._run_step(lambda: invalidate_cache(self.context.project_id))

        scan_steps = [
            ("Bearer", lambda: run_bearer_scan(self.context.project_name, self.context.project_id)),
            ("Syft", lambda: run_syft_scan(self.context.project_name, self.context.project_id)),
            ("Grype", lambda: run_grype_scan(self.context.project_name, self.context.project_id)),
        ]
        for label, scan_step in scan_steps:
            ok, message = await self._run_step(scan_step)
            if not ok:
                return await self._terminate(f"{label} verification scan failed: {message}")
            await self._send_message("success", f"{label} verification scan completed.")

        await self._run_step(lambda: invalidate_cache(self.context.project_id))
        try:
            snapshot = await self._run_step(
                lambda: self.orchestrator.refresh(
                    self.context.project_id,
                    remediation_scope=self.context.remediation_scope,
                )
            )
            await self._send_message(
                "success",
                (
                    "Verification scan refreshed results "
                    f"(critical={snapshot.get('critical', 0)}, high={snapshot.get('high', 0)}, "
                    f"medium={snapshot.get('medium', 0)}, low={snapshot.get('low', 0)})."
                ),
            )
        except Exception as exc:
            return await self._terminate(f"Verification scan completed, but refreshed results could not be loaded: {exc}")

        return True

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
                if self._accepted_fixes:
                    approved_for_push = True
                    break
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
                if self._accepted_fixes:
                    await self._send_message(
                        "warning",
                        "No additional candidate fixes were generated. Continuing with previously accepted fixes.",
                    )
                    approved_for_push = True
                    break
                return await self._terminate(
                    "No candidate fixes were generated for the selected large-repository slice. "
                    "The run stopped without changes instead of opening an empty approval gate."
                )

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
                if self._accepted_fixes:
                    approved_for_push = True
                    break
                return await self._terminate(
                    "The remediation model did not return any patchable unified diffs for the selected slice. "
                    "No files were changed, so the approval step was not opened."
                )

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
            await self._send_status(StreamStatus.running)

            if action == "continue_round":
                if current_round >= MAX_ROUNDS:
                    await self._send_message("warning", "Maximum remediation rounds reached; continuing with current fixes.")
                    approved_for_push = True
                    break
                if not await self._apply_fixes_to_volume(actionable_fixes, f"round {current_round} continuation"):
                    return False
                if not await self._run_verification_rescan():
                    return False
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
        await self._send_status(StreamStatus.running)
        await self._send_message(
            "success",
            "Final approval received. Persisting approved remediation changes and running verification.",
        )

        candidate_fixes = [fix for fix in self._latest_fixes if fix.diff]
        pending_keys = {(fix.filepath, fix.diff) for fix in self._accepted_fixes}
        pending_fixes = [fix for fix in candidate_fixes if (fix.filepath, fix.diff) not in pending_keys]
        if pending_fixes and not await self._apply_fixes_to_volume(pending_fixes, "final approval"):
            return False

        accepted_fixes = list(self._accepted_fixes)
        accepted_paths = [fix.filepath for fix in accepted_fixes]
        if not accepted_fixes:
            return await self._terminate("No approved remediation fixes were available to persist.")

        if self.context.project_type != "github":
            try:
                await self._run_step(
                    lambda: self.orchestrator.sync_project_volume_to_local_host(
                        self.context.project_id,
                        self.context.user_id,
                    )
                )
                await self._send_message("success", "Remediation changes persisted locally.")
            except Exception as exc:
                return await self._terminate(f"Failed to persist local remediation changes: {exc}")
            return await self._run_verification_rescan()

        github_token = (self.context.github_token or "").strip()
        repository_url = (self.context.repository_url or "").strip()
        if not github_token or not repository_url:
            await self._send_message("warning", "Missing GitHub token or repository URL. Skipping PR creation.")
            return await self._run_verification_rescan()

        try:
            pr = await self._run_step(
                lambda: self.orchestrator.create_pr(
                    RemediationPRRequest(
                        project_id=self.context.project_id,
                        repository_url=repository_url,
                        github_token=github_token,
                        fixes=accepted_fixes,
                        accepted_filepaths=accepted_paths,
                    )
                )
            )
            if pr.success:
                await self._send_message("success", f"Remediation PR created: {pr.pr_url}")
            else:
                await self._send_message("warning", pr.message)
        except Exception as exc:
            await self._send_message("warning", f"PR creation failed: {exc}")

        return await self._run_verification_rescan()

    async def _wait_for_action(self) -> str:
        self._pending_action = None
        self._command_event.clear()
        await self._command_event.wait()
        return self._pending_action or ""
