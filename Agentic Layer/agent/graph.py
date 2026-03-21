"""Bridge to the KGagent LangGraph pipeline — delegates vulnerability intelligence."""

import asyncio
import sys
from pathlib import Path

# Resolve KGagent root — Docker mounts it at /app/KGagent, dev path is ../../KGagent
_KG_DOCKER = Path(__file__).parent.parent / "KGagent"        # /app/KGagent in Docker
_KG_DEV    = Path(__file__).parent.parent.parent / "KGagent" # DeplAI/KGagent in dev

KG_PATH = _KG_DOCKER if _KG_DOCKER.exists() else _KG_DEV
sys.path.insert(0, str(KG_PATH))

from dotenv import load_dotenv
load_dotenv(KG_PATH / ".env")

try:
    from pipeline.langgraph_agent import agent_query as _kg_agent_query
    _KG_AVAILABLE = True
    _KG_IMPORT_ERROR = ""
except Exception as _e:  # noqa: BLE001
    _KG_AVAILABLE = False
    _KG_IMPORT_ERROR = str(_e)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _run_kg_query(query: str, entity: dict | None = None) -> dict:
    """Call the KGagent synchronously. Returns a structured result dict."""
    if not _KG_AVAILABLE:
        return {"status": "error", "error": f"KGagent unavailable: {_KG_IMPORT_ERROR}"}
    try:
        return _kg_agent_query(
            query=query,
            entity=entity,
            max_steps=4,
            calling_agent="deplai_remediator",
        )
    except Exception as exc:
        return {"status": "error", "error": str(exc)}


def _fmt_evidence(items: list) -> str:
    if not items:
        return "  None found."
    lines = []
    for item in items[:5]:
        if isinstance(item, dict):
            eid   = item.get("id") or item.get("cve_id", "")
            desc  = item.get("description") or item.get("summary", "")
            score = item.get("cvss") or item.get("score", "")
            rel   = item.get("relationship") or item.get("correlation_type", "")
            line  = f"  - {eid}"
            if rel:
                line += f" [{rel}]"
            if score:
                line += f" (CVSS: {score})"
            if desc:
                line += f": {str(desc)[:100]}"
            lines.append(line)
        else:
            lines.append(f"  - {item}")
    return "\n".join(lines)


def _extract_corr_ids(items: list) -> list[dict]:
    """Pull id, description and relationship out of evidence items for the UI."""
    out = []
    for item in items[:5]:
        if isinstance(item, dict):
            out.append({
                "id":           item.get("id") or item.get("cve_id", ""),
                "description":  str(item.get("description") or item.get("summary") or "")[:120],
                "relationship": item.get("relationship") or item.get("correlation_type", ""),
                "cvss":         item.get("cvss") or item.get("score", ""),
            })
        elif isinstance(item, str) and item.strip():
            out.append({"id": item.strip(), "description": "", "relationship": "", "cvss": ""})
    return out


def _summarize_kg_result(entity_id: str, result: dict) -> str:
    """One-line streaming summary of a KGagent query result."""
    if result.get("status") == "error":
        return f"{entity_id} → KG offline, using scan data only"
    direct     = result.get("direct_evidence", [])
    candidates = result.get("inferred_candidates", [])
    conf       = result.get("confidence_summary", {})
    actions    = result.get("recommended_actions", [])
    conf_val   = conf.get("overall", 0) if isinstance(conf, dict) else 0
    parts: list[str] = []
    if direct:
        parts.append(f"{len(direct)} direct correlation{'s' if len(direct) != 1 else ''}")
    if candidates:
        parts.append(f"{len(candidates)} inferred correlation{'s' if len(candidates) != 1 else ''}")
    if conf_val:
        parts.append(f"{int(conf_val * 100)}% confidence")
    summary = ", ".join(parts) if parts else "no graph correlations found"
    top_action = (actions[0] if isinstance(actions, list) and actions else "")
    if top_action:
        summary += f" — {str(top_action)[:70]}"
    return f"{entity_id} → {summary}"


def _build_business_summary(supply_chain: list, code_security: list, sbom: dict) -> str:
    components = sbom.get("components", [])
    langs: set[str] = set()
    for comp in components:
        purl = (comp.get("purl") or "").lower()
        name = (comp.get("name") or "").lower()
        if "python" in purl or any(k in name for k in ("flask", "django", "fastapi", "sqlalchemy", "uvicorn")):
            langs.add("Python")
        if "npm" in purl or "javascript" in purl or any(k in name for k in ("react", "next", "vue", "express", "node")):
            langs.add("JavaScript/Node.js")
        if "java" in purl or any(k in name for k in ("spring", "maven", "gradle")):
            langs.add("Java")
        if "golang" in purl or "go" in purl:
            langs.add("Go")
        if "rust" in purl:
            langs.add("Rust")

    tech = ", ".join(sorted(langs)) if langs else "unknown"
    severity_counts: dict[str, int] = {}
    for v in supply_chain:
        sev = v.get("severity", "Unknown")
        severity_counts[sev] = severity_counts.get(sev, 0) + 1

    parts = [f"Application uses {len(components)} third-party components."]
    if tech != "unknown":
        parts.append(f"Detected technologies: {tech}.")
    if severity_counts:
        parts.append(
            "Supply chain risk profile: "
            + ", ".join(f"{k}: {v}" for k, v in sorted(severity_counts.items()))
            + "."
        )
    if code_security:
        high_static = [f for f in code_security if f.get("severity") in ("critical", "high")]
        if high_static:
            parts.append(f"{len(high_static)} high/critical static analysis finding group(s) detected.")

    return " ".join(parts)


def _build_vulnerability_summary(supply_chain: list, code_security: list, kg_results: list) -> str:
    sections: list[str] = []

    if code_security:
        high = [f for f in code_security if f.get("severity") in ("critical", "high")]
        sections.append(f"### Static Analysis ({len(code_security)} finding groups, {len(high)} critical/high)")
        for f in high[:10]:
            sections.append(
                f"  - CWE-{f.get('cwe_id', '?')} ({f.get('severity', '').upper()}): "
                f"{f.get('title', '')} — {f.get('count', 0)} occurrence(s)"
            )
        if len(high) > 10:
            sections.append(f"  ... and {len(high) - 10} more")

    if supply_chain:
        critical = [v for v in supply_chain if v.get("severity") in ("Critical", "High")]
        sections.append(f"\n### Supply Chain ({len(supply_chain)} vulnerabilities, {len(critical)} critical/high)")
        for v in critical[:10]:
            fix = f" → fix: {v['fix_version']}" if v.get("fix_version") else " (no fix available)"
            sections.append(
                f"  - {v.get('cve_id', 'N/A')} in {v.get('name', '?')} "
                f"{v.get('version', '')}{fix}"
            )
        if len(critical) > 10:
            sections.append(f"  ... and {len(critical) - 10} more")

    ok_results = [r for r in kg_results if r.get("status") != "error"]
    if ok_results:
        sections.append("\n### Knowledge Graph Correlations")
        for r in ok_results:
            entity    = r.get("entity", {})
            entity_id = entity.get("id", "") if isinstance(entity, dict) else str(entity)
            direct    = r.get("direct_evidence", [])
            candidates = r.get("inferred_candidates", [])
            conf      = r.get("confidence_summary", {})
            conf_text = conf.get("verdict", "") if isinstance(conf, dict) else str(conf)

            sections.append(f"\n**{entity_id or 'General analysis'}**")
            if conf_text:
                sections.append(f"  Confidence: {conf_text}")
            if direct:
                sections.append(f"  Directly correlated vulnerabilities (confirmed attack-surface overlap):\n{_fmt_evidence(direct)}")
            if candidates:
                sections.append(f"  Inferred correlations (probable relationship via shared CWE/component):\n{_fmt_evidence(candidates)}")

            actions = r.get("recommended_actions", [])
            if actions and isinstance(actions, list):
                sections.append("  Recommended Actions:")
                for a in actions[:3]:
                    sections.append(f"    • {a}")

    return "\n".join(sections) if sections else "No vulnerability data available."


# ── Main entry point ──────────────────────────────────────────────────────────

async def run_analysis_agent(
    project_id: str,
    scan_data: dict,
    on_message=None,
) -> dict:
    """Query the KGagent for each significant CVE/CWE in the scan results.

    Args:
        project_id: The project being analyzed.
        scan_data: Parsed scan results from dataingestor (code_security, supply_chain, sbom).
        on_message: Optional async callback(msg_type, content) for streaming progress.

    Returns:
        Dict with business_logic_summary, vulnerability_summary, final_report.
    """
    loop = asyncio.get_running_loop()
    supply_chain  = scan_data.get("supply_chain", [])
    code_security = scan_data.get("code_security", [])
    sbom          = scan_data.get("sbom", {})

    async def emit(msg_type: str, content: str):
        if on_message:
            await on_message(msg_type, content)

    await emit("kg_phase", "Initializing Knowledge Graph Analysis")

    # ── Collect top CVEs (critical/high, deduped, max 3) ──────────────────────
    seen_cves: set[str] = set()
    top_cves: list[str] = []
    for v in supply_chain:
        cve = v.get("cve_id", "")
        if cve and cve not in seen_cves and v.get("severity") in ("Critical", "High"):
            seen_cves.add(cve)
            top_cves.append(cve)
        if len(top_cves) >= 3:
            break

    # ── Collect unique CWEs from code security (max 2) ────────────────────────
    seen_cwes: set[str] = set()
    top_cwes: list[str] = []
    for f in sorted(code_security, key=lambda x: x.get("count", 0), reverse=True):
        cwe = f.get("cwe_id", "")
        if cwe and cwe != "unknown" and cwe not in seen_cwes:
            seen_cwes.add(cwe)
            top_cwes.append(cwe)
        if len(top_cwes) >= 2:
            break

    kg_results: list[dict] = []
    query_log: list[dict] = []

    # ── Run all KGagent queries concurrently ──────────────────────────────────
    _KG_QUERY_TIMEOUT = 25.0

    async def _single_query(
        entity_key: str,
        entity_type: str,
        query: str,
        entity: dict | None,
    ) -> tuple[str, str, dict]:
        try:
            result = await asyncio.wait_for(
                loop.run_in_executor(None, lambda: _run_kg_query(query=query, entity=entity)),
                timeout=_KG_QUERY_TIMEOUT,
            )
        except asyncio.TimeoutError:
            result = {"status": "error", "error": f"KGagent query timed out after {_KG_QUERY_TIMEOUT}s"}
        return entity_key, entity_type, result

    query_tasks = []
    for cve_id in top_cves:
        query_tasks.append(_single_query(
            cve_id, "cve",
            (
                f"Analyze vulnerability {cve_id} — what co-occurring vulnerabilities "
                "exist in Python applications and what is the exploit risk?"
            ),
            {"type": "cve", "id": cve_id},
        ))
    for cwe_id in top_cwes:
        entity_key = f"CWE-{cwe_id}"
        # Phrasing triggers _should_force_cwe_tool guardrail in langgraph_agent.py,
        # skipping the LLM planning step and going straight to graphrag_query.
        query_tasks.append(_single_query(
            entity_key, "cwe",
            (
                f"CWE-{cwe_id} — what co-occurring vulnerabilities and "
                "remediation strategies exist"
            ),
            {"type": "cwe", "id": f"CWE-{cwe_id}"},
        ))

    if query_tasks:
        entities_str = ", ".join(
            list(top_cves) + [f"CWE-{w}" for w in top_cwes]
        )
        await emit("kg_phase", f"Running {len(query_tasks)} KGagent queries concurrently: {entities_str}")
        raw_results = await asyncio.gather(*query_tasks, return_exceptions=True)
        for item in raw_results:
            if isinstance(item, Exception):
                await emit("warning", f"KGagent query failed: {item}")
                continue
            entity_key, entity_type, result = item
            kg_results.append(result)
            summary_text = _summarize_kg_result(entity_key, result)
            await emit("kg_phase", summary_text)
            query_log.append({
                "entity":         entity_key,
                "type":           entity_type,
                "status":         "offline" if result.get("status") == "error" else "online",
                "summary":        summary_text,
                "direct_count":   len(result.get("direct_evidence", [])),
                "inferred_count": len(result.get("inferred_candidates", [])),
                "correlations":   _extract_corr_ids(result.get("direct_evidence", [])),
                "inferred":       _extract_corr_ids(result.get("inferred_candidates", [])),
                "actions":        (result.get("recommended_actions") or [])[:3],
            })

    # ── Fallback: general analysis when no high-severity findings ─────────────
    if not top_cves and not top_cwes:
        await emit("kg_phase", "No high-severity CVEs or CWEs — running general analysis")
        result = await loop.run_in_executor(
            None,
            lambda: _run_kg_query(
                query="Summarize common vulnerability patterns for this application's dependency tree"
            ),
        )
        kg_results.append(result)
        summary_text = _summarize_kg_result("General", result)
        await emit("kg_phase", summary_text)
        query_log.append({
            "entity":            "General",
            "type":              "general",
            "status":            "offline" if result.get("status") == "error" else "online",
            "summary":           summary_text,
            "direct_count":      len(result.get("direct_evidence", [])),
            "inferred_count":    len(result.get("inferred_candidates", [])),
            "correlations":      _extract_corr_ids(result.get("direct_evidence", [])),
            "inferred":          _extract_corr_ids(result.get("inferred_candidates", [])),
            "actions":           (result.get("recommended_actions") or [])[:3],
        })

    await emit("kg_phase", "Building vulnerability intelligence report")

    business_summary      = _build_business_summary(supply_chain, code_security, sbom)
    vulnerability_summary = _build_vulnerability_summary(supply_chain, code_security, kg_results)
    final_report = (
        "=== DEPLAI SECURITY ANALYSIS REPORT ===\n\n"
        "--- BUSINESS LOGIC SUMMARY ---\n"
        f"{business_summary}\n\n"
        "--- VULNERABILITY SUMMARY ---\n"
        f"{vulnerability_summary}\n"
    )

    # Build structured context for the UI panel
    critical_sc = [v for v in supply_chain if v.get("severity") in ("Critical", "High")]
    top_cs = sorted(code_security, key=lambda x: x.get("count", 0), reverse=True)
    context = {
        "total_components": len(sbom.get("components", [])),
        "queries":    query_log,
        "code_security": [
            {
                "cwe_id":   f.get("cwe_id", "?"),
                "title":    f.get("title", ""),
                "severity": f.get("severity", ""),
                "count":    f.get("count", 0),
            }
            for f in top_cs[:8]
        ],
        "supply_chain": [
            {
                "cve_id":      v.get("cve_id", ""),
                "name":        v.get("name", ""),
                "version":     v.get("version", ""),
                "severity":    v.get("severity", ""),
                "fix_version": v.get("fix_version"),
            }
            for v in critical_sc[:8]
        ],
    }

    await emit("success", "Knowledge graph analysis complete — context injected into remediator")

    return {
        "business_logic_summary": business_summary,
        "vulnerability_summary":  vulnerability_summary,
        "final_report":           final_report,
        "context":                context,
    }
