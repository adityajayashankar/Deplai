"""
pipeline/model_loader.py
------------------------
LLM backend for the vulnerability agent pipeline.

Fallback order for LLM calls:
  1) Groq (requires GROQ_API_KEY)
  2) Ollama Cloud API (requires OLLAMA_API_KEY)
  3) OpenRouter API (requires OPENROUTER_API_KEY)
  model: qwen2.5-coder:7b (or OLLAMA_MODEL env override)
"""

import os
import time

# ── Groq models (free tier, generous limits) ──────────────────────────────────
# NOTE: Only list models currently active on Groq. Decommissioned model IDs
#       (mixtral-8x7b-32768, gemma2-9b-it) cause 404 errors that exhaust the
#       fallback chain and silently degrade agent quality.
GROQ_MODELS = [
    "llama-3.3-70b-versatile",   # best quality on groq
    "llama-3.1-8b-instant",      # fastest, use when 70b is rate limited
    # Slots 3/4: check https://console.groq.com/docs/models for currently active IDs.
    # "gemma2-9b-it" and "llama-3.2-3b-preview" are decommissioned as of 2026.
]


# ── Ollama cloud model (secondary fallback) ──────────────────────────
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5-coder:7b").strip() or "qwen2.5-coder:7b"
OLLAMA_MODELS = [OLLAMA_MODEL]

OLLAMA_CLOUD_CHAT_ENDPOINT = "https://ollama.com/api/chat"
OLLAMA_CLOUD_API_KEY = os.environ.get("OLLAMA_API_KEY", "").strip()
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "").strip()
OPENROUTER_BASE_URL = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")
OPENROUTER_CHAT_ENDPOINT = f"{OPENROUTER_BASE_URL}/chat/completions"
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "openai/gpt-oss-120b").strip() or "openai/gpt-oss-120b"
OPENROUTER_APP_URL = os.environ.get("NEXT_PUBLIC_APP_URL", "http://localhost:3000")
OPENROUTER_APP_NAME = os.environ.get("OPENROUTER_APP_NAME", "deplai-agentic")

MAX_RETRIES      = 2
RETRY_BASE_DELAY = 5

# ── Layer system prompts ───────────────────────────────────────────────────────
LAYER_CONTEXT: dict[str, str] = {
    "vulnerability_intelligence": (
        "You are a cybersecurity expert. Analyze vulnerabilities, map them to "
        "OWASP Top 10 categories and CWE IDs, and explain their nature and impact."
    ),
    "pentesting_intelligence": (
        "You are a penetration tester. Describe attack methods, payload examples, "
        "detection signals, and tools used to test for vulnerabilities."
    ),
    "risk_scoring": (
        "You are a risk analyst. Evaluate CVSS scores, EPSS exploit probabilities, "
        "business impact, and prioritize remediation actions."
    ),
    "execution_context": (
        "You are a security architect. Recommend tools and testing approaches "
        "based on the tech stack and deployment context."
    ),
    "audit_evidence": (
        "You are an audit specialist. Generate structured audit findings with "
        "evidence, control gaps, and compliance mapping."
    ),
    "remediation_learning": (
        "You are a security engineer. Provide detailed remediation steps, "
        "root cause analysis, and prevention strategies."
    ),
    "vulnerability_correlation": (
        "You are a threat intelligence analyst specializing in vulnerability "
        "correlation. Given a CVE, identify related vulnerabilities that are "
        "likely to co-exist on the same system or be exploited in the same "
        "attack chain. Use CVE co-occurrence data, CWE families, OWASP "
        "categories, and exploit chain patterns to reason about relationships."
    ),
    "vulnerability_cooccurrence": (
        "You are a threat intelligence analyst. Analyze statistical co-occurrence "
        "patterns between vulnerabilities. Explain which CVEs tend to appear "
        "together in real-world attacks, campaigns, and affected systems. "
        "Distinguish between direct evidence (exploit chains, same campaign) "
        "and inferred relationships (same CWE cluster, same OWASP category)."
    ),
    "general": (
        "You are a multi-layer cybersecurity audit agent. Analyze vulnerabilities, "
        "assess risk, recommend testing approaches, and synthesize findings into "
        "clear, actionable security reports."
    ),
}


# ── Backend 1: Groq ───────────────────────────────────────────────────────────

def _ask_groq(system: str, user: str) -> str | None:
    """Try Groq API. Returns response text or None if unavailable."""
    api_key = os.environ.get("GROQ_API_KEY", "").strip()
    if not api_key:
        return None

    try:
        from groq import Groq
    except ImportError:
        try:
            # Groq uses the same OpenAI-compatible API
            from openai import OpenAI
            client = OpenAI(
                base_url="https://api.groq.com/openai/v1",
                api_key=api_key,
            )
            _use_openai_compat = True
        except ImportError:
            print("  ⚠️  Neither groq nor openai package installed. Run: pip install groq")
            return None
    else:
        client = Groq(api_key=api_key)
        _use_openai_compat = False

    for model in GROQ_MODELS:
        for attempt in range(MAX_RETRIES):
            try:
                resp = client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user",   "content": user},
                    ],
                    max_tokens=1024,
                    temperature=0.3,
                )
                return resp.choices[0].message.content.strip()

            except Exception as e:
                err = str(e)
                if "429" in err or "rate" in err.lower():
                    if attempt < MAX_RETRIES - 1:
                        wait = RETRY_BASE_DELAY * (2 ** attempt)
                        print(f"  ⏳ groq/{model.split('-')[0]} rate-limited, retry in {wait}s...")
                        time.sleep(wait)
                    else:
                        print(f"  ⚠️  groq/{model} exhausted, trying next...")
                        break
                elif "401" in err or "auth" in err.lower():
                    print("  ❌ Groq auth failed — check GROQ_API_KEY")
                    return None
                elif "404" in err or "does not exist" in err.lower():
                    break
                else:
                    print(f"  ⚠️  Groq error: {e}")
                    break

    return None




# ── Backend 2: Ollama Cloud ─────────────────────────────────────────────────

def _ask_ollama(system: str, user: str) -> str | None:
    """Try Ollama Cloud. Returns response text or None."""
    if not OLLAMA_CLOUD_API_KEY:
        return None
    try:
        import requests
        payload = {
            "model": OLLAMA_MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user",   "content": user},
            ],
            "stream": False,
            "options": {"temperature": 0.3, "num_predict": 1024},
        }

        resp = requests.post(
            OLLAMA_CLOUD_CHAT_ENDPOINT,
            json=payload,
            headers={"Authorization": f"Bearer {OLLAMA_CLOUD_API_KEY}"},
            timeout=120,
        )
        resp.raise_for_status()
        cloud_text = resp.json().get("message", {}).get("content", "").strip()
        if cloud_text:
            return cloud_text

    except Exception:
        return None

    return None


def _ask_openrouter(system: str, user: str) -> str | None:
    """Try OpenRouter API. Returns response text or None."""
    if not OPENROUTER_API_KEY:
        return None

    try:
        import requests
        resp = requests.post(
            OPENROUTER_CHAT_ENDPOINT,
            headers={
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "Content-Type": "application/json",
                "HTTP-Referer": OPENROUTER_APP_URL,
                "X-Title": OPENROUTER_APP_NAME,
            },
            json={
                "model": OPENROUTER_MODEL,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "max_tokens": 1024,
                "temperature": 0.3,
            },
            timeout=120,
        )
        resp.raise_for_status()
        return str(resp.json().get("choices", [{}])[0].get("message", {}).get("content", "")).strip() or None
    except Exception:
        return None


# ── Main entry point ──────────────────────────────────────────────────────────

def ask_model(
    instruction: str,
    context:     str = "",
    layer:       str = "general",
) -> str:
    """
    Query available LLM backends with fallback order:
    Groq -> Ollama Cloud -> OpenRouter.

    Args:
        instruction: The task/question for the model.
        context:     Optional input context.
        layer:       Selects the system prompt.
    """
    system = LAYER_CONTEXT.get(layer, LAYER_CONTEXT["general"])
    user   = f"{instruction}\n\n{context}".strip() if context.strip() else instruction

    result = _ask_groq(system, user)
    if result:
        return result

    result = _ask_ollama(system, user)
    if result:
        return result

    result = _ask_openrouter(system, user)
    if result:
        return result

    return (
        "[No LLM backend available]\n"
        "Fallback chain: Groq -> Ollama Cloud -> OpenRouter\n"
        "Required for Groq: GROQ_API_KEY\n"
        f"Required for Ollama Cloud: OLLAMA_API_KEY (endpoint: {OLLAMA_CLOUD_CHAT_ENDPOINT})\n"
        f"Required for OpenRouter: OPENROUTER_API_KEY (endpoint: {OPENROUTER_CHAT_ENDPOINT})\n"
        f"Ollama model: {OLLAMA_MODEL}\n"
        f"OpenRouter model: {OPENROUTER_MODEL}"
    )


