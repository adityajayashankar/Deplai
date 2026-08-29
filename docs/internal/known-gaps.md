# Known gaps and landmines

Team-only. Overlaps `docs/guide/_internal-review.md`. Do not publish.

## Product placeholders

- **Code Reviewer**: `/dashboard/code-reviewer` is a coming-soon shell (nav tag **Soon**). No agent yet. `workspace_sessions.service` still allows `code_reviewer`.
- **Organizations**: same, `/dashboard/organization`.
- **DAST**: available from Security Agent pipeline config and `/dashboard/dast`. Requires an authorized public URL (`dast_target_url`). Internal addresses are rejected.
- Full Scan **UI** still starts as SAST + SCA + Full Scan in the home scan dialog. Security Agent pipeline config can select extra modules and an optional DAST URL. `scan_type=all` runs those extra modules when files (or a DAST URL) exist.

## Billing vs LLM

- `POST /api/billing/credits/consume` is implemented. **Gateway and Agentic never call it.** Platform chat uses `getBalance` for plan gating; spend is `ai_usage` / `ai_costs`. Until `BILLING_ENFORCEMENT=true`, consume is a no-op and balances report open access.
- Metering margins (not for client docs): platform **×1.12**, BYOK surcharge **5%** of list, `providerCostUsd=0` on BYOK.
- Auto top-up stores **USD**, not credit counts.
- Stripe routes/schema leftover. Live path is Razorpay + GST.

## Execution privilege

Agentic mounts **`/var/run/docker.sock`**. Treat the host as a trusted execution environment. Production must keep Agentic HTTP off the public internet (Caddy forwards only `/agentic/ws/*`; Connector uses the Docker network + `X-API-Key`). Local `compose.yaml` runs Agentic as uid 0 for Desktop socket access.

## LLM fallbacks

- `GROQ_API_KEY` enables a cheap remediator path. Not the advertised default.
- OpenRouter is a platform fallback adapter; routing may chain up to 4 models.
- Gateway down → remediation/customization legacy provider paths.

## Durability

- Agentic scan/remediate/pipeline context is **in-process**. Restart drops live sockets.
- Terraform `iac_pipeline._RUNS` is an in-memory dict. Comment in code: replace with Redis for multi-worker.
- Scan reports and clones survive on Docker volumes; session **rows** survive in MySQL.

## Local ports

`.env.template` HTTP 8001 vs WS 8000 vs `compose.yaml` publishing 8000. Production WS must include the `/agentic` prefix (`wss://<APP_DOMAIN>/agentic`). See [Local development](local-development.md).

## Unused / stale

- Neo4j and Qdrant in older `docs/technical-architecture.md` — not used by app code (MySQL only).
- Scratch UI kits in the repo are not the product.
- Auth kit email/password pages exist; **GitHub OAuth is the live identity path**.
- Founder inbox `adityajayashankar@deplai.tech` on Settings contact / footer.

## Docs hygiene

- Customer copy: `docs/guide/` only, then `cd Connector && npm run docs:embed`.
- Never add `_internal-review.md` or this folder to `GUIDE_PAGES` / dashboard Documentation.

Related: [docs/guide/_internal-review.md](../guide/_internal-review.md)
