# Internal review notes (not client-facing)

Items that are true in the repo but should not be published as-is, or need a product decision.

Engineering handbook (services, pipelines, schema, env): [docs/internal/](../internal/README.md). This file stays a short list of product landmines; the handbook is the detailed team docs.

## Do not ship this file

`docs/guide/_internal-review.md` is for the team. Do not add it to a public docs site.

## Credit decrement vs token metering

`POST /api/billing/credits/consume` (`consumeCredits`) is implemented and returns 402 on empty ledger. Nothing in Agentic Layer or the AI gateway calls it. Gateway uses `getBalance` to **gate platform models**, and `recordUsage` / `estimateCost` for tokens and USD.

Client docs therefore say: credits gate plan/models; Usage/Costs show tokens/USD. If product intent is “1 credit per scan”, that is **not wired** yet.

## Margin figures

`Connector/src/lib/ai-platform/metering.ts`:

- Platform: customer charge = provider list × **1.12** (12% margin).
- BYOK: `providerCostUsd = 0`, `platformCostUsd` = list × **0.05**.

**Omitted from client `billing.md` / `security-and-data.md` on purpose.** Those pages say “platform surcharge” and point at **Costs**. Confirm if you want the 12% / 5% numbers public.

## Pricing dollars

Landing `FALLBACK_PLANS` and `credits.ts`: Free $0 / 5 credits; Starter $20 or $192/year / 20 credits; Pro $50 or $480/year / 50 credits; packs $12/$32/$70. Already on the marketing page. Credit-pack `paidTiersOnly` excludes Free.

## Unfinished UI

- **Code Reviewer**: `/dashboard/code-reviewer` coming-soon shell (nav tag **Soon**); no agent yet.
- **Organizations**: same.
- **DAST**: configured in Security Agent with an authorized public URL.
- Documentation **in-app** (`/dashboard/documentation`) renders `docs/guide` via `npm run docs:embed`. Client pages must not include host paths, Docker, DB tables, service keys, or internal architecture. Re-run the embed script after Markdown edits.

## Execution privilege

Agentic Layer mounts Docker socket. **Not in client docs.** Full detail stays in `docs/technical-architecture.md`.

## Remediation Groq path

`GROQ_API_KEY` enables a lean/cheap remediator path. Do not advertise “we always use Groq” — it is an env fallback.

## Vendor fallback

OpenRouter is a platform fallback adapter (`docs/ai-platform.md`). Routing can chain up to 4 models when fallback is enabled. Client **Policies** copy mentions fallback without the ranked vendor order or OpenRouter by name.

## Auto top-up units

Profile auto top-up stores `thresholdUsd` / `addUsd` and the UI says “when your balance falls below $N”. That is USD, not a credit count. Confirm product intent before changing the Profile copy.

## Direct founder inbox

`adityajayashankar@deplai.tech` is on Settings Contact info and the footer. Keep or drop in public docs as you prefer; glossary points at Settings rather than repeating the personal address.
