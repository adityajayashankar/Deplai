from __future__ import annotations

import os

from remediation_pipeline.models import FileGroup, Snippet, SnippetBundle, Vulnerability
from utils import CODEBASE_VOLUME, decode_output, get_docker_client


def _positive_int_env(name: str, default: int, minimum: int = 1) -> int:
    try:
        parsed = int(str(os.getenv(name, "")).strip() or default)
    except (TypeError, ValueError):
        return default
    return max(minimum, parsed)


MAX_BUNDLE_CHARS = _positive_int_env("REMEDIATION_SNIPPET_MAX_BUNDLE_CHARS", 6000, 1000)
SAST_CONTEXT_LINES = _positive_int_env("REMEDIATION_SAST_CONTEXT_LINES", 12, 2)
SCA_CONTEXT_LINES = _positive_int_env("REMEDIATION_SCA_CONTEXT_LINES", 2, 1)
IMPORT_CONTEXT_LINES = _positive_int_env("REMEDIATION_IMPORT_CONTEXT_LINES", 12, 0)


class SnippetExtractor:
    """Extract minimal vulnerability-centric snippets from repository files."""

    def extract(self, project_id: str, group: FileGroup) -> list[SnippetBundle]:
        content = self._read_repo_file(project_id, group.filepath)
        return self.extract_from_content(content, group)

    def extract_from_content(self, content: str, group: FileGroup) -> list[SnippetBundle]:
        if not content:
            return []

        lines = content.splitlines()
        total_lines = len(lines)
        if total_lines == 0:
            return []

        snippets: list[Snippet] = []
        for vuln in group.vulns:
            start, end = self._window_for_vuln(vuln, total_lines)
            code_window = "\n".join(lines[start - 1 : end])
            marker = self._marker(group.language, vuln)
            snippets.append(
                Snippet(
                    vuln_id=vuln.id,
                    line_start=start,
                    line_end=end,
                    code=f"{marker}\n{code_window}",
                )
            )

        imports_block = ""
        if IMPORT_CONTEXT_LINES > 0 and snippets and all(s.line_start > IMPORT_CONTEXT_LINES for s in snippets):
            imports_block = "\n".join(lines[:IMPORT_CONTEXT_LINES])

        bundles: list[SnippetBundle] = []
        current: list[Snippet] = []
        current_chars = len(imports_block)

        for snippet in snippets:
            snippet_chars = len(snippet.code)
            if current and current_chars + snippet_chars > MAX_BUNDLE_CHARS:
                bundles.append(self._build_bundle(group, content, imports_block, current))
                current = []
                current_chars = len(imports_block)
            current.append(snippet)
            current_chars += snippet_chars

        if current:
            bundles.append(self._build_bundle(group, content, imports_block, current))

        return bundles

    @staticmethod
    def _window_for_vuln(vuln: Vulnerability, total_lines: int) -> tuple[int, int]:
        if vuln.type == "sca":
            start = max(1, vuln.line_start - SCA_CONTEXT_LINES)
            end = min(total_lines, vuln.line_end + SCA_CONTEXT_LINES)
            return start, max(start, end)
        start = max(1, vuln.line_start - SAST_CONTEXT_LINES)
        end = min(total_lines, vuln.line_end + SAST_CONTEXT_LINES)
        return start, max(start, end)

    @staticmethod
    def _build_bundle(group: FileGroup, source_text: str, imports_block: str, snippets: list[Snippet]) -> SnippetBundle:
        total_chars = len(imports_block) + sum(len(s.code) for s in snippets)
        token_estimate = max(1, total_chars // 4)
        return SnippetBundle(
            filepath=group.filepath,
            language=group.language,
            source_text=source_text,
            imports_block=imports_block,
            snippets=snippets,
            token_estimate=token_estimate,
        )

    @staticmethod
    def _marker(language: str, vuln: Vulnerability) -> str:
        comment = "#"
        lang = (language or "").lower()
        if lang in {"javascript", "typescript", "java", "go", "c#", "php"}:
            comment = "//"
        elif lang in {"xml", "html"}:
            comment = "<!--"
        descriptor = f"VULN: {vuln.rule_id} - {vuln.description}"
        if comment == "<!--":
            return f"<!-- {descriptor} -->"
        return f"{comment} {descriptor}"

    @staticmethod
    def _read_repo_file(project_id: str, rel_path: str) -> str:
        cleaned = str(rel_path or "").strip().replace("\\", "/").lstrip("/")
        if not cleaned:
            return ""
        try:
            output = get_docker_client().containers.run(
                "alpine",
                command=["cat", f"/repo/{project_id}/{cleaned}"],
                volumes={CODEBASE_VOLUME: {"bind": "/repo", "mode": "ro"}},
                remove=True,
            )
            return decode_output(output)
        except Exception:
            return ""
