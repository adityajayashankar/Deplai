from __future__ import annotations

import asyncio
import base64
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
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

    async def run(self, project_id: str, on_fix: Callable[[Fix], None] | None = None) -> list[Fix]:
        vulnerabilities = self.ingester.ingest(project_id)
        groups = self.grouper.group(vulnerabilities)
        vuln_lookup: dict[str, Vulnerability] = {v.id: v for v in vulnerabilities}

        loop = asyncio.get_running_loop()
        fixes: list[Fix] = []

        for group in groups:
            bundles = self.extractor.extract(project_id, group)
            for bundle in bundles:
                fix = await loop.run_in_executor(None, self.generator.generate, bundle, vuln_lookup)
                validated = await loop.run_in_executor(self._validator_pool, self.validator.validate, project_id, fix)
                if validated is None:
                    continue
                fixes.append(validated)
                if on_fix is not None:
                    on_fix(validated)

        return fixes

    def status(self) -> ProviderStatusResponse:
        return self.router.status()

    def refresh(self, project_id: str) -> dict[str, int]:
        vulnerabilities = self.ingester.ingest(project_id)
        groups = self.grouper.group(vulnerabilities)
        return {
            "vulnerabilities": len(vulnerabilities),
            "groups": len(groups),
        }

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
