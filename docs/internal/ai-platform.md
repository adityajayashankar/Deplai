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
- Default remediation: paid → `platform` / `best_coding`; free with BYOK → `byok`; else `platform` / `best_fast`.

## Routing and fallback

`AI_ROUTING_ENABLED`, `AI_FALLBACK_ENABLED`, `AI_ENABLE_CROSS_PROVIDER_FALLBACK`. Ranked chain up to **4** models. OpenRouter is a **platform fallback adapter**, not a first-class product provider in the UI.

Organization policy (`ai_organization_policies`): `byokRequired`, `platformCredentialsAllowed`, allowed credential modes.

## Metering (do not put in client docs)

`Connector/src/lib/ai-platform/metering.ts`:

- Platform: `customerChargeUsd = provider list × 1.12` (12% margin). `providerCostUsd` = list.
- BYOK: `providerCostUsd = 0`, `platformCostUsd` = list × **0.05**, `customerChargeUsd` same.

Written to `ai_usage` + `ai_costs`. Failures in `recordUsage` are swallowed so metering cannot fail the user request.

**Credits are not decremented here.** Gateway only uses `getBalance` to know `planId` and to refuse empty/blocked platform use. `POST /api/billing/credits/consume` exists and is unused by Agentic and the gateway. See [Known gaps](known-gaps.md).

## Encryption

BYOK secrets: `AI_CREDENTIAL_ENCRYPTION_KEY`, fallback `SESSION_SECRET`. API never returns raw secrets after save (`secretMasked`).

## Callers

| Caller | Client |
| --- | --- |
| Browser | Session cookie → `/api/ai/*` |
| Agentic | `Agentic Layer/ai_gateway.py` (`DeplaiAI`) |
| Customization | `services/ai_gateway.py` |

Internal HTTP: `DEPLAI_SERVICE_KEY` via `x-api-key` / `x-deplai-service-key` / Bearer, plus **`x-deplai-user-id`** so routing/BYOK is per user.

Feature flags: `AI_PLATFORM_ENABLED`, `AI_BYOK_ENABLED`, `AI_MODEL_SYNC_ENABLED`, `AI_PLAYGROUND_ENABLED`.

Related: [Billing](billing.md) · [Environment](environment.md)
