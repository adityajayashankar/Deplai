from __future__ import annotations

import json
import re
from typing import Any
import functools

from remediation_pipeline.models import Vulnerability
from utils import CODEBASE_VOLUME, decode_output, find_volume_file, get_docker_client, read_volume_file


_SEVERITY_MAP = {
    "critical": "critical",
    "high": "high",
    "medium": "medium",
    "low": "low",
}

_EDITABLE_MANIFEST_BY_LOCKFILE = {
    "package-lock.json": ("package.json",),
    "npm-shrinkwrap.json": ("package.json",),
    "yarn.lock": ("package.json",),
    "pnpm-lock.yaml": ("package.json",),
    "go.sum": ("go.mod",),
}

_DIRECTLY_EDITABLE_MANIFESTS = {
    "package.json",
    "requirements.txt",
    "go.mod",
}


_NOISE_PATH_MARKERS = ("/node_modules/", "/vendor/", "/.next/", "/dist/", "/build/", "/coverage/")


class VulnIngester:
    """Read scanner artifacts from Docker volumes and normalize into Vulnerability records."""

    def __init__(self) -> None:
        self._repo_file_cache: dict[tuple[str, str], str] = {}

    def ingest(self, project_id: str) -> list[Vulnerability]:
        vulns: list[Vulnerability] = []
        vulns.extend(self._read_sast(project_id))
        vulns.extend(self._read_sca(project_id))
        return vulns

    def _read_sast(self, project_id: str) -> list[Vulnerability]:
        report = find_volume_file(project_id, "Bearer.json")
        raw = read_volume_file(report) if report else None
        if not raw:
            return []

        data = self._load_json(raw)
        if not isinstance(data, dict):
            return []

        out: list[Vulnerability] = []
        for sev_bucket, findings in data.items():
            severity = self._normalize_severity(sev_bucket)
            if severity is None or not isinstance(findings, list):
                continue
            for idx, item in enumerate(findings):
                if not isinstance(item, dict):
                    continue
                file_path = self._normalize_file_path(str(item.get("filename") or ""), project_id)
                if not file_path:
                    continue
                line_start = self._safe_int(item.get("line_number"), 1)
                line_end = max(line_start, self._safe_int(item.get("end_line"), line_start))
                cwe_ids = item.get("cwe_ids") if isinstance(item.get("cwe_ids"), list) else []
                cwe = str(cwe_ids[0]).strip() if cwe_ids else None
                rule_id = str(item.get("id") or item.get("check_id") or cwe or "bearer-rule").strip()
                description = str(item.get("title") or item.get("description") or "Security issue").strip()
                finding_id = str(item.get("fingerprint") or item.get("id") or f"sast:{rule_id}:{file_path}:{line_start}:{idx}")

                out.append(
                    Vulnerability(
                        id=finding_id,
                        file=file_path,
                        line_start=line_start,
                        line_end=line_end,
                        rule_id=rule_id,
                        severity=severity,
                        description=description,
                        cwe=cwe,
                        type="sast",
                    )
                )
        return out

    def _read_sca(self, project_id: str) -> list[Vulnerability]:
        report = find_volume_file(project_id, "Grype.json")
        raw = read_volume_file(report) if report else None
        if not raw:
            return []

        data = self._load_json(raw)
        if not isinstance(data, dict):
            return []

        matches = data.get("matches") if isinstance(data.get("matches"), list) else []
        out: list[Vulnerability] = []
        seen_keys: set[str] = set()
        for idx, match in enumerate(matches):
            if not isinstance(match, dict):
                continue
            vuln = match.get("vulnerability") if isinstance(match.get("vulnerability"), dict) else {}
            artifact = match.get("artifact") if isinstance(match.get("artifact"), dict) else {}

            package_name = str(artifact.get("name") or "").strip()
            if package_name.lower() in {"grype", "syft", "anchore", "bearer", "trivy", "semgrep"}:
                continue

            severity = self._normalize_severity(str(vuln.get("severity") or "")) or "medium"
            cve = str(vuln.get("id") or "").strip() or f"SCA-{idx}"
            dedupe_key = f"{cve}:{package_name}"
            if dedupe_key in seen_keys:
                continue
            seen_keys.add(dedupe_key)

            installed_version = str(artifact.get("version") or "").strip() or None
            fix_versions = vuln.get("fix", {}).get("versions") if isinstance(vuln.get("fix"), dict) else []
            fix_version = str(fix_versions[0]).strip() if isinstance(fix_versions, list) and fix_versions else None

            file_path, line_number = self._fast_manifest_location(project_id, match, package_name)
            if self._is_noise_path(file_path):
                continue

            description = str(vuln.get("description") or f"Dependency vulnerability in {package_name or 'package'}").strip()
            cwe = None
            weaknesses = vuln.get("weaknesses") if isinstance(vuln.get("weaknesses"), list) else []
            if weaknesses and isinstance(weaknesses[0], dict):
                cwe = str(weaknesses[0].get("cwe") or "").strip() or None

            out.append(
                Vulnerability(
                    id=f"sca:{cve}:{package_name or 'package'}:{idx}",
                    file=file_path,
                    line_start=max(1, line_number),
                    line_end=max(1, line_number),
                    rule_id=cve,
                    severity=severity,
                    description=description,
                    cwe=cwe,
                    package_name=package_name or None,
                    installed_version=installed_version,
                    fix_version=fix_version,
                    type="sca",
                )
            )

        return out

    def _fast_manifest_location(self, project_id: str, match: dict[str, Any], package_name: str) -> tuple[str, int]:
        """Resolve manifest path without per-finding Docker reads (ingest must stay fast)."""
        artifact = match.get("artifact") if isinstance(match.get("artifact"), dict) else {}
        locations = artifact.get("locations") if isinstance(artifact.get("locations"), list) else []

        for location in locations:
            if not isinstance(location, dict):
                continue
            path = self._normalize_file_path(str(location.get("path") or ""), project_id)
            if not path or self._is_noise_path(path):
                continue
            basename = path.rsplit("/", 1)[-1]
            if basename in _EDITABLE_MANIFEST_BY_LOCKFILE:
                prefix = path.rsplit("/", 1)[0] if "/" in path else ""
                for candidate_name in _EDITABLE_MANIFEST_BY_LOCKFILE[basename]:
                    candidate = f"{prefix}/{candidate_name}" if prefix else candidate_name
                    return candidate, 1
            if basename in _DIRECTLY_EDITABLE_MANIFESTS or not basename.endswith((".lock", ".sum")):
                line_number = self._safe_int(location.get("lineNumber"), 1)
                return path, max(1, line_number)

        fallback = self._fallback_manifest_for_package(artifact)
        if fallback:
            return fallback, 1
        return "requirements.txt", 1

    @staticmethod
    def _is_noise_path(path: str) -> bool:
        normalized = f"/{str(path or '').replace('\\', '/').lstrip('/')}"
        return any(marker in normalized for marker in _NOISE_PATH_MARKERS)

    def _infer_manifest_location(self, project_id: str, match: dict[str, Any], package_name: str) -> tuple[str, int]:
        artifact = match.get("artifact") if isinstance(match.get("artifact"), dict) else {}
        locations = artifact.get("locations") if isinstance(artifact.get("locations"), list) else []

        candidate_path = ""
        line_number = 1

        for location in locations:
            if not isinstance(location, dict):
                continue
            path = self._normalize_file_path(str(location.get("path") or ""), project_id)
            if not path:
                continue
            if "/node_modules/" in f"/{path}" or "/vendor/" in f"/{path}":
                continue
            candidate_path = path
            line_number = self._safe_int(location.get("lineNumber"), 1)
            if path.endswith(("package.json", "requirements.txt", "go.mod", "pom.xml", "Pipfile", "pyproject.toml")):
                break

        if candidate_path:
            remapped_path, remapped_line = self._remap_lockfile_to_editable_manifest(
                project_id,
                candidate_path,
                package_name,
            )
            if remapped_path:
                return remapped_path, max(1, remapped_line)

        if candidate_path and line_number > 0:
            if line_number == 1 and package_name:
                guessed = self._find_dependency_line(project_id, candidate_path, package_name)
                if guessed > 0:
                    line_number = guessed
            return candidate_path, max(1, line_number)

        fallback = self._fallback_manifest_for_package(artifact)
        if fallback and package_name:
            return fallback, max(1, self._find_dependency_line(project_id, fallback, package_name) or 1)
        return fallback, 1

    def _fallback_manifest_for_package(self, artifact: dict[str, Any]) -> str:
        purl = str(artifact.get("purl") or "").lower()
        kind = str(artifact.get("type") or "").lower()

        if "npm" in purl or kind in {"npm", "node"}:
            return "package.json"
        if "pypi" in purl or kind in {"python", "wheel"}:
            return "requirements.txt"
        if "golang" in purl or kind == "go-module":
            return "go.mod"
        if "maven" in purl or kind in {"java-archive", "java"}:
            return "pom.xml"
        return ""

    def _remap_lockfile_to_editable_manifest(self, project_id: str, rel_path: str, package_name: str) -> tuple[str, int]:
        normalized = str(rel_path or "").strip().replace("\\", "/").lstrip("/")
        basename = normalized.rsplit("/", 1)[-1]
        if basename in _DIRECTLY_EDITABLE_MANIFESTS:
            return normalized, max(1, self._find_dependency_line(project_id, normalized, package_name) or 1)
        candidates = _EDITABLE_MANIFEST_BY_LOCKFILE.get(basename)
        if not candidates:
            return "", 1

        prefix = normalized.rsplit("/", 1)[0] if "/" in normalized else ""
        for candidate_name in candidates:
            candidate = f"{prefix}/{candidate_name}" if prefix else candidate_name
            content = self._read_repo_file(project_id, candidate)
            if not content:
                continue
            line = self._find_dependency_line(project_id, candidate, package_name) if package_name else 1
            if package_name and line <= 1 and package_name.lower() not in content.lower():
                continue
            return candidate, max(1, line or 1)
        return "", 1

    @functools.lru_cache(maxsize=10000)
    def _find_dependency_line(self, project_id: str, rel_path: str, package_name: str) -> int:
        normalized = rel_path.lower()
        if "lock" in normalized or normalized.endswith(".sum"):
            return 1
        text = self._read_repo_file(project_id, rel_path)
        if not text:
            return 1

        pkg = re.escape(package_name)
        patterns = [
            re.compile(rf"^\s*{pkg}\s*(==|~=|>=|<=|>|<)", re.IGNORECASE),
            re.compile(rf'"{pkg}"\s*:', re.IGNORECASE),
            re.compile(rf"\b{pkg}\b", re.IGNORECASE),
        ]

        for idx, line in enumerate(text.splitlines(), start=1):
            for pat in patterns:
                if pat.search(line):
                    return idx
        return 1

    def _read_repo_file(self, project_id: str, rel_path: str) -> str:
        cleaned = rel_path.strip().replace("\\", "/")
        if not cleaned:
            return ""
        cache_key = (project_id, cleaned)
        if cache_key in self._repo_file_cache:
            return self._repo_file_cache[cache_key]
        try:
            output = get_docker_client().containers.run(
                "alpine",
                command=["cat", f"/repo/{project_id}/{cleaned}"],
                volumes={CODEBASE_VOLUME: {"bind": "/repo", "mode": "ro"}},
                remove=True,
            )
            content = decode_output(output)
        except Exception:
            content = ""
        self._repo_file_cache[cache_key] = content
        return content

    @staticmethod
    def _load_json(raw: str) -> Any:
        try:
            return json.loads(raw)
        except Exception:
            return None

    @staticmethod
    def _normalize_severity(value: str) -> str | None:
        normalized = str(value or "").strip().lower()
        return _SEVERITY_MAP.get(normalized)

    @staticmethod
    def _safe_int(value: Any, default: int) -> int:
        try:
            parsed = int(value)
            return parsed if parsed > 0 else default
        except Exception:
            return default

    @staticmethod
    def _normalize_file_path(path: str, project_id: str) -> str:
        value = str(path or "").strip().replace("\\", "/")
        if not value:
            return ""
        for prefix in ("/tmp/scan/", "/repo/"):
            if value.startswith(prefix):
                value = value[len(prefix):]
        while value.startswith("./"):
            value = value[2:]
        if value.startswith(project_id + "/"):
            value = value[len(project_id) + 1 :]
        return value.lstrip("/")
