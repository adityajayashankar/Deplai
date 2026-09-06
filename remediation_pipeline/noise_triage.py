from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Callable, Literal

from remediation_pipeline.models import Vulnerability

TriageAction = Literal["remediate", "ignore"]

_NOISE_PATH_SEGMENTS = re.compile(
    r"(^|/)(node_modules|vendor|dist|build|coverage|\.next|\.git|__pycache__|"
    r"\.venv|venv|target/|\.gradle|\.idea|\.vscode|third_party|external)(/|$)",
    re.IGNORECASE,
)
_TEST_FILE_PATTERN = re.compile(
    r"(^|/)(tests?|__tests__|__mocks__|fixtures?|mocks?|stubs?|e2e|spec)(/|$)|"
    r"(\.test\.|\.spec\.|_test\.|_spec\.)",
    re.IGNORECASE,
)
_DOC_OR_CONFIG_PATTERN = re.compile(
    r"\.(md|markdown|txt|rst|adoc|json|ya?ml|toml|ini|cfg|lock|sum)$",
    re.IGNORECASE,
)
_SCANNER_SELF_PACKAGES = {
    "grype",
    "syft",
    "anchore",
    "bearer",
    "trivy",
    "semgrep",
}
_LOW_VALUE_SAST_RULES = {
    "missing-content-security-policy",
    "missing-x-frame-options",
    "missing-x-content-type-options",
    "missing-strict-transport-security",
    "missing-permissions-policy",
    "insecure-cookie",
    "cookie-without-secure",
    "cookie-without-httponly",
    "weak-tls-version",
    "ssl-verification-disabled",
    # Bearer JS rules that overwhelmingly produce false positives in real codebases.
    "javascript-lang-logger-leak",
    "javascript_lang_logger_leak",
    "javascript-lang-logger",
    "javascript_lang_logger",
    "javascript-lang-observable-timing",
    "javascript_lang_observable_timing",
    "javascript-lang-insufficiently-random-values",
    "javascript_lang_insufficiently_random_values",
}
_NOISE_RULE_PREFIXES = (
    "javascript_lang_logger",
    "javascript_lang_format_string",
)


def _rule_matches_prefixes(rule_id: str) -> bool:
    lowered = str(rule_id or "").strip().lower()
    normalized = _normalize_rule_id(rule_id)
    return any(
        lowered.startswith(prefix) or normalized.startswith(prefix.replace("_", "-"))
        for prefix in _NOISE_RULE_PREFIXES
    )
_HIGH_SIGNAL_RULE_HINTS = (
    "hardcoded_secret",
    "nosql_injection",
    "sql_injection",
    "command_injection",
    "path_traversal",
    "ssrf",
    "xss",
    "dangerously_set_inner_html",
    "dangerous_insert_html",
    "insecure_deserialization",
    "weak_password",
    "jwt",
    "auth_bypass",
)
_LOW_VALUE_DESCRIPTION_HINTS = (
    "missing security header",
    "content security policy",
    "x-frame-options",
    "permissions-policy",
    "strict-transport-security",
    "information disclosure",
    "log injection",
    "debug statement",
    "todo comment",
)


@dataclass
class TriageDecision:
    action: TriageAction
    reason: str
    confidence: float = 1.0
    source: Literal["heuristic", "llm"] = "heuristic"


@dataclass
class TriageResult:
    keep: list[Vulnerability] = field(default_factory=list)
    ignored: list[tuple[Vulnerability, str]] = field(default_factory=list)
    heuristic_ignored: int = 0
    llm_ignored: int = 0
    llm_reviewed: int = 0


def _normalize_rule_id(rule_id: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(rule_id or "").strip().lower()).strip("-")


def _basename(path: str) -> str:
    return str(path or "").replace("\\", "/").rsplit("/", 1)[-1].lower()


def _is_high_signal_rule(rule_id: str) -> bool:
    normalized = _normalize_rule_id(rule_id)
    return any(hint in normalized for hint in _HIGH_SIGNAL_RULE_HINTS)


def _heuristic_decision(vuln: Vulnerability) -> TriageDecision | None:
    path = str(vuln.file or "").replace("\\", "/").lower()
    basename = _basename(path)
    rule = _normalize_rule_id(vuln.rule_id)
    description = str(vuln.description or "").lower()

    if _NOISE_PATH_SEGMENTS.search(path):
        return TriageDecision("ignore", "dependency or generated path", 0.98)

    if _TEST_FILE_PATTERN.search(path):
        return TriageDecision("ignore", "test or fixture path", 0.95)

    if vuln.type == "sca":
        package = str(vuln.package_name or "").strip().lower()
        if package in _SCANNER_SELF_PACKAGES:
            return TriageDecision("ignore", "scanner tooling package", 0.99)
        if basename.endswith(".lock") or basename.endswith(".sum"):
            return TriageDecision("ignore", "lockfile finding without direct manifest edit", 0.9)
        if vuln.severity in {"low", "medium"} and not str(vuln.fix_version or "").strip():
            return TriageDecision("ignore", "no upstream fix version available", 0.85)
        if vuln.severity == "low":
            return TriageDecision("ignore", "low-severity dependency advisory", 0.8)

    if vuln.type == "sast":
        if _is_high_signal_rule(vuln.rule_id) and vuln.severity in {"critical", "high"}:
            return None

        if rule in _LOW_VALUE_SAST_RULES:
            return TriageDecision("ignore", "known low-signal scanner rule", 0.94)

        if _rule_matches_prefixes(vuln.rule_id):
            return TriageDecision("ignore", "logger/format-string hygiene rule", 0.93)

        if basename in {"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "go.sum", "poetry.lock"}:
            return TriageDecision("ignore", "lockfile SAST finding", 0.92)

        if _DOC_OR_CONFIG_PATTERN.search(basename) and vuln.severity in {"low", "medium"}:
            return TriageDecision("ignore", "documentation or config-only finding", 0.88)

        if rule in _LOW_VALUE_SAST_RULES and vuln.severity in {"low", "medium"}:
            return TriageDecision("ignore", "common header or cookie hygiene rule", 0.9)

        if vuln.severity == "low" and any(hint in description for hint in _LOW_VALUE_DESCRIPTION_HINTS):
            return TriageDecision("ignore", "low-severity hygiene finding", 0.86)

    return None


def _apply_decision(
    vuln: Vulnerability,
    decision: TriageDecision,
    *,
    result: TriageResult,
) -> None:
    tagged = vuln.model_copy(
        update={
            "triage_action": decision.action,
            "triage_reason": decision.reason,
            "triage_confidence": decision.confidence,
            "triage_source": decision.source,
        }
    )
    if decision.action == "ignore":
        result.ignored.append((tagged, decision.reason))
        if decision.source == "llm":
            result.llm_ignored += 1
        else:
            result.heuristic_ignored += 1
    else:
        result.keep.append(tagged)


def _llm_triage_enabled() -> bool:
    return os.getenv("REMEDIATION_LLM_NOISE_TRIAGE", "false").strip().lower() in {"1", "true", "yes", "on"}


def _llm_triage_batch(
    candidates: list[Vulnerability],
    *,
    user_id: str | None,
    organization_id: str | None,
    access_mode: str | None,
    llm_model: str | None,
    llm_credential_id: str | None,
) -> dict[str, TriageDecision]:
    if not candidates or not user_id:
        return {}

    try:
        from ai_gateway import bound_organization, remediate_text
    except ImportError:
        return {}

    lines = []
    for vuln in candidates:
        lines.append(
            json.dumps(
                {
                    "id": vuln.id,
                    "type": vuln.type,
                    "severity": vuln.severity,
                    "rule_id": vuln.rule_id,
                    "file": vuln.file,
                    "line": vuln.line_start,
                    "description": vuln.description[:240],
                    "package": vuln.package_name,
                    "fix_version": vuln.fix_version,
                },
                ensure_ascii=True,
            )
        )

    prompt = (
        "You are a security triage agent. Classify each finding as actionable vulnerability "
        "or ignorable noise before an expensive remediation run.\n"
        "Return ONLY JSON: {\"decisions\":[{\"id\":\"...\",\"action\":\"remediate|ignore\","
        "\"reason\":\"...\",\"confidence\":0.0-1.0}]}\n"
        "Ignore: test/fixture noise, scanner self-deps, missing-header hygiene in dev files, "
        "unfixable low EPSS SCA, duplicate informational rules.\n"
        "Remediate: exploitable code flaws, secrets, injection, authz bugs, critical/high SCA with fixes.\n\n"
        "Findings:\n" + "\n".join(lines)
    )

    ok, response = remediate_text(
        user_id=user_id,
        organization_id=str(organization_id or bound_organization() or "").strip() or None,
        prompt=prompt,
        model=llm_model or os.getenv("REMEDIATION_NOISE_TRIAGE_MODEL", "claude-haiku-4-5"),
        access_mode=access_mode or "platform",
        credential_id=llm_credential_id,
        max_tokens=1200,
        timeout_seconds=60,
    )
    if not ok:
        return {}

    raw = str(response or "").strip()
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end <= start:
        return {}
    try:
        payload = json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return {}

    decisions: dict[str, TriageDecision] = {}
    rows = payload.get("decisions") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        return {}

    for row in rows:
        if not isinstance(row, dict):
            continue
        finding_id = str(row.get("id") or "").strip()
        action = str(row.get("action") or "").strip().lower()
        if not finding_id or action not in {"remediate", "ignore"}:
            continue
        reason = str(row.get("reason") or "llm triage").strip()[:240]
        try:
            confidence = float(row.get("confidence", 0.7))
        except (TypeError, ValueError):
            confidence = 0.7
        decisions[finding_id] = TriageDecision(
            action=action,  # type: ignore[arg-type]
            reason=reason,
            confidence=max(0.0, min(1.0, confidence)),
            source="llm",
        )
    return decisions


def apply_heuristic_noise_triage(vulnerabilities: list[Vulnerability]) -> TriageResult:
    """Fast, zero-cost noise filter used for planning and refresh snapshots."""
    result = TriageResult()
    for vuln in vulnerabilities:
        decision = _heuristic_decision(vuln)
        if decision is None:
            _apply_decision(
                vuln,
                TriageDecision("remediate", "pending remediation review", 0.5),
                result=result,
            )
            continue
        _apply_decision(vuln, decision, result=result)
    return result


def filter_by_remediation_scope(
    vulnerabilities: list[Vulnerability],
    remediation_scope: str,
) -> tuple[list[Vulnerability], int]:
    """Keep only critical/high findings; lower severities are never remediated."""
    # The argument is retained for request compatibility and intentionally has
    # no effect on the critical/high-only product policy.
    _ = remediation_scope
    kept = [v for v in vulnerabilities if v.severity in {"critical", "high"}]
    return kept, len(vulnerabilities) - len(kept)


async def triage_vulnerabilities(
    vulnerabilities: list[Vulnerability],
    *,
    user_id: str | None = None,
    organization_id: str | None = None,
    access_mode: str | None = None,
    llm_model: str | None = None,
    llm_credential_id: str | None = None,
    remediation_scope: str = "major",
    on_progress: Callable[[str, str], object] | None = None,
) -> TriageResult:
    """Drop scanner noise before fix generation to conserve remediation credits."""
    from inspect import isawaitable

    result = TriageResult()
    if not vulnerabilities:
        return result

    async def emit(msg_type: str, content: str) -> None:
        if on_progress is None:
            return
        maybe = on_progress(msg_type, content)
        if isawaitable(maybe):
            await maybe

    heuristic = apply_heuristic_noise_triage(vulnerabilities)
    result.heuristic_ignored = heuristic.heuristic_ignored
    result.ignored.extend(heuristic.ignored)
    heuristic_candidates = list(heuristic.keep)

    if result.heuristic_ignored:
        await emit(
            "info",
            (
                f"Noise triage filtered {result.heuristic_ignored} obvious non-actionable finding(s) "
                f"before remediation ({len(heuristic_candidates)} remaining)."
            ),
        )

    # Medium and low findings are deliberately ignored before any inference.
    # They remain in the common scope filter so the UI gets the correct count.
    always_remediate = [vuln for vuln in heuristic_candidates if vuln.severity in {"critical", "high"}]

    for vuln in always_remediate:
        _apply_decision(
            vuln,
            TriageDecision("remediate", "critical/high severity retained", 1.0),
            result=result,
        )

    for vuln in heuristic_candidates:
        if vuln.severity in {"critical", "high"}:
            continue
        _apply_decision(
            vuln,
            TriageDecision("remediate", "below critical/high remediation policy", 0.0),
            result=result,
        )

    scoped_keep, scope_dropped = filter_by_remediation_scope(result.keep, remediation_scope)
    if scope_dropped:
        await emit(
            "info",
            (
                f"Remediation scope is critical/high only — skipped {scope_dropped} "
                "medium/low finding(s)."
            ),
        )
    result.keep = scoped_keep

    return result
