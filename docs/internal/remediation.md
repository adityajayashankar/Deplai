# Remediation pipeline

Two cooperating layers:

1. **`remediation_pipeline/`** — ingest findings → group → extract snippets → generate diffs → validate.
2. **Agentic `claude_remediator.py` + `agent/remediation_supervisor.py`** — LLM backends, WebSocket `/ws/remediate/{project_id}`, PR hand-off.

Connector never writes GitHub from the browser. After **Review**, Connector uses `getInstallationTokenForRemediation` (`contents: write`, `pull_requests: write`) or a one-shot PAT from Agent setup (not stored in the BYOK vault).

## Orchestrator (`remediation_pipeline/orchestrator.py`)

`RemediationOrchestrator.run(project_id, …)`:

1. `VulnIngester` reads scan artifacts for `project_id` (codebase volume).
2. `GrouperPrioritizer` groups findings (SAST by CWE/file, SCA by package).
3. Selection snapshot + `remediation_scope` (`all` or a subset).
4. `SnippetExtractor` pulls surrounding source (`REMEDIATION_SAST_CONTEXT_LINES`, SCA lines, import context).
5. `LLMRouter` + `FixGenerator` propose patches (`REMEDIATION_MAX_PATCH_FILES`, `REMEDIATION_MAX_CONTEXT_FILES`).
6. `DiffValidator` rejects unsafe/invalid diffs.

Deterministic SCA bumps are limited to `package.json`, `requirements.txt`, `go.mod`. Lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `go.sum`, `poetry.lock`, …) are **not** rewritten by that path.

## LLM backends (`claude_remediator.py`)

Order of intent (env `REMEDIATION_LLM_BACKEND=auto` by default):

1. Connector AI gateway (`ai_gateway.py` / `DeplaiAI`) with `user_id` + `access_mode` — preferred.
2. Anthropic / Claude if keys present.
3. Groq if `GROQ_API_KEY` is set (lean/cheap path — **do not advertise as the default product**).
4. OpenRouter / Ollama-compatible fallbacks.

Caps: `DEPLAI_MAX_REMEDIATION_COST_USD` (default 1.0), `REMEDIATION_LLM_TIMEOUT_SECONDS` (120), `REMEDIATION_MAX_COMPLETION_TOKENS` (2048).

## Agentic HTTP / WS

| Path | Role |
| --- | --- |
| `POST /api/remediate/validate` | Preconditions (scan results exist, project_id allowlist) |
| `WS /ws/remediate/{project_id}` | Live run; HMAC token from Connector |
| `POST /remediation/run` | Kick orchestrator |
| `POST /remediation/status` | Poll |
| `POST /remediation/pr` | Open PR after Review |
| `POST /remediation/refresh`, `/navigate` | UI sync |

Review gate in the product is **`approve_push`**: diffs exist in the volume; GitHub write waits for the user on stage **Review**.

## Connector façade

- `POST /api/remediate/start` — ownership, clone, Agentic validate, session row
- Security analysis page stage rail: Agent setup → Remediation → Review → GitHub & verify
- Agent setup: plan-gated platform model (`best_coding` on paid, `best_fast` on free) or BYOK

Related: [Security pipeline](security-pipeline.md) · [AI platform](ai-platform.md) · [Known gaps](known-gaps.md)
