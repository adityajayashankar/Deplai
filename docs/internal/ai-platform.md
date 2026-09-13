# AI platform (internal)

Control plane lives in Connector (`Connector/src/lib/ai-platform/`). Product UIs and Agentic/customization all chat through `POST /api/ai/chat`. Longer narrative: [docs/ai-platform.md](../ai-platform.md).

## Access modes

`platform` | `byok` | `auto` (`AI_DEFAULT_ACCESS_MODE`, default `auto`).

| Mode | Credential | Gate |
| --- | --- | --- |
| `platform` | Env keys on Connector (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY`, …) | `getBalance` → `assertPlatformModelAllowed(planId, model)`. Policy `byokRequired` **rejects** this mode |
| `byok` | `ai_provider_credentials.secret_encrypted` | Vaulted key for that provider; `providerCostUsd = 0` |
| `auto` | Prefer BYOK if present, else platform (see `credentials.ts`) | Same plan rules when the resolved source is platform |

Ephemeral playground keys: `ephemeralApiKey` treated as BYOK for that request; not persisted.

## Plan vs models (`subscription-access.ts`)

- Free platform aliases: `best_fast`, `best_cost` only.
- Paid (`starter_*`, `pro_*`, `enterprise*`): all `LOGICAL_ALIASES` plus catalog vendor models.
- **Security remediation is an explicit exception to normal access-mode routing.** It always uses Connector's platform-owned OpenRouter route and an eligible zero-priced `:free` coding model. The request rejects BYOK, `auto`, paid-model selection, direct provider adapters, and legacy fallback routes. This policy is independent of subscription access and general AI routing.

## Routing and fallback

`AI_ROUTING_ENABLED`, `AI_FALLBACK_ENABLED`, `AI_ENABLE_CROSS_PROVIDER_FALLBACK`. General AI requests can use a ranked chain of up to **4** models. OpenRouter is a platform fallback adapter for the general gateway, not a first-class product provider in the UI.

Security remediation does **not** inherit that chain: Connector owns its OpenRouter-only free-model selection, request budget, cooldowns, and failure normalization. A stale saved model may be replaced by an eligible free routing candidate; it is never replaced by a paid or BYOK provider.

Organization policy (`ai_organization_policies`): `byokRequired`, `platformCredentialsAllowed`, allowed credential modes.

Security cooldowns honor valid provider `Retry-After` and `X-RateLimit-Reset` timestamps (using the longer wait when both are present). A provider limit without a usable hint receives a 15-second local backoff, not an assumed one-hour account outage. Local reservation rejections never renew cooldowns. Persisted cooldowns record `provider_hint` or `local_backoff`; API errors distinguish provider responses, local RPM throttles, and replay of stored cooldowns. Older cooldowns without provenance remain `legacy_unknown` until they expire; they are not silently cleared. The free router still owns model selection, and actual provider limits remain enforced.

## Metering (do not put in client docs)

`Connector/src/lib/ai-platform/metering.ts`:

- Platform: `customerChargeUsd = provider list × 1.12` (12% margin). `providerCostUsd` = list.
- BYOK: `providerCostUsd = 0`, `platformCostUsd` = list × **0.05**, `customerChargeUsd` same.

Written to `ai_usage` + `ai_costs`. Failures in `recordUsage` are swallowed so metering cannot fail the user request.

Gateway model metering does not apply product outcome rates itself. Terminal scan, remediation, DAST, verified deployment, and verified UI/UX workflows call the Connector product-usage ledger with service authentication and idempotency keys. Gateway `ai_usage` / `ai_costs` remains the source for actual model token and USD usage.

## Encryption

BYOK secrets: `AI_CREDENTIAL_ENCRYPTION_KEY`, fallback `SESSION_SECRET`. API never returns raw secrets after save (`secretMasked`).

## Callers

| Caller | Client |
| --- | --- |
| Browser | Session cookie → `/api/ai/*` |
| Agentic | `Agentic Layer/ai_gateway.py` (`DeplaiAI`) |
| UI/UX worker | `uiux-agent/service/deep_agent_app.py` via `UIUX_CONNECTOR_URL` |
| Customization | `services/ai_gateway.py` |

Internal HTTP: `DEPLAI_SERVICE_KEY` via `x-api-key` / `x-deplai-service-key` / Bearer, plus **`x-deplai-user-id`** so routing/BYOK is per user.

Feature flags: `AI_PLATFORM_ENABLED`, `AI_BYOK_ENABLED`, `AI_MODEL_SYNC_ENABLED`, `AI_PLAYGROUND_ENABLED`.

Related: [Billing](billing.md) · [Environment](environment.md)
