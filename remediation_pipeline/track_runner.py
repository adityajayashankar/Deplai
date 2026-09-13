from __future__ import annotations

import asyncio
import json
import os

from fastapi import WebSocket

from models import RemediationRequest, StreamStatus, WebSocketCommand
from remediation_pipeline.models import Fix, RemediationPRRequest
from remediation_pipeline.orchestrator import RemediationOrchestrator
from remediation_pipeline.remediation_store import bind_remediation_run, remediation_runs
from runner_base import RunnerBase
from utils import set_current_project_id


MAX_ROUNDS = 24  # Each additional slice is an explicit user decision.
TOTAL_STEPS = 8


class RemediationTrackRunner(RunnerBase):
    """WebSocket runner that executes the remediation pipeline inside the security track."""

    def __init__(self, websocket: WebSocket, context: RemediationRequest, orchestrator: RemediationOrchestrator):
        super().__init__(websocket, TOTAL_STEPS)
        self.context = context
        self.original_project_id = context.project_id
        self.orchestrator = orchestrator
        self.remediation_run_id = str(context.remediation_run_id or "")
        self._command_event = asyncio.Event()
        self._pending_action: str | None = None
        self._decision_requested = False
        self._approval_requested = False
        self._latest_fixes: list[Fix] = []
        self._accepted_fixes: list[Fix] = []
        self.source_revision = None
        self.scan_id = None

    async def _send_message(self, msg_type: str, content: str):
        await super()._send_message(msg_type, content)
        await asyncio.to_thread(
            remediation_runs.append_event,
            self.remediation_run_id,
            project_id=self.original_project_id,
            message_type=msg_type,
            content=content,
            stage="remediation",
        )

    async def _send_status(self, status: StreamStatus):
        await super()._send_status(status)
        mapped = "failed" if status == StreamStatus.error else status.value
        await asyncio.to_thread(remediation_runs.mark_status, self.remediation_run_id, mapped)

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

    async def _await_verification(self, label, operation, interval=15):
        started = asyncio.get_running_loop().time()
        task = asyncio.create_task(self._run_step(operation))
        try:
            while not task.done():
                done, _ = await asyncio.wait({task}, timeout=interval)
                if not done:
                    elapsed = int(asyncio.get_running_loop().time() - started)
                    await self._send_message('info', f'Verification: {label} result is pending ({elapsed}s elapsed). PR creation will follow verification.')
            return await task
        finally:
            if not task.done():
                task.cancel()

    async def _run_verification_rescan(self) -> bool:
        from result_parser import invalidate_cache, get_scan_results
        from environment import EnvironmentInitializer
        from models import ScanContext
        from bearer import run_bearer_scan
        from sbom import run_syft_scan, run_grype_scan
        from secrets_scan import run_secrets_scan
        from iac_scan import run_iac_scan, run_container_scan, run_kubernetes_scan, run_cicd_scan, run_api_scan
        from sdlc_pipeline import engine_for

        project = self.context.project_id
        name = self.context.project_name
        ok, before = await self._run_step(lambda: get_scan_results(project))
        if not ok:
            return await self._terminate("Baseline findings unavailable for verification")
        validator = EnvironmentInitializer(self.websocket, ScanContext(project_id=project, project_name=name,
            project_type=self.context.project_type, user_id=self.context.user_id))
        steps = {"sast": run_bearer_scan, "sbom": run_syft_scan, "sca": run_grype_scan,
            "secrets": run_secrets_scan, "iac": run_iac_scan, "containers": run_container_scan,
            "kubernetes": run_kubernetes_scan, "cicd": run_cicd_scan, "api": run_api_scan}
        records = []
        sbom_ok = False
        for module, scanner in steps.items():
            try:
                if module == "sca" and not sbom_ok:
                    raise RuntimeError("Syft dependency failed")
                await self._send_message("info", f"Verification: executing {engine_for(module)}")
                success, detail = await self._await_verification(engine_for(module), lambda: scanner(name, project))
                if not success:
                    raise RuntimeError(detail)
                report = await self._run_step(lambda: validator._validated_report(module))
                if module == "sbom":
                    sbom_ok = True
                records.append({"id": module, "status": "SKIPPED" if report.get("coverage") == "not_applicable" else "COMPLETED", **report})
                await self._send_message('info', f'Verification: {engine_for(module)} finished ({report.get("coverage", "validated report")}).')
            except Exception as exc:
                records.append({"id": module, "status": "FAILED", "error": str(exc)})
                await self._send_message("warning", f"Verification {engine_for(module)} failed: {exc}")
        validator.source_revision = self.source_revision
        await self._run_step(lambda: validator._write_pipeline_summary(records))
        invalidate_cache(project)
        ok, after = await self._run_step(lambda: get_scan_results(project))
        if not ok:
            return await self._terminate("Verification results could not be parsed")
        def identity(finding):
            return (finding.get("category"), finding.get("title"), finding.get("asset"))
        remaining = {identity(finding) for finding in after.get("findings", [])}
        passed = {r["id"] for r in records if r["status"] == "COMPLETED" and r.get("coverage") == "evaluated"}
        outcomes = []
        for finding in before.get("findings", []):
            status = "unverified"
            if finding.get("remediation_capability") == "manual_action":
                status = "manual_action"
            elif finding.get("category") == "sca":
                # A manifest rescan alone cannot establish the resolved dependency
                # graph. Keep this unverified until package-manager regeneration
                # and repository behavior validation have both been recorded.
                status = "unresolved" if identity(finding) in remaining else "unverified"
            elif finding.get("category") in passed:
                status = "unresolved" if identity(finding) in remaining else "verified_fixed"
            outcomes.append({"id": finding["id"], "status": status})
        await self._send_message("verification_results", json.dumps({"findings": outcomes, "modules": records}))
        by_id = {item["id"]: item["status"] for item in outcomes}
        for fix in self._accepted_fixes:
            statuses = [by_id.get(finding_id, "unverified") for finding_id in fix.vulns_addressed]
            fix.verification_status = "verified_fixed" if statuses and all(status == "verified_fixed" for status in statuses) else "unverified"
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
            await self._send_status(StreamStatus.running)
            await self._send_message("info", "Approval received. Assembling patches and running verification before PR creation.")
            self._command_event.set()

    async def _run_pipeline(self) -> bool:
        if self.context.resume_publication:
            return await self._resume_publication()
        # Never apply candidate fixes to the checkout used by Scan or deployment.
        from utils import CODEBASE_VOLUME, SECURITY_REPORTS_VOLUME, get_docker_client
        workspace_id = "remediation_" + self.remediation_run_id.replace("-", "")
        if not self.remediation_run_id:
            return await self._terminate("Remediation requires a persisted run id.")
        from result_parser import get_scan_results
        ok, initial = await self._run_step(lambda: get_scan_results(self.original_project_id))
        if not ok or not isinstance(initial, dict):
            return await self._terminate("A completed scan baseline is required.")
        baseline_run = initial.get("run_id")
        self.scan_id = baseline_run
        baseline_source = "scan_" + baseline_run if baseline_run else self.original_project_id
        self.source_revision = initial.get("source_revision")
        await asyncio.to_thread(remediation_runs.packet_result, self.remediation_run_id, "publication-base", {
            "source_revision": self.source_revision, "baseline_source": baseline_source, "scan_id": self.scan_id})
        def prepare_workspace():
            get_docker_client().containers.run("alpine", command=["sh", "-ec",
                'test -d "/code/$SOURCE"; mkdir "/code/$TARGET"; cp -a "/code/$SOURCE/." "/code/$TARGET/"; '
                'for file in /reports/*_${REPORT_SOURCE}_*.json; do [ ! -f "$file" ] || cp "$file" "/reports/$(basename "$file" | sed "s/_${REPORT_SOURCE}_/_${TARGET}_/")"; done'],
                environment={"SOURCE": baseline_source, "REPORT_SOURCE": self.original_project_id, "TARGET": workspace_id},
                volumes={CODEBASE_VOLUME: {"bind": "/code", "mode": "rw"},
                         SECURITY_REPORTS_VOLUME: {"bind": "/reports", "mode": "rw"}}, remove=True)
        try:
            await self._run_step(prepare_workspace)
        except Exception as exc:
            return await self._terminate(f"Cannot prepare isolated remediation checkout: {exc}")
        self.context = self.context.model_copy(update={"project_id": workspace_id})
        set_current_project_id(self.context.project_id)
        bind_remediation_run(self.remediation_run_id)
        await asyncio.to_thread(remediation_runs.mark_status, self.remediation_run_id, "running")
        await self._send_message("phase", "Initializing remediation pipeline")

        approved_for_push = False
        current_round = 1

        while current_round <= MAX_ROUNDS:
            await self._send_message("phase", f"Round {current_round}: ingesting findings and generating fixes")
            await self._send_message(
                "info",
                "Selected findings go through source exploration, planning, patch generation and local validation, with one repair attempt after actionable validation failure.",
            )

            try:
                snapshot = await asyncio.get_running_loop().run_in_executor(
                    None,
                    lambda: self.orchestrator.refresh(
                        self.context.project_id,
                        remediation_scope="major",
                    ),
                )
            except Exception as exc:
                return await self._terminate(f"Failed to refresh remediation inputs: {exc}")
            await self._send_message(
                "info",
                (
                    f"Loaded {snapshot.get('raw_vulnerabilities', snapshot.get('vulnerabilities', 0))} scanner findings; "
                    f"{snapshot.get('noise_filtered', 0)} filtered as noise; "
                    f"{snapshot.get('scope_filtered', 0)} skipped (medium/low); "
                    f"{snapshot.get('vulnerabilities', 0)} critical/high actionable across {snapshot.get('groups', 0)} file groups "
                    f"(critical={snapshot.get('critical', 0)}, high={snapshot.get('high', 0)}, "
                    f"medium={snapshot.get('medium', 0)}, low={snapshot.get('low', 0)})."
                ),
            )
            if snapshot.get("raw_vulnerabilities", snapshot.get("vulnerabilities", 0)) == 0:
                await self._send_message(
                    "warning",
                    "No scanner artifacts were found for this project. Run a security scan first, then retry remediation.",
                )
                return await self._terminate("No scan results available for remediation.")

            if int(snapshot.get("vulnerabilities", 0) or 0) == 0:
                await self._send_message(
                    "success",
                    (
                        f"Noise triage filtered all {snapshot.get('noise_filtered', 0)} scanner finding(s) "
                        "as non-actionable. No remediation credits were spent."
                    ),
                )
                return True

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
            if snapshot.get("force_claude") and str(getattr(self.context, "llm_access_mode", "auto") or "auto").lower() not in {"platform", "byok"}:
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
                    remediation_scope="major",
                    llm_provider=self.context.llm_provider,
                    llm_api_key=self.context.llm_api_key,
                    llm_model=self.context.llm_model,
                    force_claude=bool(snapshot.get("force_claude")) and str(getattr(self.context, "llm_access_mode", "auto") or "auto").lower() not in {"platform", "byok"},
                    user_id=getattr(self.context, "user_id", None),
                    organization_id=getattr(self.context, "organization_id", None),
                    access_mode=getattr(self.context, "llm_access_mode", None),
                    llm_credential_id=getattr(self.context, "llm_credential_id", None),
                    remediation_run_id=self.remediation_run_id,
                )
            except Exception as exc:
                if any(marker in str(exc).lower() for marker in ("rate_limit", "rate limit", "quota", "http 429")):
                    await self._send_message("warning", f"Remediation paused: {exc}. Resume when capacity resets; previous work is retained.")
                    self._decision_requested = True
                    await self._send_status(StreamStatus.waiting_decision)
                    action = await self._wait_for_action()
                    if action == "continue_round":
                        continue
                return await self._terminate(f"Remediation pipeline execution failed: {type(exc).__name__}: {exc}")
            self._latest_fixes = fixes

            for fix in fix_events:
                if fix.diff:
                    await self._send_message("info", f"Proposed patch for {fix.filepath}")
                if fix.status == "needs_review":
                    await self._send_message("warning", f"{fix.filepath} flagged for manual review")
                    if not fix.diff and fix.warnings:
                        await self._send_message("warning", f"{fix.filepath}: {fix.warnings[0]}")
                else:
                    await self._send_message("info", f"Local patch review passed for {fix.filepath}; security verification is pending")

            if not fixes:
                if self._accepted_fixes:
                    await self._send_message(
                        "warning",
                        "No additional candidate fixes were generated. Continuing with previously accepted fixes.",
                    )
                    approved_for_push = True
                    break
                return await self._terminate(
                    "No patches were produced for this execution slice. Selected findings remain unresolved or require manual action."
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
                    "reason": f"{fix.provider_used} · {fix.status}"
                    + (f" · {fix.warnings[0][:120]}" if fix.warnings else ""),
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

        return await self._publish_saved_fixes()

    async def _resume_publication(self) -> bool:
        """Restore candidates, never invoke the remediation/model workflow."""
        from remediation_pipeline.supervisor_bridge import supervisor_result_to_fixes
        from result_parser import get_scan_results
        from utils import CODEBASE_VOLUME, SECURITY_REPORTS_VOLUME, get_docker_client
        from uuid import uuid4
        archive = await asyncio.to_thread(remediation_runs.archive_for_run, self.remediation_run_id,
            project_id=self.original_project_id, user_id=self.context.user_id,
            organization_id=self.context.organization_id)
        if not archive:
            return await self._terminate("Saved run is unavailable. No new remediation was started.")
        saved = await asyncio.to_thread(remediation_runs.packet_result, self.remediation_run_id, "publication-review")
        if saved:
            self._latest_fixes = [Fix(**item) for item in saved.get("fixes", [])]
        else:
            self._latest_fixes = [fix for packet in archive['packets']
                for fix in supervisor_result_to_fixes(packet['result'])]
        if not self._latest_fixes:
            return await self._terminate("No saved patch candidates are available for publication recovery.")
        base = await asyncio.to_thread(remediation_runs.packet_result, self.remediation_run_id, "publication-base")
        if not base:
            ok, initial = await self._run_step(lambda: get_scan_results(self.original_project_id))
            if not ok or not initial.get('run_id') or not initial.get('source_revision'):
                return await self._terminate("Saved source baseline is unavailable; recovery cannot safely validate these patches.")
            base = {'baseline_source': 'scan_' + initial['run_id'], 'source_revision': initial['source_revision']}
        self.source_revision = base['source_revision']
        self.scan_id = base.get('scan_id') or (base['baseline_source'][5:] if base.get('baseline_source', '').startswith('scan_') else None)
        workspace = 'remediation_recovery_' + uuid4().hex
        def prepare():
            get_docker_client().containers.run('alpine', command=['sh','-ec',
                'test -d "/code/$SOURCE"; mkdir "/code/$TARGET"; cp -a "/code/$SOURCE/." "/code/$TARGET/"; '
                'for file in /reports/*_${REPORT_SOURCE}_*.json; do [ ! -f "$file" ] || cp "$file" "/reports/$(basename "$file" | sed "s/_${REPORT_SOURCE}_/_${TARGET}_/")"; done'],
                environment={'SOURCE':base['baseline_source'],'TARGET':workspace,'REPORT_SOURCE':self.original_project_id},
                volumes={CODEBASE_VOLUME:{'bind':'/code','mode':'rw'},SECURITY_REPORTS_VOLUME:{'bind':'/reports','mode':'rw'}},remove=True)
        await self._run_step(prepare)
        self.context = self.context.model_copy(update={'project_id':workspace})
        set_current_project_id(workspace)
        bind_remediation_run(self.remediation_run_id)
        await self._send_message('info', 'Restored saved patches. No initial scan or model generation was started. Approval will run required patch verification before publication.')
        return await self._publish_saved_fixes()

    async def _prepare_publication_review(self) -> bool:
        """Assemble each file before approval; make exclusions explicit."""
        import difflib
        grouped = self.orchestrator._group_fixes_by_file(self._latest_fixes)
        prepared = []
        excluded = []
        for path, fixes in grouped.items():
            try:
                source = await self._run_step(lambda: self.orchestrator.validator._read_repo_file(self.context.project_id, path))
                combined = self.orchestrator._build_patched_files(fixes, lambda _: source)[path]
                diff = ''.join(difflib.unified_diff(source.replace('\r\n','\n').splitlines(keepends=True), combined.splitlines(keepends=True), fromfile='a/'+path,tofile='b/'+path))
                if diff:
                    prepared.append(fixes[0].model_copy(update={'diff':diff,'raw_response':None,
                        'vulns_addressed':list(dict.fromkeys(v for f in fixes for v in f.vulns_addressed))}))
            except (RuntimeError, ValueError):
                excluded.append(path)
        await asyncio.to_thread(remediation_runs.packet_result, self.remediation_run_id, 'publication-review',
            {'fixes':[fix.model_dump(exclude={'raw_response'}) for fix in [*self._accepted_fixes, *self._latest_fixes]], 'excluded_files':excluded})
        if excluded:
            await self._send_message('warning', 'Excluded conflicting files from this proposed PR: ' + ', '.join(excluded) + '. Their findings remain unresolved. Review the reduced patch set before approving.')
        self._latest_fixes = prepared
        await self._send_message('changed_files', json.dumps([{'path':f.filepath,'diff':f.diff,'reason':'Combined patch ready for review; verification pending'} for f in prepared]))
        if not prepared:
            return await self._terminate('All saved files are blocked by patch conflicts. Candidates are retained; no scan or generation is required to inspect them in Sessions.')
        return True

    async def _publish_saved_fixes(self) -> bool:
        if not await self._prepare_publication_review():
            return False
        self._approval_requested = True
        await self._send_status(StreamStatus.waiting_approval)
        action = await self._wait_for_action()
        if action != "approve_push":
            await self._send_message("error", "Final approval was not provided.")
            return False
        await self._send_status(StreamStatus.running)
        await self._send_message(
            "success",
            "Final approval received. Persisting approved remediation changes.",
        )

        candidate_fixes = [fix for fix in self._latest_fixes if fix.diff]
        pending_keys = {(fix.filepath, fix.diff) for fix in self._accepted_fixes}
        pending_fixes = [fix for fix in candidate_fixes if (fix.filepath, fix.diff) not in pending_keys]
        if pending_fixes and not await self._apply_fixes_to_volume(pending_fixes, "final approval"):
            return False
        if not await self._run_verification_rescan():
            return False

        accepted_fixes = list(self._accepted_fixes)
        accepted_paths = [fix.filepath for fix in accepted_fixes]
        if not accepted_fixes:
            return await self._terminate("No approved remediation fixes were available to persist.")

        if self.context.project_type != "github":
            await self._send_message("patch_download", json.dumps({
                "filename": f"security-{self.remediation_run_id}.patch",
                "patch": "\n".join(fix.diff for fix in accepted_fixes),
            }))
            await self._send_message("success", "Remediation persisted. Patches are ready to download and review; verification evidence is recorded separately.")
            return True

        github_token = (self.context.github_token or "").strip()
        repository_url = (self.context.repository_url or "").strip()
        if not github_token or not repository_url:
            return await self._terminate("Pull request creation is blocked: reconnect the GitHub App with repository contents and pull-request write permissions. Saved patches remain available.")

        try:
            await self._send_message('info', 'Publishing approved patches to GitHub and creating the pull request.')
            pr = await self._run_step(
                lambda: self.orchestrator.create_pr(
                    RemediationPRRequest(
                        project_id=self.context.project_id,
                        source_revision=self.source_revision,
                        scan_id=self.scan_id,
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
                return await self._terminate(f"Pull request was not created: {pr.message}")
        except Exception as exc:
            return await self._terminate(f"Pull request creation failed: {type(exc).__name__}. Saved patches remain available; check the GitHub connection and repository permissions.")

        await self._send_message(
            "success",
            "Remediation persisted. Verification scan is optional; rerun it from Security Agent after the PR is ready.",
        )
        return True

    async def _wait_for_action(self) -> str:
        if self._pending_action is None:
            self._command_event.clear()
            await self._command_event.wait()
        action = self._pending_action or ""
        self._pending_action = None
        self._command_event.clear()
        return action
