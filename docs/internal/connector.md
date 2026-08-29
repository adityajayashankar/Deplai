# Connector

Path: `Connector/`. Next.js 16 App Router, React 19, TypeScript, Tailwind. This is the only browser-facing backend.

## Responsibilities

- Landing (`/`) and authenticated dashboard (`/dashboard/*`, `/profile`)
- GitHub OAuth + GitHub App (installations, clone, webhooks, PRs)
- Local ZIP projects
- Ownership checks before any source or pipeline action
- Façade to Agentic (`AGENTIC_LAYER_URL`, `agenticHeaders()`)
- AI platform gateway (`/api/ai/*`)
- Razorpay billing
- Workspace sessions
- Customization proxy (`/api/customization/*`)
- Client documentation embed (`/dashboard/documentation`)

## Auth

| Piece | Detail |
| --- | --- |
| Cookie | `deplai_session`, HttpOnly, SameSite=Lax, 7 days, Secure in production (`Connector/src/lib/session.ts`) |
| Secret | `SESSION_SECRET` required in production; local has a dev fallback |
| OAuth | `GET /api/auth/login` scopes `user:email read:user read:org`, `prompt=select_account` |
| Logout | `POST /api/auth/logout`; optional Agentic cleanup if `CLEANUP_SCAN_VOLUMES_ON_LOGOUT=true` |
| Admin | `ADMIN_EMAILS` / `ADMIN_EMAIL`; `requireAdmin()` for workspace-destroy and similar |
| Service key | `requireServiceKey()` accepts `x-deplai-service-key`, `x-api-key`, or `Authorization: Bearer`. Used by `/api/ai` internal calls, `POST /api/billing/credits/consume`, `POST /api/billing/credits/expire` |

## Dashboard routes (App Router)

| Path | App |
| --- | --- |
| `/dashboard` | Home / projects |
| `/dashboard/security-analysis/[projectId]` | Security Agent |
| `/dashboard/deploy` | Deploy |
| `/dashboard/customization` | UI/UX customizer |
| `/dashboard/sessions`, `/dashboard/sessions/[id]` | Sessions |
| `/dashboard/ai/[[...section]]` | BYOK control plane |
| `/dashboard/byok` | Redirects to credentials |
| `/dashboard/subscription`, `/credits`, `/invoices` | Billing |
| `/dashboard/integrations` | GitHub App |
| `/dashboard/settings` | Settings (via DashboardHomeApp tab) |
| `/dashboard/usage` | Year wrap (`UsageWrappedApp`) |
| `/dashboard/documentation/[[...section]]` | Client guide |
| `/dashboard/instances` | Runtime manage |
| `/dashboard/dast` | DAST target configuration |
| `/dashboard/cloud` | Cloud workspace chrome |
| `/dashboard/code-reviewer` | Coming-soon shell (`CodeReviewerComingSoonApp`; nav tag **Soon**) |
| `/dashboard/projects` | Project list |
| `/dashboard/codeview` | Code view helper |
| `/dashboard/pipeline` | Legacy pipeline chrome (workspace frame hidden) |
| `/profile` | Canonical profile (`/dashboard/profile` redirects here) |

Nav is `Connector/src/features/workspace/WorkspaceNav.tsx`. Visual language: neo-brutalist paper (`app-paper`, 3px black borders). Billing is Razorpay + GST, not Stripe (Stripe routes exist unused).

## How Connector calls Agentic

1. `requireAuth` + ownership (`verifyProjectOwnership` / `verifyRepositoryOwnership`)
2. Clone or resolve local path
3. `fetch(AGENTIC_URL + path, { headers: agenticHeaders() })` with `DEPLAI_SERVICE_KEY`
4. For live sockets (scan, remediate, pipeline):
   - `GET /api/scan/ws-token?project_id=…` mints a short-lived HMAC token (`WS_TOKEN_SECRET`, 5 min TTL)
   - Browser resolves a WebSocket **base** via `resolveBrowserAgenticWsBase()` in `src/lib/agentic-websocket.ts`
   - Production (public hostname): same-origin `wss://<APP_DOMAIN>/agentic` — never trust a container-internal origin from `/api/pipeline/ws-config`
   - Local (no Caddy): direct Agentic port, e.g. `ws://localhost:8000` → `ws://localhost:8000/ws/scan/{project_id}?token=…`
   - Production path through Caddy: `wss://<APP_DOMAIN>/agentic/ws/scan/{project_id}?token=…` (Caddy strips `/agentic` before proxying to FastAPI `/ws/scan/{project_id}`)
   - Fallback: `GET /api/pipeline/ws-config` returns `{ ws_base }` when mixed-content or host-mismatch blocks the env default
   - Ops diagnostic: `GET /api/scan/ws-health` probes the Docker-network upgrade and echoes the resolved public URL

Do not call Agentic from client components with the service key.

## GitHub

- Listing/clone: installation token (read)
- Remediation PR: `githubService.getInstallationTokenForRemediation(installationId)` with `contents: write`, `pull_requests: write`
- Clones: `Connector/tmp/repos/<owner>/<repo>` (volume `github_repos` in Compose)
- ZIP: `Connector/tmp/local-projects/<user-id>/<project-id>`

## Key libraries

| Area | Code |
| --- | --- |
| Session | `src/lib/session.ts`, `src/lib/auth.ts` |
| GitHub | `src/lib/github.ts` |
| Agentic client | `src/lib/agentic.ts` |
| Agentic WebSocket URLs | `src/lib/agentic-websocket.ts` (`buildAgenticWebSocketUrl`, `resolveBrowserAgenticWsBase`) |
| AI gateway | `src/lib/ai-platform/` |
| Credits | `src/lib/billing/credits.ts`, `credits-policy.ts` |
| Sessions | `src/lib/sessions/` |
| Docs embed | `src/features/docs/`, `scripts/embed-guide-docs.cjs` |

Related: [API reference](../api-reference.md) · [Data model](data-model.md)
