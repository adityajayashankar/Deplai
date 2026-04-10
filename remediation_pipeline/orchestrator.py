from __future__ import annotations

import asyncio
import base64
import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from inspect import isawaitable
from typing import Callable
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

from remediation_pipeline.extractor import SnippetExtractor
from remediation_pipeline.generator import FixGenerator
from remediation_pipeline.grouper import GrouperPrioritizer
from remediation_pipeline.ingester import VulnIngester
from remediation_pipeline.models import (
    Fix,
    ProviderStatusResponse,
    RemediationPRRequest,
    RemediationPRResponse,
    Vulnerability,
)
from remediation_pipeline.router import LLMRouter
from remediation_pipeline.validator import DiffValidator


class RemediationOrchestrator:
    """Coordinates the end-to-end remediation pipeline modules."""

    def __init__(self) -> None:
        self.ingester = VulnIngester()
        self.grouper = GrouperPrioritizer()
        self.extractor = SnippetExtractor()
        self.router = LLMRouter()
        self.generator = FixGenerator(self.router)
        self.validator = DiffValidator()
        self._validator_pool = ThreadPoolExecutor(max_workers=4)

    async def run(
        self,
        project_id: str,
        on_fix: Callable[[Fix], None] | None = None,
        on_progress: Callable[[str, str], object] | None = None,
        *,
        remediation_scope: str = "all",
        llm_provider: str | None = None,
        llm_api_key: str | None = None,
        llm_model: str | None = None,
        force_claude: bool = False,
    ) -> list[Fix]:
        vulnerabilities = self.ingester.ingest(project_id)
        groups = self.grouper.group(vulnerabilities)
        snapshot = self._build_snapshot(vulnerabilities, groups, remediation_scope=remediation_scope)
        selected_groups = self._select_groups_for_run(groups, snapshot)
        selected_vulnerabilities = self._selected_vulnerabilities(selected_groups)
        vuln_lookup: dict[str, Vulnerability] = {v.id: v for v in selected_vulnerabilities}

        loop = asyncio.get_running_loop()
        fixes: list[Fix] = []

        if on_progress is not None and snapshot["strategy_mode"] in {"critical_only", "high_only"}:
            reason = "Large repository strategy enabled" if snapshot["strategy_reason"] == "large_repo" else "Major-only scope enabled"
            await self._emit_progress(
                on_progress,
                "phase",
                (
                    f"{reason}: processing {str(snapshot['selected_severity']).upper()} file groups first "
                    "and stopping before medium/low severities."
                ),
            )
        if on_progress is not None and snapshot["force_claude"]:
            await self._emit_progress(
                on_progress,
                "info",
                "Claude SDK forced for staged large-repository remediation.",
            )

        batch_size = max(1, int(os.getenv("REMEDIATION_PIPELINE_GROUPS_PER_BATCH", "8")))
        ordered_groups = self._ordered_groups_for_run(selected_groups)
        total_batches = max(1, (len(ordered_groups) + batch_size - 1) // batch_size) if ordered_groups else 1

        for batch_index in range(0, len(ordered_groups), batch_size):
            group_batch = ordered_groups[batch_index:batch_index + batch_size]
            batch_number = (batch_index // batch_size) + 1
            if on_progress is not None:
                severities = sorted({group.max_severity.upper() for group in group_batch}) or ["NONE"]
                await self._emit_progress(
                    on_progress,
                    "info",
                    (
                        f"Batch {batch_number}/{total_batches}: processing {len(group_batch)} file group(s) "
                        f"covering {', '.join(severities)} severities "
                        f"({snapshot['selected_findings']} finding(s) in active stage)."
                    ),
                )
            for group in group_batch:
                try:
                    if on_progress is not None:
                        await self._emit_progress(
                            on_progress,
                            "info",
                            f"Analyzing {group.filepath} ({group.max_severity.upper()}, {len(group.vulns)} finding(s)).",
                        )
                    bundles = self.extractor.extract(project_id, group)
                except Exception as exc:
                    if on_progress is not None:
                        await self._emit_progress(
                            on_progress,
                            "warning",
                            f"{group.filepath}: failed to extract source snippets ({type(exc).__name__}: {exc}).",
                        )
                    continue

                if not bundles:
                    if on_progress is not None:
                        await self._emit_progress(
                            on_progress,
                            "warning",
                            f"{group.filepath}: no readable source snippets were extracted for this file group.",
                        )
                    continue

                for bundle in bundles:
                    try:
                        fix = await loop.run_in_executor(
                            None,
                            self.generator.generate,
                            bundle,
                            vuln_lookup,
                            llm_provider,
                            llm_api_key,
                            llm_model,
                            force_claude or bool(snapshot["force_claude"]),
                        )
                    except Exception as exc:
                        if on_progress is not None:
                            await self._emit_progress(
                                on_progress,
                                "warning",
                                f"{bundle.filepath}: fix generation crashed ({type(exc).__name__}: {exc}).",
                            )
                        continue

                    try:
                        validated = await loop.run_in_executor(self._validator_pool, self.validator.validate, project_id, fix)
                    except Exception as exc:
                        if on_progress is not None:
                            await self._emit_progress(
                                on_progress,
                                "warning",
                                f"{bundle.filepath}: diff validation crashed ({type(exc).__name__}: {exc}).",
                            )
                        continue

                    if validated is None:
                        if on_progress is not None:
                            await self._emit_progress(
                                on_progress,
                                "warning",
                                f"{bundle.filepath}: generated diff could not be applied cleanly and was dropped.",
                            )
                        continue
                    fixes.append(validated)
                    if on_fix is not None:
                        on_fix(validated)

        return fixes

    def status(self) -> ProviderStatusResponse:
        return self.router.status()

    def refresh(self, project_id: str, remediation_scope: str = "all") -> dict[str, int | str]:
        vulnerabilities = self.ingester.ingest(project_id)
        groups = self.grouper.group(vulnerabilities)
        snapshot = self._build_snapshot(vulnerabilities, groups, remediation_scope=remediation_scope)
        return {
            "vulnerabilities": len(vulnerabilities),
            "groups": len(groups),
            "critical": snapshot["severity_counts"]["critical"],
            "high": snapshot["severity_counts"]["high"],
            "medium": snapshot["severity_counts"]["medium"],
            "low": snapshot["severity_counts"]["low"],
            "selected_groups": snapshot["selected_groups"],
            "selected_findings": snapshot["selected_findings"],
            "selected_severity": str(snapshot["selected_severity"] or ""),
            "strategy_mode": snapshot["strategy_mode"],
            "strategy_reason": snapshot["strategy_reason"],
            "stop_after_major": int(snapshot["stop_after_major"]),
            "force_claude": int(snapshot["force_claude"]),
        }

    @staticmethod
    async def _emit_progress(on_progress: Callable[[str, str], object], msg_type: str, content: str) -> None:
        result = on_progress(msg_type, content)
        if isawaitable(result):
            await result

    @staticmethod
    def _severity_rank(severity: str) -> int:
        return {"critical": 4, "high": 3, "medium": 2, "low": 1}.get(str(severity or "").lower(), 0)

    def _build_snapshot(
        self,
        vulnerabilities: list[Vulnerability],
        groups: list,
        *,
        remediation_scope: str = "all",
    ) -> dict[str, object]:
        threshold = max(1, int(os.getenv("REMEDIATION_LARGE_FINDING_THRESHOLD", "1000")))
        normalized_scope = "major" if str(remediation_scope or "").strip().lower() == "major" else "all"
        severity_counts = {"critical": 0, "high": 0, "medium": 0, "low": 0}
        for vuln in vulnerabilities:
            severity_counts[vuln.severity] = severity_counts.get(vuln.severity, 0) + 1

        strategy_mode = "default"
        strategy_reason = "default"
        stop_after_major = False
        force_claude = False
        selected_severity: str | None = None
        selected_subset = list(groups)

        threshold_exceeded = len(vulnerabilities) > threshold
        major_only_requested = normalized_scope == "major" or threshold_exceeded

        if major_only_requested:
            stop_after_major = True
            strategy_reason = "large_repo" if threshold_exceeded else "scope_major"
            force_claude = threshold_exceeded
            critical_groups = [group for group in groups if group.max_severity == "critical"]
            high_groups = [group for group in groups if group.max_severity == "high"]
            if critical_groups:
                strategy_mode = "critical_only"
                selected_severity = "critical"
                selected_subset = critical_groups
            elif high_groups:
                strategy_mode = "high_only"
                selected_severity = "high"
                selected_subset = high_groups
            else:
                strategy_mode = "major_complete"
                selected_subset = []

        return {
            "severity_counts": severity_counts,
            "selected_groups": len(selected_subset),
            "selected_findings": sum(len(group.vulns) for group in selected_subset),
            "selected_severity": selected_severity,
            "strategy_mode": strategy_mode,
            "strategy_reason": strategy_reason,
            "stop_after_major": stop_after_major,
            "force_claude": force_claude,
        }

    @staticmethod
    def _selected_vulnerabilities(groups: list) -> list[Vulnerability]:
        deduped: dict[str, Vulnerability] = {}
        for group in groups:
            for vuln in group.vulns:
                deduped[vuln.id] = vuln
        return list(deduped.values())

    def _select_groups_for_run(self, groups: list, snapshot: dict[str, object]) -> list:
        if snapshot.get("strategy_mode") == "critical_only":
            return [group for group in groups if group.max_severity == "critical"]
        if snapshot.get("strategy_mode") == "high_only":
            return [group for group in groups if group.max_severity == "high"]
        return groups

    def _ordered_groups_for_run(self, groups: list) -> list:
        return sorted(
            groups,
            key=lambda item: (-self._severity_rank(item.max_severity), item.filepath),
        )

    def create_pr(self, payload: RemediationPRRequest) -> RemediationPRResponse:
        owner, repo = self._parse_repo_url(payload.repository_url)
        project_fragment = str(payload.project_id or "").strip()[:8]
        timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
        branch = f"deplai/fix-{project_fragment}-{timestamp}" if project_fragment else f"deplai/fix-{timestamp}"

        repo_info = self._github_request("GET", f"/repos/{owner}/{repo}", payload.github_token)
        default_branch = str(repo_info.get("default_branch") or "main")

        ref = self._github_request(
            "GET",
            f"/repos/{owner}/{repo}/git/ref/heads/{default_branch}",
            payload.github_token,
        )
        base_sha = str(((ref.get("object") or {}).get("sha")) or "")
        if not base_sha:
            raise RuntimeError("Unable to resolve base branch SHA")

        self._github_request(
            "POST",
            f"/repos/{owner}/{repo}/git/refs",
            payload.github_token,
            body={"ref": f"refs/heads/{branch}", "sha": base_sha},
        )

        accepted = set(payload.accepted_filepaths)
        selected_fixes = [
            fix for fix in payload.fixes if (not accepted or fix.filepath in accepted)
        ]
        if not selected_fixes:
            return RemediationPRResponse(
                success=False,
                message="No accepted fixes were provided for PR creation",
            )

        for fix in selected_fixes:
            content_resp = self._github_request(
                "GET",
                f"/repos/{owner}/{repo}/contents/{urlparse.quote(fix.filepath, safe='/')}?ref={urlparse.quote(branch)}",
                payload.github_token,
            )
            source_b64 = str(content_resp.get("content") or "")
            source_sha = str(content_resp.get("sha") or "")
            source_text = base64.b64decode(source_b64.encode("utf-8")).decode("utf-8")
            patched_text = self.validator._apply_unified_diff(source_text, fix.diff)

            self._github_request(
                "PUT",
                f"/repos/{owner}/{repo}/contents/{urlparse.quote(fix.filepath, safe='/')}",
                payload.github_token,
                body={
                    "message": f"security: remediate {fix.filepath}",
                    "content": base64.b64encode(patched_text.encode("utf-8")).decode("utf-8"),
                    "sha": source_sha,
                    "branch": branch,
                },
            )

        body_rows = "\n".join(
            f"| {', '.join(fix.vulns_addressed)} | {fix.filepath} | {fix.status} |"
            for fix in selected_fixes
        )
        pr_payload = {
            "title": f"[DeplAI] Security fixes - {len(selected_fixes)} files updated",
            "head": branch,
            "base": default_branch,
            "body": "\n".join(
                [
                    "Automated fixes generated by DeplAI remediation pipeline.",
                    "",
                    "| Vulnerability IDs | File | Validation |",
                    "|---|---|---|",
                    body_rows,
                ]
            ),
        }
        pr = self._github_request("POST", f"/repos/{owner}/{repo}/pulls", payload.github_token, body=pr_payload)

        return RemediationPRResponse(
            success=True,
            pr_url=str(pr.get("html_url") or ""),
            branch=branch,
            message="Pull request created",
        )

    @staticmethod
    def _parse_repo_url(url: str) -> tuple[str, str]:
        value = str(url or "").strip().replace(".git", "")
        if value.startswith("https://github.com/"):
            parts = value[len("https://github.com/") :].split("/")
            if len(parts) >= 2:
                return parts[0], parts[1]
        if value.count("/") == 1:
            owner, repo = value.split("/", 1)
            return owner, repo
        raise ValueError("repository_url must be in the form https://github.com/{owner}/{repo}")

    @staticmethod
    def _github_request(method: str, path: str, token: str, body: dict | None = None) -> dict:
        url = "https://api.github.com" + path
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "deplai-agentic/1.0",
        }
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        if payload is not None:
            headers["Content-Type"] = "application/json"

        req = urlrequest.Request(url, data=payload, headers=headers, method=method)
        try:
            with urlrequest.urlopen(req, timeout=20) as resp:
                text = resp.read().decode("utf-8")
                return json.loads(text) if text else {}
        except urlerror.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"GitHub API error {exc.code}: {raw}") from exc
