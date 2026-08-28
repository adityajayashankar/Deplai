# Environment variables

Source of names: repo-root `.env.template`. Copy to `.env`. **Never commit populated files.** Production uses `deploy/.env` with `docker-compose.production.yml`.

This page lists **names and purpose**, not values.

## Required for a real login + scan

| Name | Used by | Purpose |
| --- | --- | --- |
| `DEPLAI_SERVICE_KEY` | Connector + Agentic + customization | Shared service key. Browser must never see it |
| `WS_TOKEN_SECRET` | Connector mint, Agentic verify | HMAC for live scan/remediate/pipeline sockets |
| `SESSION_SECRET` | Connector | iron-session; also BYOK encryption fallback |
| `NEXT_PUBLIC_APP_URL` | Connector | OAuth callback origin |
| `AGENTIC_LAYER_URL` | Connector server | HTTP to Agentic (template default `http://localhost:8001`) |
| `NEXT_PUBLIC_AGENTIC_WS_URL` | Browser | WS origin (template default `ws://localhost:8000` — **can disagree** with HTTP; see [Local development](local-development.md)) |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Connector | OAuth |
| `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` / `GITHUB_WEBHOOK_SECRET` | Connector | App JWT, webhooks |
| `DB_HOST` `DB_PORT` `DB_USER` `DB_PASSWORD` `DB_NAME` | Connector | MySQL |

Compose local hard-codes dummy GitHub + `local-only-*-change-before-production` secrets so the UI boots. Replace them to sign in.

## Admin / cleanup

`ADMIN_EMAILS`, `ADMIN_EMAIL`, `ADMIN_ACCESS_KEY`, `ALLOW_GLOBAL_CLEANUP`, `CLEANUP_SCAN_VOLUMES_ON_LOGOUT`, `CORS_ORIGINS`.

Optional path overrides: `DEPLAI_LOCAL_PROJECTS_ROOT`, `DEPLAI_GITHUB_REPOS_ROOT`, `HOST_PROJECTS_DIR`.

## AI platform / LLM

`AI_PLATFORM_ENABLED`, `AI_BYOK_ENABLED`, `AI_MODEL_SYNC_ENABLED`, `AI_ROUTING_ENABLED`, `AI_FALLBACK_ENABLED`, `AI_PLAYGROUND_ENABLED`, `AI_DEFAULT_ACCESS_MODE`, `AI_DEFAULT_ROUTING_POLICY`, `AI_ENABLE_CROSS_PROVIDER_FALLBACK`, `AI_CREDENTIAL_ENCRYPTION_KEY`, `DEPLAI_AI_GATEWAY_URL`.

Provider keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY`, `XAI_API_KEY`, `MINIMAX_API_KEY`, `KIMI_API_KEY` / `MOONSHOT_API_KEY`, `GLM_API_KEY` / `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_*`.

Per-provider `AI_PROVIDER_*_ENABLED` flags.

Claude pipeline caps: `CLAUDE_MODEL`, `CLAUDE_REPO_ANALYZER_MODEL`, `CLAUDE_REVIEW_QUESTION_MODEL`, `CLAUDE_INFRA_PLANNER_MODEL`, `DEPLAI_CLAUDE_MAX_PIPELINE_COST_USD`, `DEPLAI_CLAUDE_MAX_TERRAFORM_GEN_COST_USD`.

`GROQ_API_KEY` also enables the lean remediator path in Agentic — ops-only, not a marketing claim.

## Billing

Razorpay: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `NEXT_PUBLIC_RAZORPAY_KEY_ID`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_USD_TO_INR`.

GST seller: `BILLING_LEGAL_NAME`, `BILLING_GSTIN`, `BILLING_ADDRESS`, `BILLING_STATE_NAME`, `BILLING_STATE_CODE`, `BILLING_SAC_CODE`, `BILLING_INVOICE_PREFIX`, `BILLING_GST_RATE`.

`BILLING_ENFORCEMENT` / `NEXT_PUBLIC_BILLING_ENFORCEMENT` default **false**: plan and credit gates are off until Razorpay is live. Rebuild the Connector image after changing the `NEXT_PUBLIC_` value.

Stripe keys in the template are commented unused.

## Customization / scanners / IaC

`CUSTOMIZATION_AGENT_BASE_URL`, `CUSTOMIZATION_BACKEND_URL`, `UIUX_AGENT_BASE_URL`, `UIUX_AGENT_WORKFLOW_ID` (not `NEXT_PUBLIC`).

`CONTAINER_OP_TIMEOUT`, `SCANNER_TIMEOUT_SECONDS`, `GRYPE_TIMEOUT_SECONDS`.

`DAST_ALLOW_HTTP` defaults **false**. Production compose sets it false; enable only for local HTTP targets.

Remediation knobs: `REMEDIATION_*`, `DEPLAI_MAX_REMEDIATION_COST_USD`.

IaC: `IAC_MAX_VALIDATION_RETRIES`, `IAC_WORKSPACE_ROOT`, `IAC_WORKSPACE_TTL_HOURS`, `IAC_TERRAFORM_PARALLELISM`.

AWS: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (host helpers / cost). Apply still prefers per-request keys from Deploy. `DEPLAI_FREE_TIER_EC2_TYPES`, `DEPLAI_ALLOW_EC2_DISABLE_FALLBACK`, `DEPLAI_EC2_INSTANCE_TYPE`.

GitHub App public: `NEXT_PUBLIC_GITHUB_APP_SLUG`, `NEXT_PUBLIC_GITHUB_APP_INSTALL_URL`.

Related: [Local development](local-development.md) · [Known gaps](known-gaps.md)
