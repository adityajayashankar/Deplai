import json
import threading

import docker

from utils import SEVERITY_LEVELS, read_volume_file, find_volume_file, get_docker_client

# ── In-memory scan results cache ──
# After the first Docker volume read + parse, cache both the status and full
# results so subsequent calls skip the slow file access entirely.
# Structure: { project_id: { "status": "found"|"not_found", "data": {...} } }
_cache: dict[str, dict] = {}
_cache_lock = threading.Lock()


def _parse_bearer_report(raw: str) -> list[dict]:
    """Parse Bearer JSON into CWE-grouped code security findings."""
    raw = raw.strip()
    if not raw or not raw.startswith("{"):
        return []
    data = json.loads(raw)

    cwe_groups: dict[tuple[str, str], dict] = {}

    for severity in SEVERITY_LEVELS:
        for item in data.get(severity, []):
            cwe_ids = item.get("cwe_ids", [])
            cwe_id = cwe_ids[0] if cwe_ids else "unknown"
            key = (cwe_id, severity)

            if key not in cwe_groups:
                cwe_groups[key] = {
                    "cwe_id": cwe_id,
                    "title": item.get("title", ""),
                    "severity": severity,
                    "occurrences": [],
                }

            filename = item.get("filename", "")
            # Bearer scans the codebase volume mounted at /tmp/scan — strip that prefix
            # so paths are relative to the repo root (e.g. "app/routes.py")
            if filename.startswith("/tmp/scan/"):
                filename = filename[len("/tmp/scan/"):]
            cwe_groups[key]["occurrences"].append({
                "filename": filename,
                "line_number": item.get("line_number", 0),
                "code_extract": item.get("code_extract", ""),
                "documentation_url": item.get("documentation_url", ""),
            })

    severity_order = {s: i for i, s in enumerate(SEVERITY_LEVELS)}
    findings = sorted(
        [{"count": len(g["occurrences"]), **g} for g in cwe_groups.values()],
        key=lambda g: (severity_order.get(g["severity"], 99), -g["count"]),
    )
    return findings


def _parse_grype_report(raw: str) -> list[dict]:
    """Parse Grype JSON into supply chain vulnerability data."""
    data = json.loads(raw)

    # Tool purls that identify Anchore's own scanners.  Grype extracts the
    # SBOM descriptor (Syft version) from the SBOM file and can report CVEs
    # against the tool itself — these are not project vulnerabilities.
    _SCANNER_PURL_PREFIXES = (
        "pkg:golang/github.com/anchore/syft",
        "pkg:golang/github.com/anchore/grype",
    )

    vulnerabilities = []
    for match in data.get("matches", []):
        vuln = match.get("vulnerability", {})
        artifact = match.get("artifact", {})
        purl = artifact.get("purl") or ""

        # Skip SBOM-generator tool artifacts that leaked into the report
        if any(purl.startswith(prefix) for prefix in _SCANNER_PURL_PREFIXES):
            continue

        epss_list = vuln.get("epss", [])
        fix_versions = vuln.get("fix", {}).get("versions", [])

        vulnerabilities.append({
            "name": artifact.get("name", ""),
            "type": artifact.get("type", ""),
            "version": artifact.get("version", ""),
            "purl": purl or None,
            "severity": vuln.get("severity", "Unknown"),
            "epss_score": epss_list[0].get("epss") if epss_list else None,
            "fix_version": fix_versions[0] if fix_versions else None,
            "cve_id": vuln.get("id", ""),
        })

    return vulnerabilities


def _load_and_cache(project_id: str) -> tuple[bool, dict | str]:
    """Read reports from Docker volume, parse, cache, and return."""
    try:
        try:
            get_docker_client().volumes.get("security_reports")
        except docker.errors.NotFound:
            return (False, "No scan reports found. Run a scan first.")

        bearer_file = find_volume_file(project_id, "Bearer.json")
        grype_file = find_volume_file(project_id, "Grype.json")

        bearer_raw = read_volume_file(bearer_file) if bearer_file else None
        grype_raw = read_volume_file(grype_file) if grype_file else None

        if bearer_raw is None and grype_raw is None:
            return (False, "No scan reports found. Run a scan first.")

        if bearer_file and bearer_raw is not None and not bearer_raw.strip():
            return (False, "Bearer report is empty; scan may have failed.")
        if grype_file and grype_raw is not None and not grype_raw.strip():
            return (False, "Grype report is empty; scan may have failed.")

        code_security = []
        if bearer_raw:
            try:
                code_security = _parse_bearer_report(bearer_raw)
            except Exception as e:
                return (False, f"Failed to parse Bearer report: {e}")

        supply_chain = []
        if grype_raw:
            try:
                supply_chain = _parse_grype_report(grype_raw)
            except Exception as e:
                return (False, f"Failed to parse Grype report: {e}")

        data = {"supply_chain": supply_chain, "code_security": code_security}
        has_vulns = len(supply_chain) > 0 or len(code_security) > 0
        status = "found" if has_vulns else "not_found"

        with _cache_lock:
            _cache[project_id] = {"status": status, "data": data}

        return (True, data)
    except Exception as e:
        return (False, f"Error reading scan reports: {e}")


def get_scan_results(project_id: str) -> tuple[bool, dict | str]:
    """Return parsed scan results, serving from cache when available."""
    with _cache_lock:
        cached = _cache.get(project_id)
    if cached:
        return (True, cached["data"])
    return _load_and_cache(project_id)


def get_scan_status(project_id: str) -> str:
    """Return vulnerability status: 'found', 'not_found', or 'not_initiated'.

    Uses the cache if available; otherwise reads and parses (populating cache).
    """
    try:
        with _cache_lock:
            cached = _cache.get(project_id)
        if cached:
            return cached["status"]

        success, data = _load_and_cache(project_id)
        if not success:
            return "not_initiated"

        has_vulns = len(data.get("supply_chain", [])) > 0 or len(data.get("code_security", [])) > 0
        return "found" if has_vulns else "not_found"
    except Exception:
        return "not_initiated"


def invalidate_cache(project_id: str) -> None:
    """Remove cached results for a project so the next call re-reads volumes."""
    with _cache_lock:
        _cache.pop(project_id, None)
