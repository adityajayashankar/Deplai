"""Multi-agent remediation supervisor: Proposer → Critic → Synthesizer negotiation loop.

Architecture
------------
  Proposer agent   — LLM call: generate concrete code fixes from scan + KG context
  Critic agent     — LLM call: review proposal for correctness, coverage, safety
  Supervisor router — accept → Synthesizer
                      reject (round < MAX_ROUNDS) → Proposer (with feedback injected)
                      reject (round >= MAX_ROUNDS) → Synthesizer (best-effort)
  Synthesizer agent — write accepted changes to the codebase volume, return result

The graph is a LangGraph StateGraph.  Execution is driven node-by-node so we
can `await emit(...)` between each step for real-time WebSocket streaming.
"""

import asyncio
import contextvars
import json
import os
import time
from typing import Any, TypedDict

from langgraph.graph import StateGraph, END

# ── Reuse LLM backends & file helpers from claude_remediator ─────────────────
# (private helpers are intentionally imported — same module boundary)
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from claude_remediator import (  # noqa: E402
    _call_groq,
    _call_ollama,
    _call_openai,
    _call_gemini,
    _call_openrouter,
    _collect_context_files,
    _extract_json,
    _normalize_changes_with_report,
    _read_file,
    _validate_change_candidate,
    _write_file,
)

# ── Tools (used by Planner for targeted codebase reconnaissance) ──────────────
try:
    from .tools import list_files as _tool_list_files, search_code as _tool_search_code
    _TOOLS_AVAILABLE = True
except Exception:
    try:
        from tools import list_files as _tool_list_files, search_code as _tool_search_code  # type: ignore[no-redef]
        _TOOLS_AVAILABLE = True
    except Exception:
        _TOOLS_AVAILABLE = False
        _tool_list_files = None  # type: ignore[assignment]
        _tool_search_code = None  # type: ignore[assignment]

# ── Configuration ──────────────────────────────────────────────────────────────
def _env_int_positive(name: str, default: int) -> int:
    raw = os.getenv(name, str(default))
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


AGENT_DELAY_SECONDS = float(os.getenv("REMEDIATION_AGENT_DELAY_SECONDS", "3"))
AGENT_NODE_TIMEOUT_SECONDS = float(os.getenv("REMEDIATION_AGENT_NODE_TIMEOUT_SECONDS", "180"))
MAX_ROUNDS = 3  # Max Proposer→Critic negotiation rounds (2 = two full attempts)
SUPERVISOR_MAX_FILES = _env_int_positive("REMEDIATION_SUPERVISOR_MAX_FILES", 8)
SUPERVISOR_MAX_FILE_CHARS = _env_int_positive("REMEDIATION_SUPERVISOR_MAX_FILE_CHARS", 2200)
SUPERVISOR_MAX_CONTEXT_CHARS = _env_int_positive("REMEDIATION_SUPERVISOR_MAX_CONTEXT_CHARS", 12000)
SUPERVISOR_MAX_FINDINGS = _env_int_positive("REMEDIATION_SUPERVISOR_MAX_FINDINGS", 16)
SUPERVISOR_MAX_PROMPT_CHARS = _env_int_positive("REMEDIATION_SUPERVISOR_MAX_PROMPT_CHARS", 22000)


# ── Shared state ───────────────────────────────────────────────────────────────

class RemediationState(TypedDict):
    # ── Inputs ────────────────────────────────────────────────────────────────
    scan_data: dict
    contexts: dict          # {relative_path: file_content}
    allowed_paths: list     # list[str] — paths the Synthesizer may write
    cortex_context: str
    agent_analysis: dict
    llm_provider: str
    llm_api_key: str
    llm_model: str
    # ── Planner output ──────────────────────────────────────────────────────────
    planned_context: dict   # targeted snippets from Planner's tool calls
    # ── Negotiation state ─────────────────────────────────────────────────────
    round: int
    proposal: dict          # {"summary": str, "changes": [...]}  — from Proposer
    proposer_parse_warning: str
    critique: dict          # {"verdict": str, "feedback": str, "missing": [...]}
    # ── Output ────────────────────────────────────────────────────────────────
    final_result: dict
    error: str


# ── LLM dispatch  (rate-limit-aware) ──────────────────────────────────────────

def _call_with_backoff(fn, max_retries: int = 2) -> tuple[bool, str]:
    """Call fn() with exponential back-off on 429 / rate-limit errors."""
    ok, result = False, "No attempts made"
    for attempt in range(max_retries):
        ok, result = fn()
        if ok:
            return ok, result
        lower = (result or "").lower()
        if "429" in result or "rate limit" in lower or "rate_limit" in lower:
            wait = 15 * (attempt + 1)
            time.sleep(wait)
        else:
            return ok, result  # non-rate-limit error, fail fast
    return ok, result


def _dispatch_llm(
    prompt: str,
    provider: str,
    api_key: str,
    model: str,
) -> tuple[bool, str]:
    """Route supervisor LLM calls through user-selected provider, then fallback chain."""
    provider = (provider or "").strip().lower()
    api_key = (api_key or "").strip()
    model = (model or "").strip()
    selected_model = (os.getenv("OLLAMA_MODEL", "qwen2.5-coder:7b").strip() or "qwen2.5-coder:7b")
    errors: list[str] = []

    def _record(label: str, result: str) -> None:
        errors.append(f"{label}: {result}")

    # If a specific provider was selected, try it first.
    try:
        if provider == "openai":
            if api_key:
                ok, text = _call_with_backoff(lambda: _call_openai(prompt, api_key, model or "gpt-4o"))
                if ok:
                    return ok, text
                _record("openai", text)
            else:
                _record("openai", "Missing API key for selected provider.")
        elif provider == "gemini":
            if api_key:
                ok, text = _call_with_backoff(lambda: _call_gemini(prompt, api_key, model or "gemini-2.5-pro"))
                if ok:
                    return ok, text
                _record("gemini", text)
            else:
                _record("gemini", "Missing API key for selected provider.")
        elif provider == "openrouter":
            ok, text = _call_with_backoff(
                lambda: _call_openrouter(prompt, api_key=api_key or None, preferred_model=model or None)
            )
            if ok:
                return ok, text
            _record("openrouter", text)
        elif provider == "groq":
            ok, text = _call_with_backoff(lambda: _call_groq(prompt))
            if ok:
                return ok, text
            _record("groq", text)
        elif provider == "ollama":
            ok, text = _call_with_backoff(lambda: _call_ollama(prompt, selected_model))
            if ok:
                return ok, text
            _record("ollama", text)
    except Exception as exc:
        _record(provider or "selected_provider", f"unexpected error: {exc}")

    # Default chain when selected provider failed/unavailable.
    # Required order: Groq -> Ollama Cloud -> OpenRouter.
    groq_ok, groq_text = _call_with_backoff(lambda: _call_groq(prompt))
    if groq_ok:
        return groq_ok, groq_text
    _record("groq", groq_text)

    ollama_ok, ollama_text = _call_with_backoff(lambda: _call_ollama(prompt, selected_model))
    if ollama_ok:
        return ollama_ok, ollama_text
    _record("ollama", ollama_text)

    openrouter_ok, openrouter_text = _call_with_backoff(lambda: _call_openrouter(prompt))
    if openrouter_ok:
        return openrouter_ok, openrouter_text
    _record("openrouter", openrouter_text)
    return (False, " | ".join(errors))

# ── Planner: CWE → search-pattern map ─────────────────────────────────────────
# Maps common CWE IDs to grep-compatible patterns so the Planner can locate
# vulnerable code sites before the Proposer runs.
_CWE_PATTERNS: dict[str, str] = {
    "89":  r"execute\(|cursor\.execute|\.query\(",            # SQL Injection
    "79":  r"innerHTML|dangerouslySetInnerHTML|document\.write",  # XSS
    "78":  r"os\.system|subprocess\.Popen|subprocess\.call|exec\(",  # Command Injection
    "22":  r"\.\./|os\.path\.join|path\.join",               # Path Traversal
    "798": r"password\s*=\s*['\"]|api_key\s*=\s*['\"]|secret\s*=\s*['\"]",  # Hardcoded Credentials
    "502": r"pickle\.loads|yaml\.load\(|marshal\.loads",     # Deserialization
    "327": r"md5\(|sha1\(|MD5\(",                            # Weak Crypto
    "200": r"traceback\.print_exc|debug\s*=\s*True",         # Info Disclosure
    "611": r"parseXML|etree\.parse|ElementTree\.parse",      # XXE
    "918": r"requests\.get|urllib\.request\.urlopen|fetch\(",# SSRF
}


def _planner_node(state: RemediationState) -> RemediationState:
    """Planner agent: uses codebase tools to build targeted, vulnerability-aware context.

    Runs ``list_files`` to map repo structure, then ``search_code`` for each
    significant CWE found in the scan — giving the Proposer precise file locations
    rather than relying solely on pre-fetched full-file dumps.
    Gracefully degrades to empty planned_context when tools are unavailable.
    """
    if not _TOOLS_AVAILABLE:
        return {**state, "planned_context": {}}

    scan_data     = state["scan_data"]
    code_findings = scan_data.get("code_security", [])
    planned: dict = {}

    # Repo structure overview ──────────────────────────────────────────────────
    try:
        structure = _tool_list_files.invoke({"directory": "/"})  # type: ignore[union-attr]
        if structure and "Error" not in structure:
            planned["repo_structure"] = structure[:2000]
    except Exception:
        pass

    # Targeted search per CWE ──────────────────────────────────────────────────
    seen: set[str] = set()
    for finding in code_findings[:6]:
        cwe = str(finding.get("cwe_id") or "").strip()
        if not cwe or cwe == "unknown" or cwe in seen:
            continue
        seen.add(cwe)
        pattern = _CWE_PATTERNS.get(cwe, "")
        if not pattern:
            continue
        try:
            hits = _tool_search_code.invoke(  # type: ignore[union-attr]
                {"pattern": pattern, "file_extensions": "py,js,ts,jsx,tsx,java,go,php,rb"}
            )
            if hits and "No matches" not in hits and "Error" not in hits:
                planned[f"CWE-{cwe}_locations"] = hits[:1500]
        except Exception:
            pass

    return {**state, "planned_context": planned}


# ── Prompts ────────────────────────────────────────────────────────────────────

def _build_proposer_prompt(state: RemediationState) -> str:
    scan_data       = state["scan_data"]
    contexts        = state["contexts"]
    cortex_context  = state.get("cortex_context") or ""
    agent_analysis  = state.get("agent_analysis") or {}
    critique        = state.get("critique") or {}
    round_num       = state.get("round", 0)

    code_findings   = scan_data.get("code_security", [])[:SUPERVISOR_MAX_FINDINGS]
    supply_findings = scan_data.get("supply_chain", [])[:SUPERVISOR_MAX_FINDINGS]

    compact_code: list[dict[str, Any]] = []
    for f in code_findings:
        if isinstance(f, dict):
            compact_code.append(
                {
                    "cwe_id": f.get("cwe_id"),
                    "severity": f.get("severity"),
                    "count": f.get("count"),
                    "title": f.get("title") or f.get("name"),
                    "description": str(f.get("description", ""))[:180],
                }
            )

    compact_supply: list[dict[str, Any]] = []
    for f in supply_findings:
        if isinstance(f, dict):
            compact_supply.append(
                {
                    "cve_id": f.get("cve_id"),
                    "severity": f.get("severity"),
                    "package": f.get("package") or f.get("name"),
                    "installed_version": f.get("installed_version"),
                    "fix_version": f.get("fix_version"),
                }
            )

    file_sections: list[str] = []
    total_context_chars = 0
    for path, content in list(contexts.items())[:SUPERVISOR_MAX_FILES]:
        if total_context_chars >= SUPERVISOR_MAX_CONTEXT_CHARS:
            break
        snippet = str(content or "")[:SUPERVISOR_MAX_FILE_CHARS]
        remaining = SUPERVISOR_MAX_CONTEXT_CHARS - total_context_chars
        if remaining <= 0:
            break
        if len(snippet) > remaining:
            snippet = snippet[:remaining]
        total_context_chars += len(snippet)
        file_sections.append(f"### {path}\n```text\n{snippet}\n```")

    biz = agent_analysis.get("business_logic_summary", "").strip()
    vuln = agent_analysis.get("vulnerability_summary", "").strip()
    kg_block = ""
    if biz or vuln:
        kg_block = f"""
Knowledge Graph Analysis:
  Business Logic: {biz or 'Not analyzed'}
  Vulnerability Context: {vuln or 'Not analyzed'}
"""

    critique_block = ""
    if round_num > 0 and critique:
        fb      = critique.get("feedback", "")
        missing = critique.get("missing", [])
        missing_str = "\n".join(f"  - {m}" for m in missing) if missing else "  None specified"
        critique_block = f"""
PREVIOUS CRITIC FEEDBACK (Round {round_num}):
The Critic rejected your previous proposal. You MUST address all issues below.

Feedback: {fb}

Unaddressed findings:
{missing_str}
"""

    # Planner reconnaissance block ─────────────────────────────────────────────
    planner_block = ""
    planned = state.get("planned_context") or {}
    if planned:
        lines: list[str] = []
        if "repo_structure" in planned:
                lines.append(f"Repository file tree:\n{str(planned['repo_structure'])[:1200]}\n")
        for key, val in planned.items():
            if key.endswith("_locations") and val:
                cwe_label = key.replace("_locations", "")
                lines.append(f"{cwe_label} vulnerable pattern occurrences:\n{str(val)[:900]}\n")
        if lines:
            planner_block = (
                "\nPlanner Reconnaissance (tool-assisted — precise locations of vulnerable code):\n"
                + "\n".join(lines)
            )

    prompt = f"""You are the Proposer agent in a multi-agent security remediation system.

Your task: Generate concrete, correct code fixes for the security vulnerabilities listed.

Output ONLY valid JSON — no markdown fences, no prose outside the object:
{{
  "summary": "one-sentence description of what was fixed",
  "changes": [
    {{
      "path": "relative/path/to/file.ext",
      "reason": "which vulnerability this addresses and how",
      "content": "COMPLETE updated file content (not a diff or snippet)"
    }}
  ]
}}

Rules:
1. Only modify files present in the Repository Files section below.
2. Provide the full updated file content for every changed file.
3. Changes must be minimal and targeted — fix the vulnerability, preserve functionality.
4. All code must be syntactically correct.
5. If a safe fix is not possible for a finding, omit it and note it in the summary.
{critique_block}{planner_block}{kg_block}
Security Findings:
{json.dumps({"code_security": compact_code, "supply_chain": compact_supply}, indent=2)}

Cortex Context: {cortex_context or "None"}

Repository Files:
{chr(10).join(file_sections)}"""

    if len(prompt) > SUPERVISOR_MAX_PROMPT_CHARS:
        return prompt[:SUPERVISOR_MAX_PROMPT_CHARS]
    return prompt


def _build_critic_prompt(state: RemediationState) -> str:
    scan_data  = state["scan_data"]
    proposal   = state.get("proposal") or {}
    round_num  = state.get("round", 0)

    code_findings   = scan_data.get("code_security", [])[:SUPERVISOR_MAX_FINDINGS]
    supply_findings = scan_data.get("supply_chain", [])[:SUPERVISOR_MAX_FINDINGS]
    raw_changes = (proposal.get("changes", []) or [])[:8]
    compact_changes: list[dict[str, Any]] = []
    for change in raw_changes:
        if not isinstance(change, dict):
            continue
        compact_changes.append(
            {
                "path": change.get("path"),
                "reason": str(change.get("reason", ""))[:220],
                "content_preview": str(change.get("content", ""))[:260],
                "content_chars": len(str(change.get("content", ""))),
            }
        )

    prompt = f"""You are the Critic agent in a multi-agent security remediation system.

Your task: Review the proposed code fixes and decide whether they adequately and safely address the vulnerabilities.

Proposal Summary: {proposal.get("summary", "(none)")}

Proposed Changes (Round {round_num + 1}):
{json.dumps(compact_changes, indent=2)}

Original Security Findings:
{json.dumps({"code_security": code_findings, "supply_chain": supply_findings}, indent=2)}

Evaluation criteria:
  1. COVERAGE  — Does the proposal address the critical/high-severity findings?
  2. CORRECTNESS — Is the code syntactically valid and functionally correct?
  3. SAFETY    — Does it introduce new vulnerabilities or break existing functionality?
  4. COMPLETENESS — Are complete file contents provided (not partial diffs)?

Output ONLY valid JSON:
{{
  "verdict": "accept",
  "feedback": "concise explanation of your decision",
  "missing": ["list of vulnerability IDs / descriptions that are still unaddressed"],
  "quality_score": <integer 0-10>
}}

Use "reject" for `verdict` only when critical findings are completely unaddressed or
the code contains clear correctness/safety issues.  Accept if the majority of
critical/high findings are properly mitigated."""

    if len(prompt) > SUPERVISOR_MAX_PROMPT_CHARS:
        return prompt[:SUPERVISOR_MAX_PROMPT_CHARS]
    return prompt


def _heuristic_critic_verdict(state: RemediationState, parse_error: Exception) -> dict[str, Any]:
    """Fallback critic when LLM output is non-JSON.

    If proposer returned parseable changes and no proposer JSON warning, we allow
    progress (safety is still enforced by synthesizer validators). Otherwise reject.
    """
    proposal = state.get("proposal") or {}
    proposer_warning = str(state.get("proposer_parse_warning", "") or "").strip()
    changes = proposal.get("changes", [])
    has_changes = isinstance(changes, list) and len(changes) > 0

    if has_changes and not proposer_warning:
        return {
            "verdict": "accept",
            "feedback": (
                "Critic JSON parse fallback: LLM output was non-JSON; accepting proposal "
                "for synthesizer safety validation."
            ),
            "missing": [],
            "quality_score": 5,
        }

    return {
        "verdict": "reject",
        "feedback": (
            f"Critic output malformed JSON ({parse_error}). "
            "Proposal is incomplete or unparseable, retrying proposer."
        ),
        "missing": ["Critic JSON unavailable and proposer payload was weak"],
        "quality_score": 0,
    }


# ── Agent nodes (synchronous — called via run_in_executor) ────────────────────

def _proposer_node(state: RemediationState) -> RemediationState:
    ok, raw_text = _dispatch_llm(
        _build_proposer_prompt(state),
        provider=state.get("llm_provider", ""),
        api_key=state.get("llm_api_key", ""),
        model=state.get("llm_model", ""),
    )
    if not ok:
        return {**state, "error": f"Proposer LLM call failed: {raw_text}"}

    try:
        parsed   = _extract_json(raw_text)
        proposal = {
            "summary": str(parsed.get("summary", "")).strip(),
            "changes": parsed.get("changes", []),
        }
        return {**state, "proposal": proposal, "proposer_parse_warning": ""}
    except Exception as exc:
        # Soft-fail this round instead of terminating the workflow.
        # Critic will reject empty proposal and force a retry with feedback.
        proposal = {
            "summary": "Malformed proposer output; no actionable file changes parsed in this round.",
            "changes": [],
        }
        return {
            **state,
            "proposal": proposal,
            "proposer_parse_warning": f"Proposer JSON parse error: {exc}",
        }


def _critic_node(state: RemediationState) -> RemediationState:
    if state.get("error"):
        return state

    ok, raw_text = _dispatch_llm(
        _build_critic_prompt(state),
        provider=state.get("llm_provider", ""),
        api_key=state.get("llm_api_key", ""),
        model=state.get("llm_model", ""),
    )

    if not ok:
        # Critic LLM call failed even after backoff retries — hard failure.
        # Do NOT auto-accept: a bypass here would defeat the entire multi-agent check.
        return {**state, "error": f"Critic agent failed: {raw_text}"}

    try:
        parsed  = _extract_json(raw_text)
        verdict = str(parsed.get("verdict", "accept")).lower().strip()
        if verdict not in ("accept", "reject"):
            verdict = "accept"
        critique = {
            "verdict":       verdict,
            "feedback":      str(parsed.get("feedback", "")).strip(),
            "missing":       parsed.get("missing", []),
            "quality_score": int(parsed.get("quality_score", 5)),
        }
    except Exception as exc:
        critique = _heuristic_critic_verdict(state, exc)

    return {**state, "critique": critique}


def _synthesizer_node(state: RemediationState) -> RemediationState:
    if state.get("error"):
        return {**state, "final_result": {"error": state["error"]}}

    proposal      = state.get("proposal") or {}
    allowed_paths = set(state.get("allowed_paths") or [])
    raw_changes   = proposal.get("changes", [])
    changes, rejected_changes = _normalize_changes_with_report(proposal, allowed_paths)

    changed_files: list[dict[str, str]] = []
    for change in changes:
        try:
            before_content = _read_file(change.path, max_bytes=200_000)
            if before_content == change.content:
                rejected_changes.append(
                    {"path": change.path, "reason": "No-op change (content identical to current file)"}
                )
                continue
            ok_candidate, reason = _validate_change_candidate(change.path, before_content, change.content)
            if not ok_candidate:
                rejected_changes.append({"path": change.path, "reason": reason})
                continue
            _write_file(change.path, change.content)
            changed_files.append({"path": change.path, "reason": change.reason})
        except Exception as exc:
            return {**state, "error": f"Synthesizer failed writing {change.path}: {exc}"}

    critique    = state.get("critique") or {}
    verdict     = critique.get("verdict", "unknown")
    rounds_used = state.get("round", 0) + 1
    summary     = proposal.get("summary", "Remediation completed.")
    if verdict == "reject":
        summary = f"[Best-effort after {rounds_used} negotiation round(s)] {summary}"

    normalized_rejected: list[dict[str, str]] = []
    for item in rejected_changes:
        if isinstance(item, dict):
            normalized_rejected.append(
                {
                    "path": str(item.get("path", "")),
                    "reason": str(item.get("reason", "unspecified reason")),
                }
            )
        else:
            normalized_rejected.append(
                {
                    "path": str(getattr(item, "path", "")),
                    "reason": str(getattr(item, "reason", "unspecified reason")),
                }
            )

    return {
        **state,
        "final_result": {
            "summary":             summary,
            "changed_files":       changed_files,
            "rejected_changes":    normalized_rejected,
            "proposed_change_count": len(raw_changes) if isinstance(raw_changes, list) else 0,
            "applied_change_count":  len(changed_files),
            "files_considered":    list(state.get("contexts", {}).keys()),
            "negotiation_rounds":  rounds_used,
            "critic_verdict":      verdict,
            "critic_score":        critique.get("quality_score", 0),
        },
    }


# ── LangGraph graph (topology definition) ─────────────────────────────────────

def _route_proposer(state: RemediationState) -> str:
    return "error_end" if state.get("error") else "critic"


def _route_critic(state: RemediationState) -> str:
    if state.get("error"):
        return "synthesizer"
    verdict   = (state.get("critique") or {}).get("verdict", "accept")
    round_num = state.get("round", 0)
    if verdict == "accept":
        return "synthesizer"
    if round_num < MAX_ROUNDS - 1:
        return "proposer"   # second round — Proposer re-runs with feedback
    return "synthesizer"    # force-synthesize after max rounds


def build_supervisor_graph() -> Any:
    """Return a compiled LangGraph StateGraph for the remediation supervisor.

    Graph topology:
        Planner → Proposer → Critic (loop up to MAX_ROUNDS) → Synthesizer → END
    """
    g = StateGraph(RemediationState)
    g.add_node("planner",     _planner_node)
    g.add_node("proposer",    _proposer_node)
    g.add_node("critic",      _critic_node)
    g.add_node("synthesizer", _synthesizer_node)
    # error_end is a pass-through so errors surface properly at END
    g.add_node("error_end",   lambda s: s)

    g.set_entry_point("planner")
    g.add_edge("planner", "proposer")   # Planner always feeds Proposer

    g.add_conditional_edges("proposer", _route_proposer, {
        "critic":    "critic",
        "error_end": "error_end",
    })
    g.add_conditional_edges("critic", _route_critic, {
        "synthesizer": "synthesizer",
        "proposer":    "proposer",
    })
    g.add_edge("synthesizer", END)
    g.add_edge("error_end",   END)

    return g.compile()


# ── Async entry point ──────────────────────────────────────────────────────────

async def run_remediation_supervisor(
    scan_data: dict,
    cortex_context: str | None = None,
    llm_provider: str | None = None,
    llm_api_key: str | None = None,
    llm_model: str | None = None,
    agent_analysis: dict | None = None,
    on_message=None,
) -> tuple[bool, dict[str, Any] | str]:
    """
    Run the Proposer → Critic → Synthesizer negotiation loop.

    Drives the LangGraph nodes step-by-step so progress messages can be
    streamed back via `on_message(msg_type, content)` in real time.

    Returns (True, result_dict) on success or (False, error_string) on failure.
    """
    loop = asyncio.get_running_loop()
    ctx = contextvars.copy_context()

    async def run_in_executor_ctx(fn):
        return await loop.run_in_executor(None, ctx.run, fn)

    async def emit(msg_type: str, content: str) -> None:
        if on_message:
            await on_message(msg_type, content)

    # ── Collect repository file contexts ──────────────────────────────────────
    await emit("supervisor_phase", "Collecting repository file contexts…")
    try:
        contexts: dict[str, str] = await run_in_executor_ctx(
            lambda: _collect_context_files(scan_data)
        )
    except Exception as exc:
        return (False, f"Failed to collect context files: {exc}")

    if not contexts:
        return (False, "No readable source files were available for remediation.")

    await emit("supervisor_phase", f"Loaded {len(contexts)} file context(s) — starting negotiation loop")

    state: RemediationState = {
        "scan_data":      scan_data,
        "contexts":       contexts,
        "allowed_paths":  list(contexts.keys()),
        "cortex_context": cortex_context or "",
        "agent_analysis": agent_analysis or {},
        "llm_provider":   llm_provider or "",
        "llm_api_key":    llm_api_key or "",
        "llm_model":      llm_model or "",
        "round":          0,
        "proposal":       {},
        "proposer_parse_warning": "",
        "critique":       {},
        "planned_context": {},
        "final_result":   {},
        "error":          "",
    }

    # ── Planner ───────────────────────────────────────────────────────────────
    await emit("planner_phase", "Mapping repository structure and searching for vulnerability patterns…")
    state = await run_in_executor_ctx(lambda s=state: _planner_node(s))
    n_planned = len(state.get("planned_context") or {})
    if n_planned:
        await emit("planner_phase", f"Planner gathered {n_planned} targeted context item(s) — injecting into Proposer")
    else:
        await emit("info", "Planner: tools unavailable or no patterns matched — Proposer will use pre-loaded file contexts")

    for current_round in range(MAX_ROUNDS):
        state = {**state, "round": current_round}

        # ── Proposer ──────────────────────────────────────────────────────────
        label = f"Round {current_round + 1}"
        await emit(
            "proposer_phase",
            f"[{label}] Generating security fix proposals… (timeout {int(AGENT_NODE_TIMEOUT_SECONDS)}s)",
        )
        try:
            state = await asyncio.wait_for(
                run_in_executor_ctx(lambda s=state: _proposer_node(s)),
                timeout=AGENT_NODE_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            return (
                False,
                (
                    f"Proposer timed out after {int(AGENT_NODE_TIMEOUT_SECONDS)}s while waiting for LLM response. "
                    "Try a faster model, lower fallback models, or reduce LLM timeout."
                ),
            )

        if state.get("error"):
            return (False, state["error"])

        n_changes = len((state.get("proposal") or {}).get("changes", []))
        await emit("success", f"Proposer [{label}]: proposed {n_changes} file change(s)")
        parse_warning = str(state.get("proposer_parse_warning", "") or "").strip()
        if parse_warning:
            await emit(
                "warning",
                f"Proposer [{label}] output was malformed JSON; continuing this round with 0 parsed changes. {parse_warning[:220]}",
            )

        # Rate-limit guard between Proposer and Critic
        await asyncio.sleep(AGENT_DELAY_SECONDS)

        # ── Critic ────────────────────────────────────────────────────────────
        await emit("critic_phase", f"[{label}] Reviewing proposal for correctness, coverage & safety…")
        try:
            state = await asyncio.wait_for(
                run_in_executor_ctx(lambda s=state: _critic_node(s)),
                timeout=AGENT_NODE_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            return (
                False,
                (
                    f"Critic timed out after {int(AGENT_NODE_TIMEOUT_SECONDS)}s while waiting for LLM response. "
                    "Try a faster model, lower fallback models, or reduce LLM timeout."
                ),
            )

        if state.get("error"):
            return (False, state["error"])

        critique  = state.get("critique") or {}
        verdict   = critique.get("verdict", "accept")
        score     = critique.get("quality_score", 0)
        feedback  = critique.get("feedback", "")[:220]
        await emit(
            "success" if verdict == "accept" else "warning",
            f"Critic [{label}]: {verdict.upper()} (quality {score}/10) — {feedback}",
        )

        if verdict == "accept":
            await emit("supervisor_phase", f"Proposal accepted after {current_round + 1} round(s) — routing to Synthesizer")
            break  # Move on to Synthesizer

        if current_round >= MAX_ROUNDS - 1:
            await emit(
                "supervisor_phase",
                f"Max rounds ({MAX_ROUNDS}) reached — routing best-effort proposal to Synthesizer",
            )
            break

        # Rejection with rounds remaining — loop back to Proposer
        missing = critique.get("missing", [])
        if missing:
            await emit("supervisor_phase", f"{len(missing)} finding(s) still unaddressed — re-queuing Proposer with feedback")

        # Delay before next round
        await asyncio.sleep(AGENT_DELAY_SECONDS)

    # ── Synthesizer ───────────────────────────────────────────────────────────
    await emit("synthesizer_phase", "Writing accepted changes to repository…")
    state = await run_in_executor_ctx(lambda s=state: _synthesizer_node(s))

    if state.get("error"):
        return (False, state["error"])

    final = state.get("final_result") or {}
    if "error" in final:
        return (False, final["error"])

    rounds  = final.get("negotiation_rounds", 1)
    verdict = final.get("critic_verdict", "unknown")
    score   = final.get("critic_score", 0)
    await emit(
        "supervisor_phase",
        f"Negotiation complete — {rounds} round(s) · Critic: {verdict.upper()} · Quality: {score}/10",
    )

    return (True, final)
