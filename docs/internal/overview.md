# Overview

DeplAI is a multi-service workspace. The browser never talks to Docker, Terraform, or AWS directly. The **Connector** (Next.js) owns identity and ownership. The **Agentic Layer** (FastAPI) owns long-running scans, remediation, planning, Terraform, and AWS. The **Terraform Agent** is a Python package mounted into Agentic. The **Customization Agent** is a separate FastAPI app proxied through Connector.

## Repository layout

| Path | Role |
| --- | --- |
| `Connector/` | Next.js 16 App Router control plane: dashboard, APIs, GitHub, MySQL, AI gateway, billing |
| `Agentic Layer/` | FastAPI execution plane (`main:app`) |
| `Terraform Agent/agent/` | Imported as `terraform_agent`: renderers, registry, state, locks, apply helpers |
| `Customization Agent/tenant_builder_app/backend/` | LangGraph frontend customization engine (port 8010) |
| `remediation_pipeline/` | Finding grouping, patch generation, validation, track runner |
| `Diagram-Cost-Agent/` | Cost/diagram helpers used by Stage 7 / planning |
| `uiux-agent/` | Optional AgentOS UI/UX refactor service (`UIUX_AGENT_BASE_URL`) |
| `Connector/database.sql` | Canonical schema loaded by Compose MySQL |
| `Connector/migrations/` | Incremental SQL applied on existing databases |
| `.env.template` | Shared env names. Never commit a populated `.env` |
| `docs/guide/` | Client docs (dashboard) |
| `docs/internal/` | This handbook |

Scratch / reference UI kits in the repo (`auth-flows-ui-kit/`, `optimus-the-ai-platform-to-build-and-ship/`, etc.) are **not** part of the running product.

## Runtime topology (local)

From `compose.yaml` (`docker compose up --build` at repo root):

```text
Browser
  │ HTTPS / WS
  ▼
Connector :3000
  ├── iron-session cookie `deplai_session`
  ├── MySQL :3306 (users, GitHub, billing, AI vault, sessions)
  ├── X-API-Key → Agentic Layer (Compose: :8000; `docker-compose.dev.yml`: host :8001 → container :8000)
  └── session proxy → Customization :8010
          │
          ▼
Agentic Layer
  ├── Docker socket → Bearer, Syft, Grype, Gitleaks, Checkov, Terraform 1.9
  ├── read-only mounts: /repos (GitHub clones), /local-projects (ZIPs)
  └── terraform_agent package + remediation_pipeline
          │
          └── AWS (plan/apply/runtime) using credentials supplied per run
```

Production (`docker-compose.production.yml`): only **Caddy** publishes 80/443. Connector, Agentic, customization, and MySQL stay on the Docker network. Caddy forwards authenticated browser WebSockets at `/agentic/ws/*` only. Connector calls Agentic HTTP on the Docker network with `X-API-Key`.

## Trust boundaries

| Boundary | Mechanism |
| --- | --- |
| Browser → Connector | Encrypted `deplai_session` (iron-session). Protected routes `requireAuth`. Project/repo/installation ownership checks. |
| Connector → Agentic | `X-API-Key: DEPLAI_SERVICE_KEY`. Browser must never see this key. |
| Live scan/remediation/pipeline sockets | Short-lived HMAC token minted by Connector, bound to user + project. Agentic rejects mismatch/expiry. Production browsers use same-origin `wss://<APP_DOMAIN>/agentic/ws/…`; Caddy strips `/agentic` before proxying to FastAPI `/ws/…`. |
| Connector → AI gateway (from Agentic/customization) | Same service key plus `x-deplai-user-id` so BYOK/platform resolution is per user. |
| Connector → Customization | Authenticated proxy; source path resolved from ownership-checked DB rows, not client-supplied paths. |
| Agentic → Docker | Host `/var/run/docker.sock`. Treat the Agentic host as a **trusted execution environment**. Do not expose Agentic publicly without Caddy/network lock-down. |
| Remediation → GitHub | Installation token scoped `contents: write`, `pull_requests: write` via `getInstallationTokenForRemediation`. Optional one-shot PAT from Agent setup (not vaulted). |
| Terraform apply | Requires `confirm_plan_summary: true`. Otherwise status `awaiting_plan_confirmation`. |

## In-memory vs durable

Scan/remediation/pipeline **run context** lives in Agentic process memory. A restart drops live WebSocket subscribers. Durable pieces:

- GitHub clones / ZIP extracts on Connector volumes
- Scan report files on Docker volumes (`security_reports`, `codebase_deplai`)
- `workspace_sessions` + logs in MySQL
- Billing, BYOK, profile in MySQL
- Terraform artifacts in `iac_workspaces` / optional S3

## Product surfaces vs implementation names

| UI (workspace nav) | Implementation |
| --- | --- |
| Security Agent | Connector `/dashboard/security-analysis/[projectId]` + Agentic `/api/scan/*`, `/ws/scan`, `/ws/remediate` |
| Deploy | `/dashboard/deploy` + Agentic terraform/AWS routes |
| UI/UX customizer | `/dashboard/customization` + customization backend |
| Code Reviewer | `/dashboard/code-reviewer` coming-soon shell (nav tag **Soon**). Session service `code_reviewer` reserved |
| Sessions | `workspace_sessions` |
| BYOK | `/dashboard/ai/*` — AI platform control plane |
| Organizations | Nav placeholder |

Related: [Runtime and trust](runtime-and-trust.md) · [Connector](connector.md) · [Agentic Layer](agentic-layer.md) · [Known gaps](known-gaps.md)
