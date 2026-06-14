import functools

path = "remediation_pipeline/ingester.py"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace(
    'from typing import Any\n\nfrom remediation_pipeline.models import Vulnerability',
    'from typing import Any\nimport functools\n\nfrom remediation_pipeline.models import Vulnerability'
)

content = content.replace(
    '        for location in locations:\n            if not isinstance(location, dict):\n                continue\n            path = self._normalize_file_path(str(location.get("path") or ""), project_id)\n            if not path:\n                continue\n            candidate_path = path',
    '        for location in locations:\n            if not isinstance(location, dict):\n                continue\n            path = self._normalize_file_path(str(location.get("path") or ""), project_id)\n            if not path:\n                continue\n            if "/node_modules/" in f"/{path}" or "/vendor/" in f"/{path}":\n                continue\n            candidate_path = path'
)

content = content.replace(
    '    def _find_dependency_line(self, project_id: str, rel_path: str, package_name: str) -> int:\n        text = self._read_repo_file(project_id, rel_path)',
    '    @functools.lru_cache(maxsize=10000)\n    def _find_dependency_line(self, project_id: str, rel_path: str, package_name: str) -> int:\n        normalized = rel_path.lower()\n        if "lock" in normalized or normalized.endswith(".sum"):\n            return 1\n        text = self._read_repo_file(project_id, rel_path)'
)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)
