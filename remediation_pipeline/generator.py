from __future__ import annotations

from remediation_pipeline.models import Fix, SnippetBundle, Vulnerability
from remediation_pipeline.router import LLMRouter


_ALLOWED_DIFF_PREFIXES = ("---", "+++", "@@", " ", "+", "-")


class FixGenerator:
    """Build prompts, call the LLM router, and parse unified diff responses."""

    def __init__(self, router: LLMRouter) -> None:
        self._router = router

    def generate(
        self,
        bundle: SnippetBundle,
        vuln_lookup: dict[str, Vulnerability],
        llm_provider: str | None = None,
        llm_api_key: str | None = None,
        llm_model: str | None = None,
        force_claude: bool = False,
    ) -> Fix:
        ordered_vulns = [vuln_lookup[s.vuln_id] for s in bundle.snippets if s.vuln_id in vuln_lookup]
        prompt = self._build_prompt(bundle, ordered_vulns)

        try:
            response_text, provider, tokens_used = self._router.route(
                prompt,
                bundle.token_estimate,
                preferred_provider=llm_provider,
                preferred_api_key=llm_api_key,
                preferred_model=llm_model,
                force_claude=force_claude,
            )
        except Exception as exc:
            return Fix(
                filepath=bundle.filepath,
                diff="",
                vulns_addressed=[s.vuln_id for s in bundle.snippets],
                provider_used="none",
                tokens_used=0,
                status="needs_review",
                raw_response=str(exc),
                warnings=["Provider routing failed"],
            )

        diff = self._extract_unified_diff(response_text, bundle)
        if not diff:
            return Fix(
                filepath=bundle.filepath,
                diff="",
                vulns_addressed=[s.vuln_id for s in bundle.snippets],
                provider_used=provider,
                tokens_used=tokens_used,
                status="needs_review",
                raw_response=response_text,
                warnings=["No valid unified diff returned by model"],
            )

        return Fix(
            filepath=bundle.filepath,
            diff=diff,
            vulns_addressed=[s.vuln_id for s in bundle.snippets],
            provider_used=provider,
            tokens_used=tokens_used,
            status="auto",
            raw_response=response_text,
        )

    @staticmethod
    def _build_prompt(bundle: SnippetBundle, vulnerabilities: list[Vulnerability]) -> str:
        vuln_lines = "\n".join(
            f"- [{v.id}] {v.severity.upper()} {v.rule_id} lines {v.line_start}-{v.line_end}: {v.description}"
            for v in vulnerabilities
        )
        snippets = "\n\n".join(
            f"[Snippet for {snippet.vuln_id} lines {snippet.line_start}-{snippet.line_end}]\n{snippet.code}"
            for snippet in bundle.snippets
        )

        return f"""You are a security fix assistant. Given a code snippet and vulnerabilities,
return ONLY a unified diff (--- / +++ format) that fixes all listed issues.
Do not explain. Do not include unchanged lines beyond the hunk context.

File: {bundle.filepath}
Language: {bundle.language}
Vulnerabilities:
{vuln_lines}

Imports:
{bundle.imports_block}

Code:
{snippets}
"""

    @staticmethod
    def _extract_unified_diff(raw: str, bundle: SnippetBundle) -> str:
        lines = str(raw or "").splitlines()

        # Strip markdown fences if they exist.
        if any(line.strip().startswith("```") for line in lines):
            filtered: list[str] = []
            inside_fence = False
            for line in lines:
                stripped = line.strip()
                if stripped.startswith("```"):
                    inside_fence = not inside_fence
                    continue
                if inside_fence:
                    filtered.append(line)
            if filtered:
                lines = filtered

        diff_lines = [line for line in lines if line.startswith(_ALLOWED_DIFF_PREFIXES)]
        if not diff_lines:
            return ""

        header_old = f"--- a/{bundle.filepath}"
        header_new = f"+++ b/{bundle.filepath}"

        normalized: list[str] = []
        for line in diff_lines:
            stripped = line.strip()
            if stripped == "---":
                normalized.append(header_old)
                continue
            if stripped == "+++":
                normalized.append(header_new)
                continue
            normalized.append(line)
        diff_lines = normalized

        has_old = any(line.startswith("---") for line in diff_lines)
        has_new = any(line.startswith("+++") for line in diff_lines)
        body_lines = [line for line in diff_lines if not line.startswith(("---", "+++", "@@"))]

        if not has_old or not has_new:
            diff_lines = [header_old, header_new, *body_lines]

        if not any(line.startswith("@@") for line in diff_lines):
            has_change = any(line.startswith("+") and not line.startswith("+++") for line in body_lines) or any(
                line.startswith("-") and not line.startswith("---") for line in body_lines
            )
            if not has_change:
                return ""
            start = FixGenerator._guess_hunk_start(bundle, body_lines)
            old_count = sum(1 for line in body_lines if line.startswith(" ") or (line.startswith("-") and not line.startswith("---")))
            new_count = sum(1 for line in body_lines if line.startswith(" ") or (line.startswith("+") and not line.startswith("+++")))
            hunk = f"@@ -{start},{max(1, old_count)} +{start},{max(1, new_count)} @@"
            diff_lines = [header_old, header_new, hunk, *body_lines]

        if not any(line.startswith("@@") for line in diff_lines):
            return ""
        if not any(line.startswith("---") for line in diff_lines):
            return ""
        if not any(line.startswith("+++") for line in diff_lines):
            return ""
        return "\n".join(diff_lines).strip()

    @staticmethod
    def _guess_hunk_start(bundle: SnippetBundle, body_lines: list[str]) -> int:
        removed_lines = [line[1:] for line in body_lines if line.startswith("-") and not line.startswith("---")]
        if removed_lines:
            target = removed_lines[0]
            for snippet in bundle.snippets:
                snippet_lines = snippet.code.splitlines()
                has_marker = bool(snippet_lines and "VULN:" in snippet_lines[0])
                for idx, line in enumerate(snippet_lines):
                    if line != target:
                        continue
                    offset = idx - 1 if has_marker else idx
                    return max(1, snippet.line_start + max(0, offset))
        return min((snippet.line_start for snippet in bundle.snippets), default=1)
