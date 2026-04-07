from __future__ import annotations

from remediation_pipeline.models import FileGroup, Snippet, SnippetBundle, Vulnerability
from utils import CODEBASE_VOLUME, decode_output, get_docker_client


MAX_BUNDLE_CHARS = 9000


class SnippetExtractor:
    """Extract minimal vulnerability-centric snippets from repository files."""

    def extract(self, project_id: str, group: FileGroup) -> list[SnippetBundle]:
        content = self._read_repo_file(project_id, group.filepath)
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
        if snippets and all(s.line_start > 15 for s in snippets):
            imports_block = "\n".join(lines[:15])

        bundles: list[SnippetBundle] = []
        current: list[Snippet] = []
        current_chars = len(imports_block)

        for snippet in snippets:
            snippet_chars = len(snippet.code)
            if current and current_chars + snippet_chars > MAX_BUNDLE_CHARS:
                bundles.append(self._build_bundle(group, imports_block, current))
                current = []
                current_chars = len(imports_block)
            current.append(snippet)
            current_chars += snippet_chars

        if current:
            bundles.append(self._build_bundle(group, imports_block, current))

        return bundles

    @staticmethod
    def _window_for_vuln(vuln: Vulnerability, total_lines: int) -> tuple[int, int]:
        if vuln.type == "sca":
            start = max(1, vuln.line_start - 3)
            end = min(total_lines, vuln.line_end + 3)
            return start, max(start, end)
        start = max(1, vuln.line_start - 30)
        end = min(total_lines, vuln.line_end + 30)
        return start, max(start, end)

    @staticmethod
    def _build_bundle(group: FileGroup, imports_block: str, snippets: list[Snippet]) -> SnippetBundle:
        total_chars = len(imports_block) + sum(len(s.code) for s in snippets)
        token_estimate = max(1, total_chars // 4)
        return SnippetBundle(
            filepath=group.filepath,
            language=group.language,
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
