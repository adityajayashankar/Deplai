from __future__ import annotations

from collections import defaultdict

from remediation_pipeline.models import FileGroup, Vulnerability


_SEVERITY_SCORE = {"critical": 4, "high": 3, "medium": 2, "low": 1}
_LANGUAGE_BY_EXT = {
    ".py": "Python",
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".go": "Go",
    ".java": "Java",
    ".rb": "Ruby",
    ".php": "PHP",
    ".cs": "C#",
    ".json": "JSON",
    ".toml": "TOML",
    ".yml": "YAML",
    ".yaml": "YAML",
    ".xml": "XML",
    ".gradle": "Gradle",
    ".lock": "Lockfile",
}


class GrouperPrioritizer:
    """Group vulnerabilities by file, deduplicate, and prioritize by severity."""

    def group(self, vulnerabilities: list[Vulnerability]) -> list[FileGroup]:
        by_file: dict[str, list[Vulnerability]] = defaultdict(list)
        for vuln in vulnerabilities:
            by_file[vuln.file].append(vuln)

        groups: list[FileGroup] = []
        for filepath, vulns in by_file.items():
            dedup: dict[tuple[str, int], Vulnerability] = {}
            for vuln in vulns:
                key = (vuln.rule_id, vuln.line_start)
                existing = dedup.get(key)
                if existing is None:
                    dedup[key] = vuln
                else:
                    if _SEVERITY_SCORE[vuln.severity] > _SEVERITY_SCORE[existing.severity]:
                        dedup[key] = vuln

            sorted_vulns = sorted(dedup.values(), key=lambda item: (item.line_start, item.line_end, item.rule_id))
            max_sev = max(sorted_vulns, key=lambda item: _SEVERITY_SCORE[item.severity]).severity
            groups.append(
                FileGroup(
                    filepath=filepath,
                    language=self._detect_language(filepath),
                    vulns=sorted_vulns,
                    max_severity=max_sev,
                )
            )

        groups.sort(key=lambda item: (-_SEVERITY_SCORE[item.max_severity], item.filepath))
        return groups

    @staticmethod
    def _detect_language(filepath: str) -> str:
        lower = filepath.lower()
        for ext, language in _LANGUAGE_BY_EXT.items():
            if lower.endswith(ext):
                return language
        return "Text"
