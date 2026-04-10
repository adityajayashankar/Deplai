"""Remediation orchestration with Claude code fixes and approval-gated rescans."""

import asyncio
import base64
import json
import os
import shlex
import time
from urllib import error as urlerror
from urllib import request as urlrequest
from functools import partial

from fastapi import WebSocket

from agent import run_analysis_agent, run_remediation_supervisor
from Analysis.dataingestor import get_scan_results
from bearer import run_bearer_scan
from claude_remediator import ClaudeBudgetTracker, run_claude_remediation  # kept as fallback
from models import RemediationRequest, StreamStatus, WebSocketCommand
from result_parser import invalidate_cache
from runner_base import RunnerBase
from sbom import run_grype_scan, run_syft_scan
from utils import CODEBASE_VOLUME, LLM_OUTPUT_VOLUME, decode_output, get_docker_client, redact_git_token, resolve_host_projects_dir, set_current_project_id

TOTAL_STEPS = 15
MAX_REMEDIATION_CYCLES = 2
REMEDIATION_NO_PROGRESS_LIMIT = int(os.getenv("REMEDIATION_NO_PROGRESS_LIMIT", "2"))
REMEDIATION_MAX_CODE_ROOT_CAUSES = int(os.getenv("REMEDIATION_MAX_CODE_ROOT_CAUSES", "10"))
REMEDIATION_MAX_SUPPLY_ROOT_CAUSES = int(os.getenv("REMEDIATION_MAX_SUPPLY_ROOT_CAUSES", "8"))
REMEDIATION_MAX_CODE_OCCURRENCES_PER_ROOT_CAUSE = int(
    os.getenv("REMEDIATION_MAX_CODE_OCCURRENCES_PER_ROOT_CAUSE", "3")
)
REMEDIATION_CODE_ROOT_CAUSES_PER_BATCH = max(
    1, int(os.getenv("REMEDIATION_CODE_ROOT_CAUSES_PER_BATCH", "4"))
)
REMEDIATION_SUPPLY_ROOT_CAUSES_PER_BATCH = max(
    1, int(os.getenv("REMEDIATION_SUPPLY_ROOT_CAUSES_PER_BATCH", "4"))
)
REMEDIATION_MAX_BATCHES_PER_CYCLE = max(
    1, int(os.getenv("REMEDIATION_MAX_BATCHES_PER_CYCLE", "4"))
)
REMEDIATION_LARGE_FINDING_THRESHOLD = max(
    1, int(os.getenv("REMEDIATION_LARGE_FINDING_THRESHOLD", "1000"))
)
LARGE_REMEDIATION_SEVERITY_ORDER = ("critical", "high")

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


def _normalize_rel_path(path: str) -> str:
    value = str(path or "").strip().replace("\\", "/")
    while value.startswith("./"):
        value = value[2:]
    return "/".join(part for part in value.split("/") if part not in ("", "."))


def _representative_occurrence(occurrences: list[dict]) -> str:
    for occ in occurrences:
        path = _normalize_rel_path((occ or {}).get("filename", ""))
        if path:
            return path
    return ""


def _build_code_root_causes(findings: list[dict], allowed_severity: set[str]) -> tuple[list[dict], dict]:
    grouped: dict[tuple[str, str, str], dict] = {}
    raw_occurrence_total = 0

    for finding in findings:
        if not isinstance(finding, dict):
            continue
        severity = str(finding.get("severity", "")).strip().lower()
        if severity not in allowed_severity:
            continue

        occurrences = [occ for occ in (finding.get("occurrences", []) or []) if isinstance(occ, dict)]
        raw_occurrence_total += max(int(finding.get("count", len(occurrences) or 1) or 1), len(occurrences) or 1)

        occurrences_by_path: dict[str, list[dict]] = {}
        for occ in occurrences:
            path = _normalize_rel_path(occ.get("filename", ""))
            if not path:
                path = "__repo__"
            occurrences_by_path.setdefault(path, []).append(occ)

        if not occurrences_by_path:
            fallback_path = _normalize_rel_path(finding.get("filename", "")) or "__repo__"
            occurrences_by_path[fallback_path] = []

        for path, path_occurrences in occurrences_by_path.items():
            key = (
                str(finding.get("cwe_id") or "unknown"),
                severity,
                path,
            )
            existing = grouped.get(key)
            if existing is None:
                grouped[key] = {
                    "cwe_id": finding.get("cwe_id"),
                    "severity": severity,
                    "title": finding.get("title") or finding.get("name") or "",
                    "description": finding.get("description") or "",
                    "count": len(path_occurrences) or 1,
                    "occurrences": path_occurrences[:REMEDIATION_MAX_CODE_OCCURRENCES_PER_ROOT_CAUSE],
                    "primary_path": "" if path == "__repo__" else path,
                    "root_cause_key": f"code:{finding.get('cwe_id') or 'unknown'}:{path}",
                    "root_cause_kind": "code_file_cwe",
                }
                continue

            existing["count"] = int(existing.get("count", 0) or 0) + (len(path_occurrences) or 1)
            if not existing.get("description") and finding.get("description"):
                existing["description"] = finding.get("description")
            merged_occurrences = list(existing.get("occurrences", []))
            for occ in path_occurrences:
                if len(merged_occurrences) >= REMEDIATION_MAX_CODE_OCCURRENCES_PER_ROOT_CAUSE:
                    break
                merged_occurrences.append(occ)
            existing["occurrences"] = merged_occurrences

    deduped = sorted(
        grouped.values(),
        key=lambda item: (
            -_severity_rank(item.get("severity", "")),
            -int(item.get("count", 1) or 1),
            str(item.get("cwe_id") or ""),
            str(item.get("primary_path") or ""),
        ),
    )
    selected = deduped[:REMEDIATION_MAX_CODE_ROOT_CAUSES]
    return selected, {
        "raw_total": raw_occurrence_total,
        "root_causes": len(selected),
        "root_causes_available": len(deduped),
    }


def _build_supply_root_causes(findings: list[dict], allowed_severity: set[str]) -> tuple[list[dict], dict]:
    grouped: dict[tuple[str, str, str, str], dict] = {}
    raw_total = 0

    for finding in findings:
        if not isinstance(finding, dict):
            continue
        severity = str(finding.get("severity", "")).strip()
        severity_lower = severity.lower()
        if severity_lower not in allowed_severity:
            continue

        raw_total += 1
        package = str(finding.get("package") or finding.get("name") or "").strip() or "unknown-package"
        version = str(
            finding.get("installed_version")
            or finding.get("version")
            or ""
        ).strip()
        fix_version = str(finding.get("fix_version") or "").strip()
        purl = str(finding.get("purl") or "").strip()
        key = (package.lower(), version, fix_version, purl)

        existing = grouped.get(key)
        if existing is None:
            cve_id = str(finding.get("cve_id") or "").strip()
            related_cves = [cve_id] if cve_id else []
            grouped[key] = {
                "cve_id": cve_id,
                "related_cve_ids": related_cves,
                "severity": severity or severity_lower,
                "package": package,
                "name": package,
                "version": version,
                "installed_version": version,
                "fix_version": fix_version or None,
                "purl": purl or None,
                "count": 1,
                "root_cause_key": f"supply:{package.lower()}:{version}:{fix_version or 'no-fix'}",
                "root_cause_kind": "package_upgrade",
            }
            continue

        existing["count"] = int(existing.get("count", 1) or 1) + 1
        if _severity_rank(severity) > _severity_rank(str(existing.get("severity", ""))):
            existing["severity"] = severity
        cve_id = str(finding.get("cve_id") or "").strip()
        if cve_id and cve_id not in existing["related_cve_ids"]:
            existing["related_cve_ids"].append(cve_id)
        if not existing.get("cve_id") and cve_id:
            existing["cve_id"] = cve_id

    deduped = sorted(
        grouped.values(),
        key=lambda item: (
            -_severity_rank(item.get("severity", "")),
            -int(item.get("count", 1) or 1),
            str(item.get("package") or ""),
            str(item.get("fix_version") or ""),
        ),
    )
    selected = deduped[:REMEDIATION_MAX_SUPPLY_ROOT_CAUSES]
    return selected, {
        "raw_total": raw_total,
        "root_causes": len(selected),
        "root_causes_available": len(deduped),
    }


def _build_remediation_batch(scan_data: dict, scope: str) -> tuple[dict, dict]:
    """Build one full filtered remediation batch for the entire repo."""
    code_all = list(scan_data.get("code_security", []) or [])
    supply_all = list(scan_data.get("supply_chain", []) or [])
    allowed_severity = _severity_for_scope(scope)

    code_filtered, code_stats = _build_code_root_causes(code_all, allowed_severity)
    supply_filtered, supply_stats = _build_supply_root_causes(supply_all, allowed_severity)

    # Fallback for malformed/no-severity findings in all-scope runs.
    if scope == "all":
        if not code_filtered and code_all:
            code_filtered = code_all[:REMEDIATION_MAX_CODE_ROOT_CAUSES]
            code_stats = {
                "raw_total": sum(int((item or {}).get("count", 1) or 1) for item in code_all),
                "root_causes": len(code_filtered),
                "root_causes_available": len(code_all),
            }
        if not supply_filtered and supply_all:
            supply_filtered = supply_all[:REMEDIATION_MAX_SUPPLY_ROOT_CAUSES]
            supply_stats = {
                "raw_total": len(supply_all),
                "root_causes": len(supply_filtered),
                "root_causes_available": len(supply_all),
            }

    batch = dict(scan_data)
    batch["code_security"] = code_filtered
    batch["supply_chain"] = supply_filtered
    return batch, {
        "scope": scope,
        "code_total": len(code_filtered),
        "supply_total": len(supply_filtered),
        "code_raw_total": code_stats.get("raw_total", 0),
        "supply_raw_total": supply_stats.get("raw_total", 0),
        "code_root_causes": code_stats.get("root_causes", len(code_filtered)),
        "supply_root_causes": supply_stats.get("root_causes", len(supply_filtered)),
        "code_root_causes_available": code_stats.get("root_causes_available", len(code_filtered)),
        "supply_root_causes_available": supply_stats.get("root_causes_available", len(supply_filtered)),
        "repo_wide": True,
        "selection_mode": "root_cause_deduped",
    }


def _filter_scan_by_severities(scan_data: dict, severities: set[str]) -> dict:
    filtered = dict(scan_data)
    filtered["code_security"] = [
        finding
        for finding in (scan_data.get("code_security", []) or [])
        if str((finding or {}).get("severity", "")).strip().lower() in severities
    ]
    filtered["supply_chain"] = [
        finding
        for finding in (scan_data.get("supply_chain", []) or [])
        if str((finding or {}).get("severity", "")).strip().lower() in severities
    ]
    return filtered


def _count_findings_for_severities(scan_data: dict, severities: set[str]) -> int:
    count = 0
    for finding in scan_data.get("code_security", []):
        sev = str((finding or {}).get("severity", "")).strip().lower()
        if sev in severities:
            count += int((finding or {}).get("count", 1) or 1)
    for finding in scan_data.get("supply_chain", []):
        sev = str((finding or {}).get("severity", "")).strip().lower()
        if sev in severities:
            count += 1
    return count


def _select_cycle_scan_strategy(scan_data: dict, scope: str) -> tuple[dict, dict]:
    """Choose the scan slice to remediate for the current cycle."""
    total_in_scope = _count_findings_for_severities(scan_data, _severity_for_scope(scope))
    major_remaining = _count_findings_for_severities(scan_data, MAJOR_SEVERITIES)
    strategy = {
        "mode": "default",
        "scope": scope,
        "total_in_scope": total_in_scope,
        "major_remaining": major_remaining,
        "stage_severity": None,
        "stage_findings": total_in_scope,
        "forced_claude_sdk": False,
        "stage_label": scope,
    }
    if total_in_scope <= REMEDIATION_LARGE_FINDING_THRESHOLD:
        return scan_data, strategy

    if major_remaining <= 0:
        strategy.update(
            {
                "mode": "large_repo_major_complete",
                "stage_findings": 0,
                "stage_label": "major_complete",
                "forced_claude_sdk": False,
            }
        )
        return _filter_scan_by_severities(scan_data, set()), strategy

    allowed = _severity_for_scope(scope)
    for severity in LARGE_REMEDIATION_SEVERITY_ORDER:
        if severity not in allowed:
            continue
        stage_count = _count_findings_for_severities(scan_data, {severity})
        if stage_count <= 0:
            continue
        strategy.update(
            {
                "mode": "large_repo_severity_staged",
                "stage_severity": severity,
                "stage_findings": stage_count,
                "forced_claude_sdk": True,
                "stage_label": severity,
            }
        )
        return _filter_scan_by_severities(scan_data, {severity}), strategy

    return scan_data, strategy


def _strategy_target_severities(strategy: dict, scope: str) -> set[str]:
    stage = str(strategy.get("stage_severity") or "").strip().lower()
    if stage:
        return {stage}
    return _severity_for_scope(scope)


def _strategy_label(strategy: dict, scope: str) -> str:
    stage = str(strategy.get("stage_severity") or "").strip().lower()
    if stage:
        return f"{stage} findings"
    return f"{scope} scope"


def _chunk_root_causes(items: list[dict], batch_size: int) -> list[list[dict]]:
    if not items:
        return [[]]
    return [
        items[index:index + batch_size]
        for index in range(0, len(items), batch_size)
    ]


def _build_remediation_batches(scan_data: dict, scope: str) -> list[tuple[dict, dict]]:
    """Split large remediation queues into smaller batches for LLM processing."""
    filtered_scan_data, queue_stats = _build_remediation_batch(scan_data, scope)
    code_filtered = list(filtered_scan_data.get("code_security", []) or [])
    supply_filtered = list(filtered_scan_data.get("supply_chain", []) or [])

    code_chunks = _chunk_root_causes(code_filtered, REMEDIATION_CODE_ROOT_CAUSES_PER_BATCH)
    supply_chunks = _chunk_root_causes(supply_filtered, REMEDIATION_SUPPLY_ROOT_CAUSES_PER_BATCH)
    total_batches = max(len(code_chunks), len(supply_chunks), 1)
    total_batches = min(total_batches, REMEDIATION_MAX_BATCHES_PER_CYCLE)

    batches: list[tuple[dict, dict]] = []
    for batch_index in range(total_batches):
        batch = dict(filtered_scan_data)
        batch_code = code_chunks[batch_index] if batch_index < len(code_chunks) else []
        batch_supply = supply_chunks[batch_index] if batch_index < len(supply_chunks) else []
        batch["code_security"] = batch_code
        batch["supply_chain"] = batch_supply
        selection_mode = "root_cause_deduped"
        if max(len(code_chunks), len(supply_chunks), 1) > 1:
            selection_mode = "root_cause_deduped_chunked"
        batches.append(
            (
                batch,
                {
                    **queue_stats,
                    "code_total": len(batch_code),
                    "supply_total": len(batch_supply),
                    "code_root_causes": len(batch_code),
                    "supply_root_causes": len(batch_supply),
                    "code_root_causes_selected": len(code_filtered),
                    "supply_root_causes_selected": len(supply_filtered),
                    "batch_index": batch_index + 1,
                    "batch_total": total_batches,
                    "selection_mode": selection_mode,
                },
            )
        )
    return batches


class RemediationRunner(RunnerBase):
    """Orchestrates Claude remediation, persistence, and approval-gated rescans."""

    def __init__(self, websocket: WebSocket, remediation_context: RemediationRequest):
        super().__init__(websocket, TOTAL_STEPS)
        self.context = remediation_context
        self.project_id = remediation_context.project_id
        self._docker = get_docker_client()
        self._command_event = asyncio.Event()
        self._approval_event = self._command_event
        self._pending_action: str | None = None
        self._decision_requested = False
        self._approval_requested = False
        self._last_pr_url: str | None = None

    async def handle_command(self, command: WebSocketCommand):
        if command.action == "continue_round":
            if not self._decision_requested:
                await self._send_message("warning", "Continue request ignored: remediation is not waiting for a round decision.")
                return
            if self._command_event.is_set():
                return
            self._pending_action = "continue_round"
            self._command_event.set()
            await self._send_message("success", "Operator selected another remediation round. Running a verification scan before the next pass.")
            return

        if command.action == "push_current":
            if not self._decision_requested:
                await self._send_message("warning", "Push request ignored: remediation is not waiting for a round decision.")
                return
            if self._command_event.is_set():
                return
            self._pending_action = "push_current"
            self._command_event.set()
            await self._send_message("success", "Operator selected the current fixes. Moving to final approval before persistence.")
            return

        if command.action == "approve_push":
            if not self._approval_requested:
                await self._send_message("warning", "Approval ignored: remediation is not waiting for final approval.")
                return
            if self._command_event.is_set():
                return
            self._pending_action = "approve_push"
            self._command_event.set()
            await self._send_message("success", "Final approval received. Persisting approved remediation changes and starting verification re-scan.")

    def _clear_pending_action(self):
        self._pending_action = None
        self._command_event.clear()

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
                        "  1. Go to github.com/settings/installations → find 'deplai-app' → "
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

    async def _wait_for_round_decision(self) -> str:
        self._decision_requested = True
        self._approval_requested = False
        self._clear_pending_action()
        await self._send_message("phase", "Review Current Fixes")
        await self._send_message(
            "warning",
            "Review the changed files. Choose whether to push these fixes forward for approval or run one more remediation round first.",
        )
        await self._send_status(StreamStatus.waiting_decision)

        while not self._command_event.is_set():
            self._check_cancelled()
            await asyncio.sleep(0.2)

        action = str(self._pending_action or "").strip().lower()
        self._decision_requested = False
        self._clear_pending_action()

        if action == "continue_round":
            await self._send_status(StreamStatus.running)
            return action
        if action == "push_current":
            return action

        await self._send_message("warning", "Unknown remediation decision received. Defaulting to final approval.")
        return "push_current"

    async def _wait_for_human_approval(self):
        self._approval_requested = True
        self._decision_requested = False
        self._clear_pending_action()
        await self._send_message("phase", "Awaiting Human Approval")
        await self._send_message(
            "warning",
            "Review remediation changes and approve to persist the fixes, create the PR if applicable, and rerun Bearer, Syft, and Grype.",
        )
        await self._send_status(StreamStatus.waiting_approval)

        while not self._command_event.is_set():
            self._check_cancelled()
            await asyncio.sleep(0.2)

        self._approval_requested = False
        self._clear_pending_action()
        await self._send_status(StreamStatus.running)

    @staticmethod
    def _count_findings_for_scope(scan_data: dict, scope: str) -> int:
        """Count findings in a remediation scope across code_security and supply_chain."""
        return _count_findings_for_severities(scan_data, _severity_for_scope(scope))

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
        budget_tracker = ClaudeBudgetTracker()
        await self._send_message(
            "info",
            f"Claude remediation budget cap: ${budget_tracker.budget_cap_usd:.2f} per run.",
        )
        budget_exhausted = False

        no_progress_cycles = 0

        # ---- Remediation cycle loop (max 2 iterations) ----
        for cycle in range(MAX_REMEDIATION_CYCLES):
            cycle_label = f"[Cycle {cycle + 1}/{MAX_REMEDIATION_CYCLES}]"
            if cycle > 0:
                await self._send_message("phase", f"{cycle_label} Starting remediation cycle")

            cycle_scan_data, cycle_strategy = _select_cycle_scan_strategy(scan_data, remediation_scope)
            if cycle_strategy.get("mode") == "large_repo_major_complete":
                await self._send_message(
                    "success",
                    (
                        f"{cycle_label} Critical and high findings are cleared for this large remediation run. "
                        "Stopping before medium/low severities."
                    ),
                )
                break
            cycle_remaining_baseline = int(cycle_strategy.get("stage_findings", 0) or 0)
            target_label = _strategy_label(cycle_strategy, remediation_scope)
            target_severities = _strategy_target_severities(cycle_strategy, remediation_scope)

            effective_llm_provider = self.context.llm_provider or ""
            effective_llm_api_key = self.context.llm_api_key or ""
            effective_llm_model = self.context.llm_model or ""
            requested_provider = str(self.context.llm_provider or "").strip().lower()
            if cycle_strategy.get("forced_claude_sdk"):
                await self._send_message(
                    "info",
                    (
                        f"{cycle_label} Large vulnerability set detected "
                        f"({cycle_strategy.get('total_in_scope', cycle_remaining_baseline)} > "
                        f"{REMEDIATION_LARGE_FINDING_THRESHOLD}). "
                        f"Using Claude SDK staged mode: processing {str(cycle_strategy.get('stage_severity', '')).upper()} findings first in batches."
                    ),
                )
                effective_llm_provider = "claude"
                if requested_provider not in ("", "claude"):
                    effective_llm_api_key = ""
                    effective_llm_model = ""
                    await self._send_message(
                        "info",
                        (
                            f"{cycle_label} Ignoring remediation provider override '{requested_provider}' "
                            "for this large-run stage and using the Claude SDK instead."
                        ),
                    )

            remediation_batches = _build_remediation_batches(cycle_scan_data, remediation_scope)
            for _, batch_stats in remediation_batches:
                batch_stats["strategy_mode"] = cycle_strategy.get("mode")
                batch_stats["stage_severity"] = cycle_strategy.get("stage_severity")
                batch_stats["stage_findings"] = cycle_strategy.get("stage_findings")
                batch_stats["total_in_scope"] = cycle_strategy.get("total_in_scope")
            queue_stats = remediation_batches[0][1] if remediation_batches else {}
            await self._send_message(
                "info",
                (
                    f"{cycle_label} Prepared {len(remediation_batches)} remediation batch(es) for {target_label} "
                    f"(selected code root causes: {queue_stats.get('code_root_causes_selected', 0)}/"
                    f"{queue_stats.get('code_root_causes_available', 0)} from "
                    f"{queue_stats.get('code_raw_total', 0)} raw occurrences, "
                    f"selected supply root causes: {queue_stats.get('supply_root_causes_selected', 0)}/"
                    f"{queue_stats.get('supply_root_causes_available', 0)} from "
                    f"{queue_stats.get('supply_raw_total', 0)} raw findings, "
                    f"scope={queue_stats.get('scope', remediation_scope)})"
                ),
            )

            cycle_summary_parts: list[str] = []
            cycle_changed_files: list[dict] = []
            cycle_rejected_changes: list[dict] = []
            cycle_applied_changes = 0
            cycle_proposed_changes = 0
            processed_batches = 0
            self._check_cancelled()
            for batch_scan_data, batch_queue_stats in remediation_batches:
                processed_batches += 1
                code_count = len(batch_scan_data.get("code_security", []) or [])
                supply_count = len(batch_scan_data.get("supply_chain", []) or [])
                batch_label = cycle_label
                if len(remediation_batches) > 1:
                    batch_label = (
                        f"{cycle_label} [Batch {batch_queue_stats.get('batch_index', processed_batches)}/"
                        f"{batch_queue_stats.get('batch_total', len(remediation_batches))}]"
                    )

                await self._send_message(
                    "phase",
                    (
                        f"{batch_label} Processing remediation batch "
                        f"(code root causes={code_count}, supply root causes={supply_count})"
                    ),
                )

                await self._send_message("phase", f"{batch_label} Knowledge Graph Analysis")
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
                    await self._send_message("warning", f"{batch_label} Knowledge graph analysis skipped: {_kg_exc}")

                self._check_cancelled()

                await self._send_message("phase", f"{batch_label} Running Remediation Supervisor")
                try:
                    async def _on_supervisor_message(msg_type: str, content: str):
                        await self._send_message(msg_type, content)

                    success, remediation_result = await run_remediation_supervisor(
                        scan_data=batch_scan_data,
                        cortex_context=self.context.cortex_context,
                        llm_provider=effective_llm_provider,
                        llm_api_key=effective_llm_api_key,
                        llm_model=effective_llm_model,
                        agent_analysis=agent_analysis,
                        budget_tracker=budget_tracker,
                        on_message=_on_supervisor_message,
                    )
                except Exception as _sup_exc:
                    success = False
                    remediation_result = str(_sup_exc)

                if not success:
                    if "budget exceeded" in str(remediation_result).lower():
                        budget_exhausted = True
                        await self._send_message("warning", f"Stopping remediation early: {remediation_result}")
                    else:
                        await self._send_message(
                            "warning",
                            (
                                f"{batch_label} Supervisor failed ({remediation_result}), "
                                "falling back to single-pass remediation."
                            ),
                        )
                        try:
                            fb_ok, fb_result = await self._run_step(
                                partial(
                                run_claude_remediation,
                                batch_scan_data,
                                cortex_context=self.context.cortex_context,
                                llm_provider=effective_llm_provider,
                                llm_api_key=effective_llm_api_key,
                                llm_model=effective_llm_model,
                                agent_analysis=agent_analysis,
                                budget_tracker=budget_tracker,
                            )
                        )
                            if fb_ok:
                                success, remediation_result = True, fb_result
                            else:
                                if "budget exceeded" in str(fb_result).lower():
                                    budget_exhausted = True
                                    await self._send_message("warning", f"Stopping remediation early: {fb_result}")
                                else:
                                    await self._send_message("warning", f"{batch_label} Fallback remediation failed: {fb_result}")
                        except Exception as _fb_exc:
                            await self._send_message("warning", f"{batch_label} Fallback remediation error: {_fb_exc}")

                if success:
                    summary = remediation_result.get("summary", "")
                    changed_files = remediation_result.get("changed_files", [])
                    rejected_changes = remediation_result.get("rejected_changes", [])
                    proposed_change_count = int(remediation_result.get("proposed_change_count", 0) or 0)
                    applied_change_count = int(remediation_result.get("applied_change_count", len(changed_files)) or 0)

                    cycle_proposed_changes += proposed_change_count
                    cycle_applied_changes += applied_change_count
                    if summary:
                        cycle_summary_parts.append(summary)
                    cycle_changed_files.extend(changed_files)
                    cycle_rejected_changes.extend(rejected_changes)

                    if changed_files:
                        await self._send_message(
                            "success",
                            (
                                f"{batch_label} Applied {len(changed_files)} file update(s) "
                                f"(proposed={proposed_change_count}, applied={applied_change_count})."
                            ),
                        )
                        for item in changed_files[:12]:
                            await self._send_message("info", f"Updated {item.get('path', 'unknown path')}")
                        await self._send_message("changed_files", json.dumps(changed_files))
                    else:
                        if proposed_change_count > 0:
                            await self._send_message(
                                "warning",
                                (
                                    f"{batch_label} Proposals were generated but no safe file updates were applied "
                                    f"(proposed={proposed_change_count}, applied={applied_change_count})."
                                ),
                            )
                        else:
                            await self._send_message("warning", f"{batch_label} Remediation agent produced no safe changes.")

                    if rejected_changes:
                        await self._send_message(
                            "warning",
                            f"{batch_label} {len(rejected_changes)} proposed change(s) were rejected by safety filters.",
                        )
                        for item in rejected_changes[:6]:
                            await self._send_message(
                                "info",
                                (
                                    f"Rejected path {item.get('path', 'unknown')}: "
                                    f"{item.get('reason', 'unspecified reason')}"
                                ),
                            )

                await self._send_message(
                    "info",
                    (
                        f"{batch_label} Claude spend so far: "
                        f"${budget_tracker.total_usd:.4f}/{budget_tracker.budget_cap_usd:.2f}"
                    ),
                )
                if budget_exhausted:
                    if processed_batches < len(remediation_batches):
                        await self._send_message(
                            "warning",
                            f"{batch_label} Budget cap reached; skipping remaining remediation batches in this cycle.",
                        )
                    break
                self._check_cancelled()

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
                "--- PASS METRICS ---",
                f"Strategy mode: {queue_stats.get('strategy_mode', 'default')}",
                f"Target: {target_label}",
                f"Remediation batches processed: {processed_batches}/{len(remediation_batches)}",
                f"Selection mode: {queue_stats.get('selection_mode', 'full')}",
                f"Code raw occurrences in scope: {queue_stats.get('code_raw_total', 0)}",
                f"Code root causes selected this cycle: {queue_stats.get('code_root_causes_selected', 0)}",
                f"Supply raw findings in scope: {queue_stats.get('supply_raw_total', 0)}",
                f"Supply root causes selected this cycle: {queue_stats.get('supply_root_causes_selected', 0)}",
                f"Proposed changes: {cycle_proposed_changes}",
                f"Applied changes: {cycle_applied_changes}",
                f"Claude spend so far (USD): {budget_tracker.total_usd:.6f}",
                f"Claude budget cap (USD): {budget_tracker.budget_cap_usd:.2f}",
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

            if budget_exhausted and cycle_applied_changes <= 0:
                await self._send_message(
                    "warning",
                    "Stopping remediation loop because the Claude budget cap was reached before any additional safe changes could be applied.",
                )
                break

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

            offer_round_decision = (
                cycle == 0
                and bool(cycle_changed_files)
                and cycle + 1 < MAX_REMEDIATION_CYCLES
                and not budget_exhausted
            )
            if offer_round_decision:
                next_action = await self._wait_for_round_decision()
                if next_action == "continue_round":
                    await self._send_message("info", "Invalidating previous scan cache")
                    await self._run_step(lambda: invalidate_cache(self.project_id))

                    rescanned = await self._run_rescan()
                    if not rescanned:
                        return await self._terminate("Security re-scan failed after the operator requested another remediation round.")

                    rescan_ok, rescan_data = await self._run_step(partial(get_scan_results, self.project_id))
                    if not rescan_ok:
                        return await self._terminate("Could not reload scan results after the operator requested another remediation round.")

                    overall_remaining = self._count_findings_for_scope(rescan_data, remediation_scope)
                    remaining_vulns = _count_findings_for_severities(rescan_data, target_severities)
                    next_scan_data, next_cycle_strategy = _select_cycle_scan_strategy(rescan_data, remediation_scope)
                    _ = next_scan_data
                    if remaining_vulns == 0:
                        if overall_remaining == 0:
                            await self._send_message(
                                "success",
                                f"{cycle_label} Verification scan shows no remaining findings in scope ({remediation_scope}). Proceeding to final approval.",
                            )
                        elif next_cycle_strategy.get("mode") == "large_repo_major_complete":
                            await self._send_message(
                                "success",
                                (
                                    f"{cycle_label} Verification scan cleared critical and high findings. "
                                    "Stopping remediation before medium/low severities."
                                ),
                            )
                        elif cycle_strategy.get("mode") == "large_repo_severity_staged":
                            next_stage = str(next_cycle_strategy.get("stage_severity") or "").upper() or "NEXT"
                            await self._send_message(
                                "success",
                                (
                                    f"{cycle_label} Verification scan cleared the current {target_label}. "
                                    f"{overall_remaining} finding(s) still remain in scope; next cycle will target {next_stage} findings."
                                ),
                            )
                        else:
                            await self._send_message(
                                "success",
                                f"{cycle_label} Verification scan cleared the current remediation target ({target_label}).",
                            )
                    else:
                        await self._send_message(
                            "info",
                            f"{cycle_label} {remaining_vulns} finding(s) remain in {target_label} after the first remediation round.",
                        )
                        if remaining_vulns >= cycle_remaining_baseline:
                            no_progress_cycles += 1
                            await self._send_message(
                                "warning",
                                (
                                    f"{cycle_label} Remaining {target_label} did not decrease "
                                    f"({remaining_vulns} >= {cycle_remaining_baseline}). "
                                    f"No-progress streak: {no_progress_cycles}/{REMEDIATION_NO_PROGRESS_LIMIT}."
                                ),
                            )
                            if no_progress_cycles >= REMEDIATION_NO_PROGRESS_LIMIT:
                                await self._send_message(
                                    "warning",
                                    "Stopping remediation due to repeated no-progress after verification rescans. Proceeding with the current fixes.",
                                )
                        else:
                            no_progress_cycles = 0

                    if (
                        overall_remaining > 0
                        and next_cycle_strategy.get("mode") != "large_repo_major_complete"
                        and no_progress_cycles < REMEDIATION_NO_PROGRESS_LIMIT
                    ):
                        await self._send_message(
                            "info",
                            f"Starting next remediation cycle ({cycle + 2}/{MAX_REMEDIATION_CYCLES})...",
                        )
                        scan_data = rescan_data
                        continue

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

            overall_remaining = self._count_findings_for_scope(rescan_data, remediation_scope)
            remaining_vulns = _count_findings_for_severities(rescan_data, target_severities)
            if remaining_vulns == 0:
                if overall_remaining == 0:
                    await self._send_message(
                        "success",
                        f"{cycle_label} No remaining findings in scope ({remediation_scope}). Remediation loop complete.",
                    )
                else:
                    next_scan_data, next_cycle_strategy = _select_cycle_scan_strategy(rescan_data, remediation_scope)
                    _ = next_scan_data
                    if next_cycle_strategy.get("mode") == "large_repo_major_complete":
                        await self._send_message(
                            "success",
                            (
                                f"{cycle_label} No remaining critical or high findings. "
                                "Stopping remediation before medium/low severities."
                            ),
                        )
                    elif cycle_strategy.get("mode") == "large_repo_severity_staged":
                        next_stage = str(next_cycle_strategy.get("stage_severity") or "").upper() or "NEXT"
                        await self._send_message(
                            "success",
                            (
                                f"{cycle_label} No remaining {target_label}. "
                                f"{overall_remaining} finding(s) still remain in scope; the next remediation run will target {next_stage} findings."
                            ),
                        )
                    else:
                        await self._send_message(
                            "success",
                            f"{cycle_label} No remaining findings in the current remediation target ({target_label}).",
                        )
            else:
                await self._send_message(
                    "info",
                    f"{cycle_label} {remaining_vulns} finding(s) remain in {target_label} after remediation.",
                )

            if remaining_vulns >= cycle_remaining_baseline:
                no_progress_cycles += 1
                await self._send_message(
                    "warning",
                    (
                        f"{cycle_label} Remaining {target_label} did not decrease "
                        f"({remaining_vulns} >= {cycle_remaining_baseline}). "
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
            if remaining_vulns < cycle_remaining_baseline:
                no_progress_cycles = 0

            await self._send_message(
                "info",
                "Approved remediation changes have been verified. Ending the remediation loop before any additional PR rounds.",
            )
            break

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

            if budget_exhausted:
                await self._send_message(
                    "warning",
                    "Ending remediation after the current approval/rescan cycle because the Claude budget cap has been reached.",
                )
                break

        await self._send_message(
            "success",
            f"Remediation loop completed successfully within budget (${budget_tracker.total_usd:.4f}/${budget_tracker.budget_cap_usd:.2f}).",
        )
        return True
