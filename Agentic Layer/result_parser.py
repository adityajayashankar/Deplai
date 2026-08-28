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

PIPELINE_MODULES = (
    "sast", "sca", "sbom", "secrets", "iac", "containers",
    "kubernetes", "cicd", "api", "dast", "cloud",
)
PHASE1_MODULES = PIPELINE_MODULES
_SCANNER_PURL_PREFIXES = (
    "pkg:golang/github.com/anchore/syft",
    "pkg:golang/github.com/anchore/grype",
)
_CONTAINER_CHECK_TYPES = {"dockerfile", "docker_compose", "dockercompose"}
_KUBERNETES_CHECK_TYPES = {"kubernetes", "helm", "kustomize"}
_CICD_CHECK_TYPES = {
    "github_actions", "gitlab_ci", "bitbucket_pipelines",
    "circleci_pipelines", "azure_pipelines", "github_configuration",
    "gitlab_configuration", "bitbucket_configuration",
}
_API_CHECK_TYPES = {"openapi"}
_POLICY_EVIDENCE = {
    "iac": "Infrastructure as Code",
    "containers": "Container Security",
    "kubernetes": "Kubernetes",
    "cicd": "CI/CD",
    "api": "API Security",
}
_SBOM_COMPONENT_LIMIT = 400


def _loads_json(raw: str | None):
    text = (raw or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        for index, char in enumerate(text):
            if char not in "[{":
                continue
            try:
                return json.loads(text[index:])
            except json.JSONDecodeError:
                continue
        raise


def _normalize_severity(value: str | None) -> str:
    severity = str(value or "medium").strip().lower()
    if severity in ("unknown", "info", "informational", "none", ""):
        return "low"
    if severity in SEVERITY_LEVELS:
        return severity
    return "medium"


def _severity_breakdown(findings: list[dict]) -> dict[str, int]:
    breakdown = {level: 0 for level in SEVERITY_LEVELS}
    for finding in findings:
        severity = _normalize_severity(finding.get("severity"))
        breakdown[severity] = breakdown.get(severity, 0) + 1
    return breakdown


def _strip_repo_prefix(path: str) -> str:
    filename = str(path or "").replace("\\", "/")
    for prefix in ("/tmp/scan/", "/src/"):
        if filename.startswith(prefix):
            filename = filename[len(prefix):]
            if "/" in filename:
                filename = filename.split("/", 1)[1]
            break
    return filename.lstrip("/")


def _parse_bearer_report(raw: str) -> list[dict]:
    """Parse Bearer JSON into CWE-grouped code security findings."""
    data = _loads_json(raw)
    if not isinstance(data, dict):
        return []

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
    data = _loads_json(raw)
    if not isinstance(data, dict):
        return []

    vulnerabilities = []
    for match in data.get("matches", []):
        vuln = match.get("vulnerability", {})
        artifact = match.get("artifact", {})
        purl = artifact.get("purl") or ""

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


def _parse_sbom_summary(raw: str | None) -> dict:
    data = _loads_json(raw) if raw else None
    if not isinstance(data, dict):
        return {"component_count": 0, "components": []}
    artifacts = data.get("artifacts")
    if artifacts is None:
        artifacts = data.get("components") or []
    if not isinstance(artifacts, list):
        artifacts = []
    components = []
    for item in artifacts:
        if not isinstance(item, dict):
            continue
        name = item.get("name") or item.get("id") or ""
        if not name:
            continue
        components.append({
            "name": str(name),
            "version": str(item.get("version") or ""),
            "type": str(item.get("type") or item.get("language") or ""),
            "purl": item.get("purl") or None,
        })
        if len(components) >= _SBOM_COMPONENT_LIMIT:
            break
    return {"component_count": len(artifacts), "components": components}


def _parse_secrets_report(raw: str | None) -> list[dict]:
    """Parse secret-scan JSON. Never includes secret values."""
    data = _loads_json(raw) if raw else []
    if data is None:
        return []
    if isinstance(data, dict):
        items = data.get("leaks") or data.get("findings") or data.get("results") or []
    else:
        items = data
    if not isinstance(items, list):
        return []

    findings = []
    for item in items:
        if not isinstance(item, dict):
            continue
        file_path = _strip_repo_prefix(item.get("File") or item.get("file") or "")
        line_number = item.get("StartLine") or item.get("startLine") or item.get("line") or 0
        rule_id = item.get("RuleID") or item.get("ruleID") or item.get("rule") or "secret"
        title = item.get("Description") or item.get("description") or str(rule_id)
        fingerprint = item.get("Fingerprint") or item.get("fingerprint") or f"{file_path}:{line_number}:{rule_id}"
        findings.append({
            "id": str(fingerprint),
            "rule_id": str(rule_id),
            "title": str(title),
            "severity": "high",
            "file": file_path,
            "line_number": int(line_number or 0),
            "fingerprint": str(fingerprint),
        })
    return findings


def _iter_checkov_reports(data) -> list[dict]:
    reports: list[dict] = []
    if isinstance(data, list):
        reports.extend(item for item in data if isinstance(item, dict))
    elif isinstance(data, dict):
        if "results" in data or "check_type" in data or "failed_checks" in data:
            reports.append(data)
        else:
            for value in data.values():
                if isinstance(value, dict) and ("results" in value or "check_type" in value):
                    reports.append(value)
                elif isinstance(value, list):
                    reports.extend(item for item in value if isinstance(item, dict))
    return reports


def _category_for_check_type(check_type: str) -> str:
    value = str(check_type or "").lower()
    if value in _CONTAINER_CHECK_TYPES:
        return "containers"
    if value in _KUBERNETES_CHECK_TYPES:
        return "kubernetes"
    if value in _CICD_CHECK_TYPES:
        return "cicd"
    if value in _API_CHECK_TYPES:
        return "api"
    return "iac"


def _parse_checkov_report(raw: str | None, category: str | None = None) -> list[dict]:
    data = _loads_json(raw) if raw else None
    if data is None:
        return []

    findings = []
    for report in _iter_checkov_reports(data):
        check_type = str(report.get("check_type") or "").lower()
        classified = _category_for_check_type(check_type)
        if category and classified != category:
            continue

        results = report.get("results") if isinstance(report.get("results"), dict) else report
        failed = []
        if isinstance(results, dict):
            failed = results.get("failed_checks") or results.get("failed") or []
        if not isinstance(failed, list):
            continue

        for item in failed:
            if not isinstance(item, dict):
                continue
            file_path = _strip_repo_prefix(item.get("file_path") or item.get("file") or "")
            line_range = item.get("file_line_range") or [0]
            line_number = line_range[0] if isinstance(line_range, list) and line_range else 0
            check_id = item.get("check_id") or item.get("id") or "check"
            title = item.get("check_name") or item.get("name") or str(check_id)
            resource = item.get("resource") or file_path
            findings.append({
                "id": f"{check_id}:{file_path}:{line_number}:{resource}",
                "check_id": str(check_id),
                "title": str(title),
                "severity": _normalize_severity(item.get("severity")),
                "file": file_path,
                "line_number": int(line_number or 0),
                "resource": str(resource or ""),
                "guideline": item.get("guideline") or "",
                "check_type": check_type,
            })
    return findings


def _parse_dast_report(raw: str | None) -> list[dict]:
    data = _loads_json(raw) if raw else None
    if data is None:
        return []
    sites = data.get("site") if isinstance(data, dict) else None
    if not isinstance(sites, list):
        return []
    findings = []
    for site in sites:
        if not isinstance(site, dict):
            continue
        alerts = site.get("alerts") or []
        if not isinstance(alerts, list):
            continue
        for alert in alerts:
            if not isinstance(alert, dict):
                continue
            risk_text = str(alert.get("riskdesc") or alert.get("risk") or "medium").split(" ", 1)[0]
            instances = alert.get("instances") if isinstance(alert.get("instances"), list) else []
            first = instances[0] if instances and isinstance(instances[0], dict) else {}
            uri = str(first.get("uri") or site.get("@name") or site.get("name") or "")
            plugin_id = str(alert.get("pluginid") or alert.get("pluginId") or "dast")
            evidence = str(first.get("evidence") or "")[:120]
            findings.append({
                "id": f"{plugin_id}:{uri}",
                "title": str(alert.get("alert") or alert.get("name") or "Dynamic finding"),
                "severity": _normalize_severity(risk_text),
                "uri": uri,
                "method": str(first.get("method") or ""),
                "cwe_id": str(alert.get("cweid") or alert.get("cweId") or ""),
                "count": int(str(alert.get("count") or len(instances) or 1) or 1),
                "evidence": evidence,
            })
    return findings


def _cloud_finding_from_row(item: dict) -> dict | None:
    if item.get("finding_info") or item.get("status_code"):
        status = str(item.get("status_code") or "").upper()
        if status not in {"FAIL", "FAILED"}:
            return None
        info = item.get("finding_info") if isinstance(item.get("finding_info"), dict) else {}
        resources = item.get("resources") if isinstance(item.get("resources"), list) else []
        first = resources[0] if resources and isinstance(resources[0], dict) else {}
        metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
        cloud = item.get("cloud") if isinstance(item.get("cloud"), dict) else {}
        group = first.get("group") if isinstance(first.get("group"), dict) else {}
        check_id = str(metadata.get("event_code") or info.get("uid") or "cloud")
        resource = str(first.get("uid") or first.get("name") or "aws")
        region = str(first.get("region") or cloud.get("region") or "")
        return {
            "id": f"{check_id}:{resource}:{region}",
            "title": str(info.get("title") or item.get("message") or "Cloud finding"),
            "severity": _normalize_severity(str(item.get("severity") or "medium")),
            "resource": resource,
            "region": region,
            "service": str(group.get("name") or ""),
            "check_id": check_id,
            "status_extended": str(item.get("status_detail") or item.get("message") or "")[:280],
        }

    status = str(item.get("Status") or item.get("status") or "").upper()
    if status and status not in {"FAIL", "FAILED"}:
        return None
    resource = str(
        item.get("ResourceId")
        or item.get("resource_id")
        or item.get("ResourceArn")
        or item.get("resource_arn")
        or item.get("region")
        or "aws"
    )
    check_id = str(item.get("CheckID") or item.get("check_id") or item.get("CheckId") or "cloud")
    region = str(item.get("Region") or item.get("region") or "")
    return {
        "id": f"{check_id}:{resource}:{region}",
        "title": str(item.get("CheckTitle") or item.get("check_title") or item.get("StatusExtended") or "Cloud finding"),
        "severity": _normalize_severity(str(item.get("Severity") or item.get("severity") or "medium")),
        "resource": resource,
        "region": region,
        "service": str(item.get("ServiceName") or item.get("service_name") or item.get("service") or ""),
        "check_id": check_id,
        "status_extended": str(item.get("StatusExtended") or item.get("status_extended") or "")[:280],
    }


def _parse_cloud_report(raw: str | None) -> list[dict]:
    data = _loads_json(raw) if raw else None
    if data is None:
        return []
    rows = data
    if isinstance(data, dict):
        rows = data.get("findings") or data.get("Checks") or data.get("failed") or []
    if not isinstance(rows, list):
        return []
    findings = []
    for item in rows:
        if not isinstance(item, dict):
            continue
        parsed = _cloud_finding_from_row(item)
        if not parsed:
            continue
        findings.append(parsed)
        if len(findings) >= 400:
            break
    return findings


def _finding(
    *,
    finding_id: str,
    category: str,
    severity: str,
    title: str,
    asset: str,
    location: str,
    scanner: str,
    evidence_source: str,
    metadata: dict | None = None,
) -> dict:
    return {
        "id": finding_id,
        "category": category,
        "severity": _normalize_severity(severity),
        "title": title,
        "asset": asset,
        "location": location,
        "status": "open",
        "scanner": scanner,
        "evidence_source": evidence_source,
        "metadata": metadata or {},
    }


def _unified_from_code_security(groups: list[dict]) -> list[dict]:
    findings = []
    for group in groups:
        occurrences = group.get("occurrences") or []
        cwe_id = group.get("cwe_id") or "unknown"
        title = group.get("title") or f"CWE-{cwe_id}"
        severity = group.get("severity") or "medium"
        if occurrences:
            for index, occ in enumerate(occurrences):
                filename = occ.get("filename") or "unknown"
                line_number = occ.get("line_number") or 0
                location = f"{filename}:{line_number}"
                findings.append(_finding(
                    finding_id=f"sast:{cwe_id}:{location}:{index}",
                    category="sast",
                    severity=severity,
                    title=title,
                    asset=filename,
                    location=location,
                    scanner="Bearer",
                    evidence_source="Static Analysis",
                    metadata={
                        "cwe_id": cwe_id,
                        "code_extract": occ.get("code_extract") or "",
                        "documentation_url": occ.get("documentation_url") or "",
                    },
                ))
        else:
            findings.append(_finding(
                finding_id=f"sast:{cwe_id}:group",
                category="sast",
                severity=severity,
                title=title,
                asset="multiple locations",
                location="multiple locations",
                scanner="Bearer",
                evidence_source="Static Analysis",
                metadata={"cwe_id": cwe_id, "count": group.get("count") or 0},
            ))
    return findings


def _unified_from_supply_chain(items: list[dict]) -> list[dict]:
    findings = []
    for index, item in enumerate(items):
        cve_id = item.get("cve_id") or "unknown"
        name = item.get("name") or "dependency"
        version = item.get("version") or ""
        findings.append(_finding(
            finding_id=f"sca:{cve_id}:{name}:{version}:{index}",
            category="sca",
            severity=item.get("severity") or "medium",
            title=f"{cve_id} in {name}",
            asset=name,
            location=f"{name}@{version}" if version else name,
            scanner="Grype",
            evidence_source="Software Composition Analysis",
            metadata={
                "cve_id": cve_id,
                "version": version,
                "fix_version": item.get("fix_version"),
                "purl": item.get("purl"),
                "epss_score": item.get("epss_score"),
                "type": item.get("type"),
            },
        ))
    return findings


def _unified_from_secrets(items: list[dict]) -> list[dict]:
    findings = []
    for item in items:
        file_path = item.get("file") or "unknown"
        line_number = item.get("line_number") or 0
        title = item.get("title") or "Secret detected"
        findings.append(_finding(
            finding_id=f"secrets:{item.get('id')}",
            category="secrets",
            severity=item.get("severity") or "high",
            title=title,
            asset=file_path,
            location=f"{file_path}:{line_number}",
            scanner="Gitleaks",
            evidence_source="Secret Scanning",
            metadata={
                "rule_id": item.get("rule_id"),
                "fingerprint": item.get("fingerprint"),
            },
        ))
    return findings


def _unified_from_policy(items: list[dict], category: str, evidence_source: str) -> list[dict]:
    findings = []
    for item in items:
        file_path = item.get("file") or "unknown"
        line_number = item.get("line_number") or 0
        title = item.get("title") or item.get("check_id") or "Policy finding"
        findings.append(_finding(
            finding_id=f"{category}:{item.get('id')}",
            category=category,
            severity=item.get("severity") or "medium",
            title=title,
            asset=item.get("resource") or file_path,
            location=f"{file_path}:{line_number}",
            scanner="Checkov",
            evidence_source=evidence_source,
            metadata={
                "check_id": item.get("check_id"),
                "guideline": item.get("guideline"),
                "resource": item.get("resource"),
                "check_type": item.get("check_type"),
            },
        ))
    return findings


def _unified_from_dast(items: list[dict]) -> list[dict]:
    findings = []
    for item in items:
        uri = item.get("uri") or "unknown"
        findings.append(_finding(
            finding_id=f"dast:{item.get('id')}",
            category="dast",
            severity=item.get("severity") or "medium",
            title=item.get("title") or "Dynamic finding",
            asset=uri,
            location=uri,
            scanner="Dynamic Testing",
            evidence_source="Dynamic Application Security Testing",
            metadata={
                "cwe_id": item.get("cwe_id"),
                "method": item.get("method"),
                "count": item.get("count"),
                "evidence": item.get("evidence"),
            },
        ))
    return findings


def _unified_from_cloud(items: list[dict]) -> list[dict]:
    findings = []
    for item in items:
        resource = item.get("resource") or "aws"
        region = item.get("region") or ""
        findings.append(_finding(
            finding_id=f"cloud:{item.get('id')}",
            category="cloud",
            severity=item.get("severity") or "medium",
            title=item.get("title") or "Cloud finding",
            asset=resource,
            location=region or resource,
            scanner="Cloud Security",
            evidence_source="Live AWS account scan",
            metadata={
                "check_id": item.get("check_id"),
                "service": item.get("service"),
                "status_extended": item.get("status_extended"),
                "region": region,
            },
        ))
    return findings


def _finding_risk(finding: dict) -> int:
    severity = _normalize_severity(finding.get("severity"))
    score = {"critical": 88, "high": 72, "medium": 48, "low": 22}.get(severity, 40)
    meta = finding.get("metadata") or {}
    try:
        if meta.get("epss_score") is not None and float(meta.get("epss_score")) >= 0.5:
            score += 8
    except (TypeError, ValueError):
        pass
    text = f"{finding.get('title', '')} {finding.get('asset', '')}".lower()
    if any(token in text for token in ("public", "0.0.0.0/0", "internet", "unauthenticated")):
        score += 8
    if finding.get("category") in ("secrets", "dast"):
        score += 6
    return min(99, score)


def _annotate_risk(findings: list[dict]) -> list[dict]:
    for finding in findings:
        finding["risk"] = _finding_risk(finding)
    return findings


def _ensure_unique_finding_ids(findings: list[dict]) -> list[dict]:
    """Keep list rows distinct so React keys and row expansion stay stable.

    Grype often emits the same CVE for the same package version more than
    once (nested trees, related advisories). Other scanners can collide too.
    """
    seen: dict[str, int] = {}
    for finding in findings:
        base = str(finding.get("id") or "finding").strip() or "finding"
        count = seen.get(base, 0)
        seen[base] = count + 1
        if count:
            finding["id"] = f"{base}#{count}"
    return findings


def _compute_risk(findings: list[dict]) -> dict:
    if not findings:
        return {
            "score": 12,
            "level": "low",
            "reasons": ["No current findings from this pipeline run."],
        }
    posture = _severity_breakdown(findings)
    score = 18 + min(50, posture["critical"] * 12 + posture["high"] * 6 + posture["medium"] * 2)
    reasons: list[str] = []
    blob = " ".join(f"{item.get('title', '')} {item.get('asset', '')}" for item in findings).lower()
    if any(item.get("category") == "secrets" for item in findings):
        reasons.append("Active secrets detected")
        score += 8
    if any(token in blob for token in ("public", "0.0.0.0/0", "internet-facing", "internet facing")):
        reasons.append("Internet-exposed assets")
        score += 10
    high_epss = False
    for item in findings:
        try:
            if float((item.get("metadata") or {}).get("epss_score") or 0) >= 0.5:
                high_epss = True
                break
        except (TypeError, ValueError):
            continue
    if high_epss:
        reasons.append("Known exploited or high-EPSS vulnerabilities")
        score += 8
    if posture["critical"]:
        reasons.append("Critical vulnerabilities")
    if any(item.get("category") == "dast" for item in findings):
        reasons.append("Dynamically confirmed findings")
        score += 6
    if not reasons:
        reasons.append("Open findings from the latest pipeline run")
    score = min(99, score)
    if score >= 80:
        level = "critical"
    elif score >= 60:
        level = "high"
    elif score >= 40:
        level = "medium"
    else:
        level = "low"
    return {"score": score, "level": level, "reasons": reasons}


def _derive_attack_paths(findings: list[dict]) -> list[dict]:
    """Build paths only from findings that already describe exposure. Never invent edges."""
    paths = []
    for finding in findings:
        text = f"{finding.get('title', '')} {finding.get('asset', '')}".lower()
        exposed = finding.get("category") in ("iac", "kubernetes", "api", "dast", "cloud") and any(
            token in text for token in ("public", "0.0.0.0/0", "internet", "unauthenticated", "exposed")
        )
        if not exposed:
            continue
        paths.append({
            "id": f"path:{finding.get('id')}",
            "risk": finding.get("risk") or 0,
            "title": finding.get("title"),
            "hops": [
                {"id": "internet", "label": "Internet", "kind": "exposure"},
                {
                    "id": finding.get("id"),
                    "label": finding.get("asset") or finding.get("title"),
                    "kind": finding.get("category"),
                    "finding_id": finding.get("id"),
                },
            ],
            "finding_ids": [finding.get("id")],
        })
        if len(paths) >= 12:
            break
    return paths


def _correlate_findings(findings: list[dict]) -> list[dict]:
    buckets: dict[str, list[str]] = {}
    by_id = {item["id"]: item for item in findings if item.get("id")}
    for finding in findings:
        meta = finding.get("metadata") or {}
        keys = []
        asset = str(finding.get("asset") or "").strip().lower()
        if asset:
            keys.append(f"asset:{asset}")
        cwe = str(meta.get("cwe_id") or "").strip()
        if cwe and cwe.lower() != "unknown":
            keys.append(f"cwe:{cwe}")
        for key in keys:
            buckets.setdefault(key, []).append(finding["id"])
    groups = []
    seen: set[tuple[str, ...]] = set()
    for key, ids in buckets.items():
        unique = tuple(sorted(set(ids)))
        if len(unique) < 2 or unique in seen:
            continue
        categories = {by_id[item_id]["category"] for item_id in unique if item_id in by_id}
        if len(categories) < 2:
            continue
        seen.add(unique)
        groups.append({
            "key": key,
            "finding_ids": list(unique),
            "categories": sorted(categories),
        })
    return groups


def _merge_policy(*groups: list[dict]) -> list[dict]:
    merged = []
    seen: set[str] = set()
    for group in groups:
        for item in group:
            key = str(item.get("id") or "")
            if key and key in seen:
                continue
            if key:
                seen.add(key)
            merged.append(item)
    return merged


_SKIP_REASONS = {
    "iac": "No supported infrastructure files detected.",
    "containers": "No container definition files detected.",
    "kubernetes": "No Kubernetes manifests detected.",
    "cicd": "No CI/CD workflow files detected.",
    "api": "No API specification files detected.",
    "dast": "Configure an authorized target URL to enable dynamic testing.",
    "cloud": "Run Cloud after this project is deployed. Open the Cloud tab.",
    "secrets": "Secret scanning was not part of this run.",
    "sast": "Static analysis was not part of this run.",
    "sca": "Dependency scanning was not part of this run.",
    "sbom": "SBOM generation was not part of this run.",
}


def _module_record(
    module_id: str,
    status: str,
    findings: list[dict] | None = None,
    *,
    component_count: int | None = None,
    reason: str | None = None,
    error: str | None = None,
) -> dict:
    record = {
        "id": module_id,
        "status": status,
        "finding_count": len(findings or []),
        "severity_breakdown": _severity_breakdown(findings or []),
    }
    if component_count is not None:
        record["component_count"] = component_count
    if reason:
        record["reason"] = reason
    if error:
        record["error"] = error
    return record


def _status_from_pipeline(pipeline: dict | None, module_id: str) -> dict:
    if not isinstance(pipeline, dict):
        return {}
    modules = pipeline.get("modules") or []
    if not isinstance(modules, list):
        return {}
    for item in modules:
        if isinstance(item, dict) and (item.get("id") == module_id or item.get("module") == module_id):
            return item
    return {}


def build_scan_payload(
    *,
    bearer_raw: str | None = None,
    grype_raw: str | None = None,
    syft_raw: str | None = None,
    secrets_raw: str | None = None,
    checkov_raw: str | None = None,
    containers_raw: str | None = None,
    kubernetes_raw: str | None = None,
    cicd_raw: str | None = None,
    api_raw: str | None = None,
    dast_raw: str | None = None,
    cloud_raw: str | None = None,
    pipeline_raw: str | None = None,
) -> dict:
    """Normalize scanner reports into the unified Security Pipeline payload."""
    pipeline = _loads_json(pipeline_raw) if pipeline_raw else None
    if not isinstance(pipeline, dict):
        pipeline = {}

    def _try_parse(fn, raw, fallback):
        try:
            return fn(raw)
        except Exception:
            return fallback

    code_security = _try_parse(_parse_bearer_report, bearer_raw, []) if bearer_raw else []
    supply_chain = _try_parse(_parse_grype_report, grype_raw, []) if grype_raw else []
    secrets = _try_parse(_parse_secrets_report, secrets_raw, [])
    sbom = _try_parse(_parse_sbom_summary, syft_raw, {"component_count": 0, "components": []})
    dast = _try_parse(_parse_dast_report, dast_raw, [])
    cloud = _try_parse(_parse_cloud_report, cloud_raw, [])

    iac = _merge_policy(_try_parse(lambda raw: _parse_checkov_report(raw, "iac"), checkov_raw, []))
    containers = _merge_policy(
        _try_parse(lambda raw: _parse_checkov_report(raw, "containers"), containers_raw, []),
        _try_parse(lambda raw: _parse_checkov_report(raw, "containers"), checkov_raw, []),
    )
    kubernetes = _merge_policy(
        _try_parse(lambda raw: _parse_checkov_report(raw, "kubernetes"), kubernetes_raw, []),
        _try_parse(lambda raw: _parse_checkov_report(raw, "kubernetes"), checkov_raw, []),
    )
    cicd = _merge_policy(
        _try_parse(lambda raw: _parse_checkov_report(raw, "cicd"), cicd_raw, []),
        _try_parse(lambda raw: _parse_checkov_report(raw, "cicd"), checkov_raw, []),
    )
    api = _merge_policy(
        _try_parse(lambda raw: _parse_checkov_report(raw, "api"), api_raw, []),
        _try_parse(lambda raw: _parse_checkov_report(raw, "api"), checkov_raw, []),
    )

    findings = _ensure_unique_finding_ids(_annotate_risk(
        _unified_from_code_security(code_security)
        + _unified_from_supply_chain(supply_chain)
        + _unified_from_secrets(secrets)
        + _unified_from_policy(iac, "iac", _POLICY_EVIDENCE["iac"])
        + _unified_from_policy(containers, "containers", _POLICY_EVIDENCE["containers"])
        + _unified_from_policy(kubernetes, "kubernetes", _POLICY_EVIDENCE["kubernetes"])
        + _unified_from_policy(cicd, "cicd", _POLICY_EVIDENCE["cicd"])
        + _unified_from_policy(api, "api", _POLICY_EVIDENCE["api"])
        + _unified_from_dast(dast)
        + _unified_from_cloud(cloud)
    ))

    findings_by_category = {
        module_id: [item for item in findings if item["category"] == module_id]
        for module_id in PIPELINE_MODULES
        if module_id != "sbom"
    }

    present = {
        "sast": bearer_raw is not None,
        "sca": grype_raw is not None,
        "sbom": syft_raw is not None,
        "secrets": secrets_raw is not None,
        "iac": checkov_raw is not None or bool(iac),
        "containers": containers_raw is not None or bool(containers),
        "kubernetes": kubernetes_raw is not None or bool(kubernetes),
        "cicd": cicd_raw is not None or bool(cicd),
        "api": api_raw is not None or bool(api),
        "dast": dast_raw is not None or bool(dast),
        "cloud": cloud_raw is not None or bool(cloud),
    }

    modules = []
    for module_id in PIPELINE_MODULES:
        pipeline_item = _status_from_pipeline(pipeline, module_id)
        status = str(pipeline_item.get("status") or "").upper()
        reason = pipeline_item.get("reason")
        error = pipeline_item.get("error")
        if not status:
            status = "COMPLETED" if present.get(module_id) else "SKIPPED"
        elif status == "SKIPPED" and present.get(module_id):
            # A later DAST-only run writes a partial pipeline file. Keep prior
            # module results when their reports are still on disk.
            status = "COMPLETED"
            reason = None
        if status == "SKIPPED" and not reason:
            reason = _SKIP_REASONS.get(module_id)
        if module_id == "sbom":
            modules.append(_module_record(
                module_id,
                status,
                [],
                component_count=sbom.get("component_count", 0) if status == "COMPLETED" else 0,
                reason=reason,
                error=error,
            ))
        else:
            modules.append(_module_record(
                module_id,
                status,
                findings_by_category.get(module_id, []),
                reason=reason,
                error=error,
            ))

    posture = _severity_breakdown(findings)
    return {
        "supply_chain": supply_chain,
        "code_security": code_security,
        "secrets": secrets,
        "iac": iac,
        "containers": containers,
        "kubernetes": kubernetes,
        "cicd": cicd,
        "api": api,
        "dast": dast,
        "cloud": cloud,
        "sbom": sbom,
        "findings": findings,
        "modules": modules,
        "posture": {
            "critical": posture["critical"],
            "high": posture["high"],
            "medium": posture["medium"],
            "low": posture["low"],
            "total": len(findings),
        },
        "risk": _compute_risk(findings),
        "attack_paths": _derive_attack_paths(findings),
        "correlations": _correlate_findings(findings),
        "completed_at": pipeline.get("completed_at"),
    }


def _has_findings(data: dict) -> bool:
    if data.get("findings"):
        return True
    if data.get("supply_chain") or data.get("code_security"):
        return True
    for key in ("secrets", "iac", "containers", "kubernetes", "cicd", "api", "dast", "cloud"):
        if data.get(key):
            return True
    return False


def _load_and_cache(project_id: str) -> tuple[bool, dict | str]:
    """Read reports from Docker volume, parse, cache, and return."""
    try:
        try:
            get_docker_client().volumes.get("security_reports")
        except docker.errors.NotFound:
            return (False, "No scan reports found. Run a scan first.")

        files = {
            "bearer": find_volume_file(project_id, "Bearer.json"),
            "grype": find_volume_file(project_id, "Grype.json"),
            "syft": find_volume_file(project_id, "sbom.json"),
            "secrets": find_volume_file(project_id, "Secrets.json"),
            "checkov": find_volume_file(project_id, "Checkov.json"),
            "containers": find_volume_file(project_id, "Containers.json"),
            "kubernetes": find_volume_file(project_id, "Kubernetes.json"),
            "cicd": find_volume_file(project_id, "Cicd.json"),
            "api": find_volume_file(project_id, "Api.json"),
            "dast": find_volume_file(project_id, "Dast.json"),
            "cloud": find_volume_file(project_id, "Cloud.json"),
            "pipeline": find_volume_file(project_id, "Pipeline.json"),
        }
        raw = {key: (read_volume_file(path) if path else None) for key, path in files.items()}

        if all(value is None for value in raw.values()):
            return (False, "No scan reports found. Run a scan first.")

        if files["bearer"] and raw["bearer"] is not None and not raw["bearer"].strip():
            return (False, "Bearer report is empty; scan may have failed.")
        if files["grype"] and raw["grype"] is not None and not raw["grype"].strip():
            return (False, "Grype report is empty; scan may have failed.")

        try:
            data = build_scan_payload(
                bearer_raw=raw["bearer"],
                grype_raw=raw["grype"],
                syft_raw=raw["syft"],
                secrets_raw=raw["secrets"],
                checkov_raw=raw["checkov"],
                containers_raw=raw["containers"],
                kubernetes_raw=raw["kubernetes"],
                cicd_raw=raw["cicd"],
                api_raw=raw["api"],
                dast_raw=raw["dast"],
                cloud_raw=raw["cloud"],
                pipeline_raw=raw["pipeline"],
            )
        except Exception as exc:
            return (False, f"Failed to parse scan reports: {exc}")

        status = "found" if _has_findings(data) else "not_found"
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
    """Return vulnerability status: found, not_found, or not_initiated."""
    try:
        with _cache_lock:
            cached = _cache.get(project_id)
        if cached:
            return cached["status"]

        success, data = _load_and_cache(project_id)
        if not success:
            return "not_initiated"

        return "found" if _has_findings(data) else "not_found"
    except Exception:
        return "not_initiated"


def invalidate_cache(project_id: str) -> None:
    """Remove cached results for a project so the next call re-reads volumes."""
    with _cache_lock:
        _cache.pop(project_id, None)
