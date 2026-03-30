"""Remediation orchestration with Claude code fixes and approval-gated rescans."""

import asyncio
import base64
import json
import os
import shlex
import time
from collections import deque
from urllib import error as urlerror
from urllib import request as urlrequest
from functools import partial

from fastapi import WebSocket

from agent import run_analysis_agent, run_remediation_supervisor
from Analysis.dataingestor import get_scan_results
from bearer import run_bearer_scan
from claude_remediator import run_claude_remediation  # kept as fallback
from models import RemediationRequest, StreamStatus, WebSocketCommand
from result_parser import invalidate_cache
from runner_base import RunnerBase
from sbom import run_grype_scan, run_syft_scan
from utils import CODEBASE_VOLUME, LLM_OUTPUT_VOLUME, decode_output, get_docker_client, redact_git_token, resolve_host_projects_dir, set_current_project_id

TOTAL_STEPS = 15
MAX_REMEDIATION_CYCLES = 2
REMEDIATION_BATCH_ENABLED = os.getenv("REMEDIATION_BATCH_ENABLED", "true").strip().lower() == "true"
REMEDIATION_BATCH_CODE_FINDINGS = int(os.getenv("REMEDIATION_BATCH_CODE_FINDINGS", "8"))
REMEDIATION_BATCH_SUPPLY_FINDINGS = int(os.getenv("REMEDIATION_BATCH_SUPPLY_FINDINGS", "16"))
REMEDIATION_MAX_BATCHES_PER_CYCLE = int(os.getenv("REMEDIATION_MAX_BATCHES_PER_CYCLE", "20"))
REMEDIATION_NO_PROGRESS_LIMIT = int(os.getenv("REMEDIATION_NO_PROGRESS_LIMIT", "2"))
REMEDIATION_MAX_FAILED_BATCHES = int(os.getenv("REMEDIATION_MAX_FAILED_BATCHES", "4"))
REMEDIATION_MAX_STALLED_BATCHES = int(os.getenv("REMEDIATION_MAX_STALLED_BATCHES", "8"))

SEVERITY_ORDER = ("critical", "high", "medium", "low")
MAJOR_SEVERITIES = {"critical", "high"}
ALL_SEVERITIES = set(SEVERITY_ORDER)


def _severity_rank(sev: str) -> int:
    value = (sev or "").strip().lower()
    if value == "critical":
        return 4
    if value == "high":
        return 3
    if value == "medium":
        return 2
    if value == "low":
        return 1
    return 0


def _severity_for_scope(scope: str) -> set[str]:
    if scope == "major":
        return MAJOR_SEVERITIES
    return ALL_SEVERITIES


def _iter_by_severity(findings: list[dict], allowed_severity: set[str]) -> list[dict]:
    out: list[dict] = []
    for sev in SEVERITY_ORDER:
        if sev not in allowed_severity:
            continue
        bucket = [
            f for f in findings
            if str((f or {}).get("severity", "")).strip().lower() == sev
        ]
        # Preserve deterministic order inside same severity
        bucket.sort(
            key=lambda f: (
                -int((f or {}).get("count", 1) or 1),
                str((f or {}).get("cwe_id") or (f or {}).get("cve_id") or ""),
            )
        )
        out.extend(bucket)
    return out


def _chunk_findings(findings: list[dict], chunk_size: int) -> list[list[dict]]:
    if not findings:
        return []
    size = max(1, int(chunk_size or 1))
    return [findings[i:i + size] for i in range(0, len(findings), size)]


def _build_remediation_queue(scan_data: dict, scope: str) -> tuple[list[dict], dict]:
    """Build micro-batches that can cover large finding sets safely.

    Each batch carries a bounded subset of code and supply findings, ordered by
    severity, so prompt size stays tractable while allowing multi-batch progress.
    """
    code_all = list(scan_data.get("code_security", []) or [])
    supply_all = list(scan_data.get("supply_chain", []) or [])
    allowed_severity = _severity_for_scope(scope)

    code_filtered = _iter_by_severity(code_all, allowed_severity)
    supply_filtered = _iter_by_severity(supply_all, allowed_severity)

    # Fallback for malformed/no-severity findings in all-scope runs.
    if scope == "all":
        if not code_filtered and code_all:
            code_filtered = code_all
        if not supply_filtered and supply_all:
            supply_filtered = supply_all

    if not REMEDIATION_BATCH_ENABLED:
        batch = dict(scan_data)
        batch["code_security"] = code_filtered
        batch["supply_chain"] = supply_filtered
        return [batch], {
            "scope": scope,
            "enabled": False,
            "code_total": len(code_filtered),
            "supply_total": len(supply_filtered),
            "queue_size": 1,
        }

    code_chunks = _chunk_findings(code_filtered, REMEDIATION_BATCH_CODE_FINDINGS)
    supply_chunks = _chunk_findings(supply_filtered, REMEDIATION_BATCH_SUPPLY_FINDINGS)
    queue_size = max(len(code_chunks), len(supply_chunks), 1)

    queue: list[dict] = []
    for idx in range(queue_size):
        batch = dict(scan_data)
        batch["code_security"] = code_chunks[idx] if idx < len(code_chunks) else []
        batch["supply_chain"] = supply_chunks[idx] if idx < len(supply_chunks) else []
        queue.append(batch)

    return queue, {
        "scope": scope,
        "enabled": True,
        "code_total": len(code_filtered),
        "supply_total": len(supply_filtered),
        "queue_size": len(queue),
        "code_chunk_size": max(1, REMEDIATION_BATCH_CODE_FINDINGS),
        "supply_chunk_size": max(1, REMEDIATION_BATCH_SUPPLY_FINDINGS),
    }


class RemediationRunner(RunnerBase):
    """Orchestrates Claude remediation, persistence, and approval-gated rescans."""

    def __init__(self, websocket: WebSocket, remediation_context: RemediationRequest):
        super().__init__(websocket, TOTAL_STEPS)
        self.context = remediation_context
        self.project_id = remediation_context.project_id
        self._docker = get_docker_client()
        self._approval_event = asyncio.Event()
        self._approval_requested = False
        self._last_pr_url: str | None = None

    async def handle_command(self, command: WebSocketCommand):
        if command.action != "approve_rescan":
            return
        if not self._approval_requested:
            await self._send_message("warning", "Approval ignored: remediation is not waiting for approval.")
            return
        if self._approval_event.is_set():
            return
        self._approval_event.set()
        await self._send_message("success", "Human approval received. Starting security re-scan.")

    def _ensure_output_volume(self) -> tuple[bool, str]:
        try:
            try:
                self._docker.volumes.get(LLM_OUTPUT_VOLUME)
            except Exception:
                self._docker.volumes.create(name=LLM_OUTPUT_VOLUME)
            return (True, "")
        except Exception as e:
            return (False, str(e))

    def _write_summary_file(self, content: str) -> tuple[bool, str]:
        try:
            encoded = base64.b64encode(content.encode("utf-8")).decode("ascii")
            self._docker.containers.run(
                "alpine",
                command=["sh", "-lc", f"echo {shlex.quote(encoded)} | base64 -d > /output/summary.txt"],
                volumes={LLM_OUTPUT_VOLUME: {"bind": "/output", "mode": "rw"}},
                remove=True,
            )
            return (True, "")
        except Exception as e:
            return (False, str(e))

    def _persist_local_changes(self) -> tuple[bool, str]:
        user_id = self.context.user_id
        project_id = self.context.project_id

        host_base = resolve_host_projects_dir()
        if host_base:
            host_path = os.path.join(host_base, user_id, project_id)
            check_path = os.path.join("/local-projects", user_id, project_id)
        else:
            host_path = os.path.abspath(
                os.path.join(
                    os.path.dirname(__file__), "..", "Connector", "tmp",
                    "local-projects", user_id, project_id,
                )
            )
            check_path = host_path

        if not os.path.isdir(check_path):
            return (False, f"Local project directory not found at {check_path}")

        try:
            self._docker.containers.run(
                "alpine",
                command=[
                    "sh", "-lc",
                    "mkdir -p /host && rm -rf /host/* /host/.[!.]* /host/..?* && cp -a /repo/${PID}/. /host/",
                ],
                environment={"PID": project_id},
                volumes={
                    CODEBASE_VOLUME: {"bind": "/repo", "mode": "rw"},
                    host_path: {"bind": "/host", "mode": "rw"},
                },
                remove=True,
            )
            return (True, "")
        except Exception as e:
            return (False, str(e))

    def _get_repo_default_branch(self, owner: str, repo: str, token: str) -> str | None:
        req = urlrequest.Request(
            f"https://api.github.com/repos/{owner}/{repo}",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "User-Agent": "deplai-agentic-layer",
            },
            method="GET",
        )
        try:
            with urlrequest.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                value = str(data.get("default_branch") or "").strip()
                return value or None
        except Exception:
            return None

    def _get_repo_branch_names(self, owner: str, repo: str, token: str) -> list[str]:
        req = urlrequest.Request(
            f"https://api.github.com/repos/{owner}/{repo}/branches?per_page=100",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "User-Agent": "deplai-agentic-layer",
            },
            method="GET",
        )
        try:
            with urlrequest.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                out: list[str] = []
                if isinstance(data, list):
                    for item in data:
                        name = str((item or {}).get("name") or "").strip()
                        if name:
                            out.append(name)
                return out
        except Exception:
            return []

    def _build_base_branch_candidates(
        self,
        owner: str,
        repo: str,
        token: str,
        preferred_base: str,
    ) -> list[str]:
        candidates: list[str] = []
        seen: set[str] = set()

        def _add(name: str | None):
            value = str(name or "").strip()
            if not value or value in seen:
                return
            seen.add(value)
            candidates.append(value)

        _add(preferred_base)
        _add(self._get_repo_default_branch(owner, repo, token))
        _add("main")
        _add("master")
        for branch in self._get_repo_branch_names(owner, repo, token):
            _add(branch)
            if len(candidates) >= 12:
                break
        return candidates

    def _create_pull_request(self, owner: str, repo: str, token: str, head_branch: str, base_branch: str) -> tuple[bool, str]:
        attempted: list[str] = []
        last_error = "Unknown error"

        for candidate_base in self._build_base_branch_candidates(owner, repo, token, base_branch):
            attempted.append(candidate_base)
            payload = {
                "title": "chore(security): automated remediation fixes",
                "head": head_branch,
                "base": candidate_base,
                "body": "Automated remediation fixes generated by DeplAI.",
                "maintainer_can_modify": True,
            }
            req = urlrequest.Request(
                f"https://api.github.com/repos/{owner}/{repo}/pulls",
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "Content-Type": "application/json",
                    "User-Agent": "deplai-agentic-layer",
                },
                method="POST",
            )
            try:
                with urlrequest.urlopen(req, timeout=60) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    pr_url = data.get("html_url")
                    if not pr_url:
                        return (False, "PR created but GitHub response did not include html_url.")
                    return (True, pr_url)
            except urlerror.HTTPError as e:
                raw = e.read().decode("utf-8", errors="replace")
                last_error = f"GitHub PR API failed ({e.code}) on base '{candidate_base}': {raw}"
                if e.code == 422 and '"field":"base"' in raw.replace(" ", ""):
                    continue
                return (False, last_error)
            except Exception as e:
                return (False, str(e))

        return (
            False,
            f"{last_error} | attempted base branches: {', '.join(attempted)}",
        )

    def _persist_github_changes(self) -> tuple[bool, str]:
        self._last_pr_url = None
        repo_url = self.context.repository_url
        token = self.context.github_token
        if not repo_url or not token:
            return (False, "Missing repository_url or github_token for GitHub persistence.")

        clean_repo_url = repo_url[:-4] if repo_url.endswith(".git") else repo_url
        try:
            _, owner_repo = clean_repo_url.split("github.com/", 1)
            owner, repo = owner_repo.split("/", 1)
        except Exception:
            return (False, f"Invalid repository_url: {repo_url}")

        push_url = repo_url if repo_url.endswith(".git") else repo_url + ".git"

        branch_name = f"deplai-remediation-{self.project_id[:8]}-{int(time.time())}"
        default_base = self._get_repo_default_branch(owner, repo, token) or "main"
        project_dir = f"/repo/{self.project_id}"
        # PUSH_URL (clean, no token) is passed as an env var so it is never
        # embedded in the script text.  The auth URL is built inside the script
        # using shell expansion so the token ($GIT_TOKEN) is also never stored
        # in .git/config — the remote is reset to the clean URL after the push.
        # GitHub's git endpoint requires x-access-token Basic auth, not Bearer.
        script = f"""
set -e
cd {shlex.quote(project_dir)}
if [ ! -d .git ]; then
  echo "NO_GIT_REPOSITORY"
  exit 0
fi
git checkout -B {shlex.quote(branch_name)}
git config user.email "deplai-remediator@users.noreply.github.com"
git config user.name "DeplAI Remediation Bot"
git add -A
if git diff --cached --quiet; then
  echo "NO_CHANGES"
  exit 0
fi
git commit -m "chore(security): automated remediation fixes"
AUTH_URL="https://x-access-token:${{GIT_TOKEN}}@${{PUSH_URL#https://}}"
git remote set-url origin "$AUTH_URL"
git push -u origin {shlex.quote(branch_name)}
git remote set-url origin "$PUSH_URL"
echo "PUSHED"
"""

        try:
            container = self._docker.containers.run(
                "alpine/git",
                entrypoint=["sh"],
                command=["-lc", script],
                environment={"GIT_TERMINAL_PROMPT": "0", "GIT_TOKEN": token, "PUSH_URL": push_url},
                volumes={CODEBASE_VOLUME: {"bind": "/repo", "mode": "rw"}},
                detach=True,
            )
            result = container.wait(timeout=120)
            raw_output = container.logs(stdout=True, stderr=True)
            container.remove(force=True)
            decoded = decode_output(raw_output)
            exit_code = result.get("StatusCode", 0)

            # Detect 403 / permission-denied before checking exit code so we surface
            # the real cause rather than an opaque non-zero exit status message.
            if exit_code != 0:
                lower = decoded.lower()
                if "403" in decoded or ("permission to" in lower and "denied" in lower):
                    return (
                        False,
                        "GitHub push denied (HTTP 403). The GitHub App installation has not yet "
                        "accepted the updated write permissions. Fix one of these:\n"
                        "  1. Go to github.com/settings/installations → find 'deplai-gitapp-aj' → "
                        "Accept the pending permissions update.\n"
                        "  2. Provide a Personal Access Token (PAT with repo scope) in the GitHub "
                        "Token field on the remediation screen — this bypasses the App entirely.",
                    )
                safe = redact_git_token(decoded.strip()[-400:])
                return (False, f"git push exited {exit_code}: {safe}")

            if "NO_GIT_REPOSITORY" in decoded:
                return (False, "Codebase volume is not a git repository.")
            if "NO_CHANGES" in decoded:
                return (True, "")
            if "PUSHED" in decoded:
                pr_success, pr_value = self._create_pull_request(owner, repo, token, branch_name, default_base)
                if not pr_success:
                    return (False, f"Changes pushed but PR creation failed: {pr_value}")
                self._last_pr_url = pr_value
                return (True, "")
            return (False, f"Unexpected git output: {redact_git_token(decoded)}")
        except Exception as e:
            return (False, str(e))

    async def _run_rescan(self) -> bool:
        await self._send_message("phase", "Running Security Re-Scan")
        project_name = self.context.project_name
        project_id = self.context.project_id

        async def bearer_branch() -> tuple[bool, str, str]:
            success, error_msg = await self._run_step(
                lambda: run_bearer_scan(project_name, project_id)
            )
            return (success, error_msg, "Bearer")

        async def sbom_branch() -> tuple[bool, str, str]:
            success, error_msg = await self._run_step(
                lambda: run_syft_scan(project_name, project_id)
            )
            if not success:
                return (False, error_msg, "Syft")
            success, error_msg = await self._run_step(
                lambda: run_grype_scan(project_name, project_id)
            )
            return (success, error_msg, "Syft+Grype")

        results = await asyncio.gather(bearer_branch(), sbom_branch())
        for success, error_msg, tool_name in results:
            if success:
                await self._send_message("success", f"{tool_name} scan completed successfully")
            else:
                await self._send_message("error", f"{tool_name} scan failed: {error_msg}")

        return all(success for success, _, _ in results)

    async def _wait_for_human_approval(self):
        self._approval_requested = True
        await self._send_message("phase", "Awaiting Human Approval")
        await self._send_message(
            "warning",
            "Review remediation changes and approve to rerun Bearer, Syft, and Grype.",
        )
        await self._send_status(StreamStatus.waiting_approval)

        while not self._approval_event.is_set():
            self._check_cancelled()
            await asyncio.sleep(0.2)

        await self._send_status(StreamStatus.running)

    @staticmethod
    def _count_findings_for_scope(scan_data: dict, scope: str) -> int:
        """Count findings in a remediation scope across code_security and supply_chain."""
        allowed = _severity_for_scope(scope)

        count = 0
        for finding in scan_data.get("code_security", []):
            sev = str(finding.get("severity", "")).strip().lower()
            if sev in allowed:
                count += int(finding.get("count", 1) or 1)
        for finding in scan_data.get("supply_chain", []):
            sev = str(finding.get("severity", "")).strip().lower()
            if sev in allowed:
                count += 1
        return count

    async def _run_pipeline(self) -> bool:
        self._check_cancelled()

        # Scope all codebase volume operations to this project's subdirectory.
        set_current_project_id(self.project_id)

        # Step 1: Ingest scan data
        await self._send_message("phase", "Ingesting Security Scan Data")
        success, scan_data = await self._run_step(partial(get_scan_results, self.project_id))
        if not success:
            return await self._terminate(f"Failed to ingest scan data: {scan_data}")
        await self._send_message("success", "Scan data loaded successfully")

        # Step 2: Ensure output volume exists
        await self._send_message("info", "Preparing output volume")
        success, error_msg = await self._run_step(self._ensure_output_volume)
        if not success:
            return await self._terminate(f"Failed to prepare output volume: {error_msg}")
        await self._send_message("success", "Output volume ready")

        self._check_cancelled()

        remediation_scope = (
            str(getattr(self.context, "remediation_scope", "all") or "all")
            .strip()
            .lower()
        )
        if remediation_scope not in ("major", "all"):
            remediation_scope = "all"
        await self._send_message("info", f"Remediation scope selected: {remediation_scope}")

        no_progress_cycles = 0
        last_remaining = self._count_findings_for_scope(scan_data, remediation_scope)

        # ---- Remediation cycle loop (max 2 iterations) ----
        for cycle in range(MAX_REMEDIATION_CYCLES):
            cycle_label = f"[Cycle {cycle + 1}/{MAX_REMEDIATION_CYCLES}]"
            if cycle > 0:
                await self._send_message("phase", f"{cycle_label} Starting remediation cycle")

            queue, queue_stats = _build_remediation_queue(scan_data, remediation_scope)
            queue_total = len(queue)
            await self._send_message(
                "info",
                (
                    f"{cycle_label} Queue prepared: {queue_total} micro-batch(es) "
                    f"(code findings: {queue_stats.get('code_total', 0)}, "
                    f"supply findings: {queue_stats.get('supply_total', 0)}, "
                    f"scope={queue_stats.get('scope', remediation_scope)})"
                    + (" [batched]" if queue_stats.get("enabled") else " [single-pass]")
                ),
            )

            batch_queue: deque[dict] = deque(queue)
            batches_to_run = min(queue_total, max(1, REMEDIATION_MAX_BATCHES_PER_CYCLE))
            if queue_total > batches_to_run:
                await self._send_message(
                    "warning",
                    f"{cycle_label} Queue truncated to {batches_to_run} batch(es) for this cycle; remaining batches will continue in the next cycle.",
                )

            cycle_summary_parts: list[str] = []
            cycle_changed_files: list[dict] = []
            cycle_rejected_changes: list[dict] = []
            cycle_applied_changes = 0
            cycle_proposed_changes = 0
            failed_batches = 0

            for batch_index in range(batches_to_run):
                self._check_cancelled()
                batch_scan_data = batch_queue.popleft()

                code_count = len(batch_scan_data.get("code_security", []) or [])
                supply_count = len(batch_scan_data.get("supply_chain", []) or [])
                await self._send_message(
                    "phase",
                    (
                        f"{cycle_label} Processing micro-batch {batch_index + 1}/{batches_to_run} "
                        f"(code={code_count}, supply={supply_count})"
                    ),
                )

                # Step 2.5: Knowledge Graph Analysis for this batch
                await self._send_message("phase", f"{cycle_label} Knowledge Graph Analysis (batch {batch_index + 1})")
                agent_analysis: dict = {}
                try:
                    async def _on_kg_message(msg_type: str, content: str):
                        await self._send_message(msg_type, content)

                    agent_analysis = await run_analysis_agent(
                        project_id=self.project_id,
                        scan_data=batch_scan_data,
                        on_message=_on_kg_message,
                    )
                    await self._send_message("kg_result", json.dumps({
                        "business_logic_summary": agent_analysis.get("business_logic_summary", ""),
                        "vulnerability_summary":  agent_analysis.get("vulnerability_summary", ""),
                        "context":               agent_analysis.get("context"),
                    }))
                except Exception as _kg_exc:
                    await self._send_message("warning", f"Knowledge graph analysis skipped: {_kg_exc}")

                self._check_cancelled()

                # Step 3: Run remediation for this batch
                await self._send_message(
                    "phase",
                    f"{cycle_label} Running Remediation Supervisor (batch {batch_index + 1})",
                )
                try:
                    async def _on_supervisor_message(msg_type: str, content: str):
                        await self._send_message(msg_type, content)

                    success, remediation_result = await run_remediation_supervisor(
                        scan_data=batch_scan_data,
                        cortex_context=self.context.cortex_context,
                        llm_provider=self.context.llm_provider,
                        llm_api_key=self.context.llm_api_key,
                        llm_model=self.context.llm_model,
                        agent_analysis=agent_analysis,
                        on_message=_on_supervisor_message,
                    )
                except Exception as _sup_exc:
                    success = False
                    remediation_result = str(_sup_exc)

                if not success:
                    await self._send_message(
                        "warning",
                        (
                            f"Supervisor failed on batch {batch_index + 1} ({remediation_result}), "
                            "falling back to single-pass remediation."
                        ),
                    )
                    try:
                        fb_ok, fb_result = await self._run_step(
                            partial(
                                run_claude_remediation,
                                batch_scan_data,
                                cortex_context=self.context.cortex_context,
                                llm_provider=self.context.llm_provider,
                                llm_api_key=self.context.llm_api_key,
                                llm_model=self.context.llm_model,
                                agent_analysis=agent_analysis,
                            )
                        )
                        if fb_ok:
                            success, remediation_result = True, fb_result
                        else:
                            failed_batches += 1
                            await self._send_message(
                                "warning",
                                f"Fallback remediation failed on batch {batch_index + 1}: {fb_result}",
                            )
                            if failed_batches >= REMEDIATION_MAX_FAILED_BATCHES:
                                await self._send_message(
                                    "warning",
                                    (
                                        "Too many consecutive remediation batch failures in this cycle; "
                                        "stopping further micro-batches and continuing pipeline with partial results."
                                    ),
                                )
                                break
                            continue
                    except Exception as _fb_exc:
                        failed_batches += 1
                        await self._send_message(
                            "warning",
                            f"Fallback remediation error on batch {batch_index + 1}: {_fb_exc}",
                        )
                        if failed_batches >= REMEDIATION_MAX_FAILED_BATCHES:
                            await self._send_message(
                                "warning",
                                (
                                    "Too many consecutive remediation batch failures in this cycle; "
                                    "stopping further micro-batches and continuing pipeline with partial results."
                                ),
                            )
                            break
                        continue

                summary = remediation_result.get("summary", "")
                changed_files = remediation_result.get("changed_files", [])
                rejected_changes = remediation_result.get("rejected_changes", [])
                proposed_change_count = int(remediation_result.get("proposed_change_count", 0) or 0)
                applied_change_count = int(remediation_result.get("applied_change_count", len(changed_files)) or 0)

                cycle_proposed_changes += proposed_change_count
                cycle_applied_changes += applied_change_count
                if summary:
                    cycle_summary_parts.append(f"[Batch {batch_index + 1}] {summary}")
                cycle_changed_files.extend(changed_files)
                cycle_rejected_changes.extend(rejected_changes)

                if changed_files:
                    failed_batches = 0
                    await self._send_message(
                        "success",
                        (
                            f"Batch {batch_index + 1}: applied {len(changed_files)} file update(s) "
                            f"(proposed={proposed_change_count}, applied={applied_change_count})."
                        ),
                    )
                    for item in changed_files[:12]:
                        await self._send_message("info", f"Updated {item.get('path', 'unknown path')}")
                    await self._send_message("changed_files", json.dumps(changed_files))
                else:
                    failed_batches += 1
                    if proposed_change_count > 0:
                        await self._send_message(
                            "warning",
                            (
                                f"Batch {batch_index + 1}: proposals generated but no safe file updates were applied "
                                f"(proposed={proposed_change_count}, applied={applied_change_count})."
                            ),
                        )
                    else:
                        await self._send_message(
                            "warning",
                            f"Batch {batch_index + 1}: remediation agent produced no safe changes.",
                        )
                    if failed_batches >= REMEDIATION_MAX_STALLED_BATCHES:
                        await self._send_message(
                            "warning",
                            (
                                "No safe progress across many consecutive micro-batches; "
                                "ending this cycle early to avoid unnecessary churn."
                            ),
                        )
                        break

                if rejected_changes:
                    await self._send_message(
                        "warning",
                        f"Batch {batch_index + 1}: {len(rejected_changes)} proposed change(s) rejected by safety filters.",
                    )
                    for item in rejected_changes[:6]:
                        await self._send_message(
                            "info",
                            (
                                f"Rejected path {item.get('path', 'unknown')}: "
                                f"{item.get('reason', 'unspecified reason')}"
                            ),
                        )

            self._check_cancelled()

            # Step 4: Save remediation summary
            await self._send_message("phase", "Writing Remediation Report")
            consolidated_summary = "\n".join(cycle_summary_parts).strip()
            lines = [
                f"=== DEPLAI REMEDIATION REPORT (Cycle {cycle + 1}) ===",
                "",
                f"Project: {self.context.project_name} ({self.context.project_id})",
                f"Type: {self.context.project_type}",
                f"Scope: {remediation_scope}",
                "",
                "--- LLM SUMMARY ---",
                consolidated_summary or "No summary generated.",
                "",
                "--- BATCH METRICS ---",
                f"Queue size: {queue_total}",
                f"Batches attempted this cycle: {batches_to_run}",
                f"Proposed changes: {cycle_proposed_changes}",
                f"Applied changes: {cycle_applied_changes}",
                "",
                "--- CHANGED FILES ---",
            ]
            if cycle_changed_files:
                for item in cycle_changed_files:
                    path = item.get("path", "unknown")
                    reason = item.get("reason", "")
                    lines.append(f"- {path}{': ' + reason if reason else ''}")
            else:
                lines.append("- No file changes were applied.")

            success, error_msg = await self._run_step(lambda: self._write_summary_file("\n".join(lines)))
            if success:
                await self._send_message("success", "Remediation summary saved to LLM_Output/summary.txt")
            else:
                await self._send_message("warning", f"Could not write remediation summary: {error_msg}")

            if cycle_applied_changes <= 0 and not cycle_changed_files:
                no_progress_cycles += 1
                await self._send_message(
                    "warning",
                    (
                        f"{cycle_label} No safe remediation changes were applied in this cycle. "
                        f"No-progress streak: {no_progress_cycles}/{REMEDIATION_NO_PROGRESS_LIMIT}."
                    ),
                )
                if no_progress_cycles >= REMEDIATION_NO_PROGRESS_LIMIT:
                    await self._send_message(
                        "warning",
                        "Stopping remediation loop due to repeated no-progress cycles. Advancing pipeline with latest results.",
                    )
                    break
                if cycle + 1 < MAX_REMEDIATION_CYCLES:
                    await self._send_message(
                        "info",
                        "No file changes to approve/persist in this cycle. Continuing to next remediation cycle.",
                    )
                    continue
            else:
                no_progress_cycles = 0

            self._check_cancelled()

            # Step 5: Wait for explicit human approval before persisting & rescanning
            await self._wait_for_human_approval()

            # Step 6: Persist changes to source of truth (after approval)
            await self._send_message("phase", "Persisting Remediation Changes")
            if self.context.project_type == "github":
                success, error_msg = await self._run_step(self._persist_github_changes)
                if not success:
                    return await self._terminate(f"Failed to push remediation changes to GitHub: {error_msg}")
                if self._last_pr_url:
                    await self._send_message("success", f"Remediation PR created: {self._last_pr_url}")
                else:
                    await self._send_message("success", "No GitHub changes detected; PR not created.")
            else:
                success, error_msg = await self._run_step(self._persist_local_changes)
                if not success:
                    return await self._terminate(f"Failed to persist local remediation changes: {error_msg}")
                await self._send_message("success", "Remediation changes written to local project files")

            self._check_cancelled()

            # Step 7: Rerun scanners after approval
            await self._send_message("info", "Invalidating previous scan cache")
            await self._run_step(lambda: invalidate_cache(self.project_id))

            rescanned = await self._run_rescan()
            if not rescanned:
                return await self._terminate("Security re-scan failed after remediation.")

            # Reset approval state for next cycle
            self._approval_event.clear()
            self._approval_requested = False

            # Check if high/critical findings remain — if none, exit loop early
            rescan_ok, rescan_data = await self._run_step(partial(get_scan_results, self.project_id))
            if not rescan_ok:
                await self._send_message("warning", "Could not reload rescan results for vuln check.")
                break

            remaining_vulns = self._count_findings_for_scope(rescan_data, remediation_scope)
            if remaining_vulns == 0:
                await self._send_message(
                    "success",
                    f"{cycle_label} No remaining findings in scope ({remediation_scope}). Remediation loop complete.",
                )
                break

            await self._send_message(
                "info",
                f"{cycle_label} {remaining_vulns} finding(s) remain in scope ({remediation_scope}) after remediation.",
            )

            if remaining_vulns >= last_remaining:
                no_progress_cycles += 1
                await self._send_message(
                    "warning",
                    (
                        f"{cycle_label} Remaining findings did not decrease "
                        f"({remaining_vulns} >= {last_remaining}). "
                        f"No-progress streak: {no_progress_cycles}/{REMEDIATION_NO_PROGRESS_LIMIT}."
                    ),
                )
                if no_progress_cycles >= REMEDIATION_NO_PROGRESS_LIMIT:
                    await self._send_message(
                        "warning",
                        "Stopping remediation due to repeated no-progress after rescans.",
                    )
                    break
            else:
                no_progress_cycles = 0
            last_remaining = remaining_vulns

            if cycle + 1 < MAX_REMEDIATION_CYCLES:
                await self._send_message(
                    "info",
                    f"Starting next remediation cycle ({cycle + 2}/{MAX_REMEDIATION_CYCLES})...",
                )
                # Use fresh scan data for next cycle
                scan_data = rescan_data
            else:
                await self._send_message(
                    "warning",
                    f"Maximum remediation cycles ({MAX_REMEDIATION_CYCLES}) reached. "
                    f"{remaining_vulns} finding(s) may still remain in scope ({remediation_scope}).",
                )

        await self._send_message("success", "Remediation loop completed successfully")
        return True
