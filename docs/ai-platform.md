# DeplAI AI platform

The Connector hosts a provider-agnostic AI control plane. Product surfaces request logical models such as `best_reasoning` or `claude-opus-4-6`. The gateway selects provider, credential source, routing policy, fallback, and records usage.

## Providers

OpenAI, Anthropic, MiniMax, xAI/Grok, Gemini, Kimi/Moonshot, GLM/Z.AI, and Groq. OpenRouter remains available as a platform fallback adapter. Groq is both a provider and an inference host; catalog rows keep `model_owner` when the hosted model is owned by another lab.

## API

All routes are session-authenticated except provider health probes. Internal services call the same routes with `X-API-Key: DEPLAI_SERVICE_KEY` and `x-deplai-user-id`.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/ai` | Control-plane overview |
| GET | `/api/ai/providers` | Provider registry |
| GET | `/api/ai/models` | Normalized catalog |
| POST | `/api/ai/models/sync` | Discover/reconcile models |
| POST | `/api/ai/chat` | Normalized chat (aliases + fallback). Set `stream: true` for SSE. |
| GET/POST | `/api/ai/credentials` | Vaulted BYOK |
| POST | `/api/ai/credentials/:id/validate` | Re-validate a stored key |
| GET/POST | `/api/ai/routing-policies` | Routing policies |
| GET/PUT | `/api/ai/policies` | Workspace AI policy |
| GET | `/api/ai/usage` | Token/request metering |
| GET | `/api/ai/costs` | Platform vs BYOK cost split |
| GET | `/api/ai/health` | Provider health |
| GET | `/api/ai/audit` | Credential/routing audit |

Example:

```json
POST /api/ai/chat
{
  "model": "best_reasoning",
  "access_mode": "auto",
  "task": "security_analysis",
  "messages": [{ "role": "user", "content": "..." }]
}
```

Raw secrets are never returned after save. UI values look like `********abcd`.

## UI

Dashboard → **AI Platform** in the workspace sidebar: Overview, Playground, Models, Providers, Credentials, Routing, Policies, Usage, Costs, Health, Audit. Security, deploy, and customization use the same gateway.

## Configuration

Uses the existing env system. Important variables:

- `AI_PLATFORM_ENABLED`
- `AI_CREDENTIAL_ENCRYPTION_KEY` (falls back to `SESSION_SECRET`)
- `AI_DEFAULT_ACCESS_MODE` (`auto` / `platform` / `byok`)
- `DEPLAI_AI_GATEWAY_URL` for Agentic Layer and customization
- Provider keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `MINIMAX_API_KEY`, `KIMI_API_KEY` / `MOONSHOT_API_KEY`, `GLM_API_KEY` / `ZAI_API_KEY`, `OPENROUTER_API_KEY`

## Python SDK

```python
from ai_gateway import DeplaiAI

DeplaiAI().chat(
    user_id=user_id,
    model="best_reasoning",
    task="security_analysis",
    access_mode="organization" if False else "auto",
    prompt="...",
)
```

Remediation and customization call this client first, then fall back to their legacy provider paths if the gateway is unavailable.
