"""SDLC-phased security scan tool mapping and metadata."""

from __future__ import annotations

from dataclasses import dataclass
import json


@dataclass(frozen=True)
class ToolSpec:
    image: str
    report_suffix: str
    dependencies: tuple[str, ...] = ()


TOOLS = {
    "sast": ToolSpec("bearer/bearer:latest-amd64", "Bearer.json"),
    "secrets": ToolSpec("zricethezav/gitleaks:v8.21.2", "Secrets.json"),
    "sbom": ToolSpec("anchore/syft", "sbom.json"),
    "sca": ToolSpec("anchore/grype", "Grype.json", ("sbom",)),
    **{key: ToolSpec("bridgecrew/checkov:3.2.334", suffix) for key, suffix in {
        "iac": "Checkov.json", "containers": "Containers.json",
        "kubernetes": "Kubernetes.json", "cicd": "Cicd.json", "api": "Api.json",
    }.items()},
    "dast": ToolSpec("zaproxy/zap-stable:2.16.1", "Dast.json"),
    "cloud": ToolSpec("prowlercloud/prowler:5.8.0", "Cloud.json"),
}


def validate_report(module: str, raw: str | None) -> dict:
    """Validate structure before a process exit may become scan completion."""
    if module not in TOOLS:
        raise ValueError("Unregistered scanner report")
    if not raw or not raw.strip():
        raise ValueError("Scanner report is missing or empty")
    data = json.loads(raw)
    checked = None
    if module == "sast":
        # Current Bearer emits `{}` for a successful scan with no findings.
        # It is a valid report, unlike a scanner error object.
        if not isinstance(data, dict) or (data and not any(k in data for k in ("critical", "high", "medium", "low"))):
            raise ValueError("Invalid Bearer report")
        if any(not isinstance(data.get(k, []), list) for k in ("critical", "high", "medium", "low")):
            raise ValueError("Invalid Bearer findings")
    elif module in ("sbom", "sca"):
        key = "artifacts" if module == "sbom" else "matches"
        if not isinstance(data, dict) or not isinstance(data.get(key), list):
            raise ValueError(f"Invalid {module} report")
        if module == "sbom":
            checked = len(data[key])
    elif module in ("iac", "containers", "kubernetes", "cicd", "api"):
        reports = data if isinstance(data, list) else [data]
        checked = 0
        for report in reports:
            if not isinstance(report, dict):
                raise ValueError("Invalid Checkov report")
            # Checkov 3.2 emits this compact summary when a framework has no
            # matching files. Treat it as explicit not-applicable coverage.
            if "resource_count" in report and "checkov_version" in report:
                if not isinstance(report.get("resource_count"), int):
                    raise ValueError("Invalid Checkov resource count")
                if report.get("parsing_errors") not in (None, 0, [], {}):
                    raise ValueError("Checkov could not parse all targets")
                checked += report["resource_count"]
                continue
            if not isinstance(report.get("results"), dict):
                raise ValueError("Invalid Checkov report")
            results = report["results"]
            if not any(k in results for k in ("passed_checks", "failed_checks", "skipped_checks")):
                raise ValueError("Checkov report has no check results")
            for key in ("passed_checks", "failed_checks", "skipped_checks"):
                if not isinstance(results.get(key, []), list):
                    raise ValueError("Invalid Checkov check results")
            checked += len(results.get("passed_checks", [])) + len(results.get("failed_checks", []))
            if results.get("parsing_errors") or report.get("parsing_errors"):
                raise ValueError("Checkov could not parse all targets")
    elif module == "secrets":
        if not isinstance(data, list) or any(not isinstance(x, dict) or "RuleID" not in x for x in data):
            raise ValueError("Invalid Gitleaks report")
    elif module == "dast":
        if not isinstance(data, dict) or not isinstance(data.get("site"), list):
            raise ValueError("Invalid ZAP report")
        checked = len(data["site"])
    elif module == "cloud":
        if not isinstance(data, list) or any(not isinstance(x, dict) or not ("status_code" in x or "Status" in x) for x in data):
            raise ValueError("Invalid Prowler report")
        checked = len(data)
    return {"report_validated": True, "checked_target_count": checked,
            "coverage": "not_applicable" if checked == 0 else "evaluated"}

# module_id -> (engine display name, sdlc phase id, phase label)
MODULE_ENGINES: dict[str, tuple[str, str, str]] = {
    "secrets": ("Gitleaks", "commit", "Commit / source"),
    "sast": ("Bearer", "commit", "Commit / source"),
    "sbom": ("Syft", "build", "Build"),
    "sca": ("Grype", "build", "Build"),
    "containers": ("Checkov Containers", "build", "Build"),
    "iac": ("Checkov IaC", "predeploy", "Pre-deploy"),
    "kubernetes": ("Checkov Kubernetes", "predeploy", "Pre-deploy"),
    "cicd": ("Checkov CI/CD", "predeploy", "Pre-deploy"),
    "api": ("Checkov API", "predeploy", "Pre-deploy"),
    "dast": ("OWASP ZAP", "runtime", "Runtime"),
    "cloud": ("Prowler", "ops", "Ops"),
}

# Phases run sequentially; tools inside a phase run in parallel.
SDLC_PHASES: list[tuple[str, str, tuple[str, ...]]] = [
    ("commit", "Commit / source", ("secrets", "sast")),
    ("build", "Build", ("sbom", "sca", "containers")),
    ("predeploy", "Pre-deploy", ("iac", "kubernetes", "cicd", "api")),
    ("runtime", "Runtime", ("dast",)),
    ("ops", "Ops", ("cloud",)),
]

REPO_MODULES = ("sast", "sca", "sbom", "secrets", "iac", "containers", "kubernetes", "cicd", "api")


def engine_for(module: str) -> str:
    meta = MODULE_ENGINES.get(module)
    return meta[0] if meta else module


def phase_for(module: str) -> tuple[str, str]:
    meta = MODULE_ENGINES.get(module)
    if not meta:
        return ("", "")
    return (meta[1], meta[2])
