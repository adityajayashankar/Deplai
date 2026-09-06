# DeplAI internal documentation

This directory is the **engineering handbook**. It describes how the repository is actually built and how services talk to each other.

It is **not** customer documentation. Do not copy these pages into Dashboard → Documentation (`docs/guide/`). Do not commit real API keys, `.env` values, or production GSTIN.

## Read order

1. [Overview](overview.md) — repo map, runtime topology, trust boundaries
2. [Runtime and trust](runtime-and-trust.md) — Compose files, volumes, production Caddy
3. [Connector](connector.md) — Next.js control plane, routes, auth
4. [Agentic Layer](agentic-layer.md) — FastAPI execution plane
5. [Terraform Agent](terraform-agent.md) — IaC render / plan / apply
6. [Customization](customization.md) — UI/UX customizer backend
7. [Remediation pipeline](remediation.md) — finding → validated diff
8. [Security pipeline](security-pipeline.md) — scan modules and stage rail
9. [Deploy pipeline](deploy-pipeline.md) — analysis → plan confirmation → AWS
10. [AI platform](ai-platform.md) — gateway, BYOK, metering
11. [Billing](billing.md) — Razorpay, credits, invoices
12. [Sessions, profile, settings](sessions-profile-settings.md)
13. [Data model](data-model.md) — MySQL tables
14. [Environment](environment.md) — env vars (names only)
15. [Local development](local-development.md)
16. [Documentation system](documentation.md) — handbook/client-guide boundaries and publishing flow
17. [Known gaps](known-gaps.md) — unfinished wiring and product landmines

Older, still useful narratives (overlap with this handbook; prefer this folder when they disagree):

- [docs/technical-architecture.md](../technical-architecture.md)
- [docs/agent-architecture.md](../agent-architecture.md)
- [docs/architecture.md](../architecture.md)
- [docs/api-reference.md](../api-reference.md)
- [docs/ai-platform.md](../ai-platform.md)

Customer-facing copy: [docs/guide/](../guide/README.md). After editing that guide, run `cd Connector && npm run docs:embed`.
