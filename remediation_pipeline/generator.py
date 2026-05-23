from __future__ import annotations

import difflib
import json
import re

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
        deterministic_vulns = self._deterministic_sca_vulnerabilities(ordered_vulns)
        deterministic_diff = self._build_deterministic_sca_diff(bundle, deterministic_vulns)
        if deterministic_diff:
            return Fix(
                filepath=bundle.filepath,
                diff=deterministic_diff,
                vulns_addressed=[vuln.id for vuln in deterministic_vulns],
                provider_used="deterministic",
                tokens_used=0,
                status="auto",
                raw_response="deterministic-sca-fix",
                warnings=[] if len(deterministic_vulns) == len(ordered_vulns) else ["Some SCA findings had no direct deterministic manifest update"],
            )
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

    @classmethod
    def _build_deterministic_sca_diff(cls, bundle: SnippetBundle, vulnerabilities: list[Vulnerability]) -> str:
        if not vulnerabilities:
            return ""

        original = bundle.source_text
        lower_path = bundle.filepath.lower()
        if lower_path.endswith("requirements.txt"):
            updated = cls._patch_requirements_txt(original, vulnerabilities)
        elif lower_path.endswith("package.json"):
            updated = cls._patch_package_json(original, vulnerabilities)
        elif lower_path.endswith("go.mod"):
            updated = cls._patch_go_mod(original, vulnerabilities)
        else:
            return ""

        if not updated or updated == original:
            return ""
        return "\n".join(
            difflib.unified_diff(
                original.splitlines(),
                updated.splitlines(),
                fromfile=f"a/{bundle.filepath}",
                tofile=f"b/{bundle.filepath}",
                lineterm="",
            )
        ).strip()

    @staticmethod
    def _deterministic_sca_vulnerabilities(vulnerabilities: list[Vulnerability]) -> list[Vulnerability]:
        if not vulnerabilities or any(v.type != "sca" for v in vulnerabilities):
            return []
        return [
            vuln
            for vuln in vulnerabilities
            if str(vuln.package_name or "").strip() and str(vuln.fix_version or "").strip()
        ]

    @classmethod
    def _patch_requirements_txt(cls, source: str, vulnerabilities: list[Vulnerability]) -> str:
        updates = cls._dependency_updates(vulnerabilities)
        if not updates:
            return source

        changed = False
        lines: list[str] = []
        for line in source.splitlines():
            next_line = line
            for package_name, fix_version in updates.items():
                name_pattern = re.escape(package_name) + r"(?:\[[^\]]+\])?"
                pattern = re.compile(
                    rf"^(\s*{name_pattern}\s*)(===|==|~=|>=|<=|>|<)\s*([^#;\s]+)(.*)$",
                    re.IGNORECASE,
                )
                match = pattern.match(next_line)
                if not match:
                    continue
                prefix, operator, current_version, suffix = match.groups()
                if current_version == fix_version:
                    break
                next_line = f"{prefix}{operator}{fix_version}{suffix}"
                changed = True
                break
            lines.append(next_line)

        if not changed:
            return source
        updated = "\n".join(lines)
        return updated + ("\n" if source.endswith("\n") else "")

    @classmethod
    def _patch_package_json(cls, source: str, vulnerabilities: list[Vulnerability]) -> str:
        try:
            data = json.loads(source)
        except Exception:
            return source
        if not isinstance(data, dict):
            return source

        updates = cls._dependency_updates(vulnerabilities)
        changed = False
        for section in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
            deps = data.get(section)
            if not isinstance(deps, dict):
                continue
            for package_name, fix_version in updates.items():
                current = deps.get(package_name)
                if not isinstance(current, str):
                    continue
                current_trimmed = current.strip()
                if current_trimmed.startswith(("file:", "link:", "workspace:", "git+", "github:", "http://", "https://")):
                    continue
                prefix = "^" if current_trimmed.startswith("^") else "~" if current_trimmed.startswith("~") else ""
                next_value = f"{prefix}{fix_version}"
                if deps[package_name] == next_value:
                    continue
                deps[package_name] = next_value
                changed = True

        if not changed:
            return source
        return json.dumps(data, indent=2) + "\n"

    @classmethod
    def _patch_go_mod(cls, source: str, vulnerabilities: list[Vulnerability]) -> str:
        updates = cls._dependency_updates(vulnerabilities)
        if not updates:
            return source

        changed = False
        lines: list[str] = []
        for line in source.splitlines():
            next_line = line
            for package_name, fix_version in updates.items():
                pattern = re.compile(rf"^(\s*{re.escape(package_name)}\s+)v?([^\s]+)(.*)$")
                match = pattern.match(next_line)
                if not match:
                    continue
                prefix, current_version, suffix = match.groups()
                target = fix_version if fix_version.startswith("v") else f"v{fix_version}"
                if current_version == target.lstrip("v") or f"v{current_version}" == target:
                    break
                next_line = f"{prefix}{target}{suffix}"
                changed = True
                break
            lines.append(next_line)

        if not changed:
            return source
        updated = "\n".join(lines)
        return updated + ("\n" if source.endswith("\n") else "")

    @classmethod
    def _dependency_updates(cls, vulnerabilities: list[Vulnerability]) -> dict[str, str]:
        updates: dict[str, str] = {}
        for vuln in vulnerabilities:
            package_name = str(vuln.package_name or "").strip()
            fix_version = str(vuln.fix_version or "").strip()
            if not package_name or not fix_version:
                continue
            current = updates.get(package_name)
            if current is None or cls._version_key(fix_version) > cls._version_key(current):
                updates[package_name] = fix_version
        return updates

    @staticmethod
    def _version_key(version: str) -> tuple[tuple[int | str, ...], str]:
        parts: list[int | str] = []
        for token in re.split(r"([0-9]+)", str(version).lower()):
            if not token:
                continue
            parts.append(int(token) if token.isdigit() else token)
        return tuple(parts), str(version)

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
