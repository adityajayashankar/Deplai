# DeplAI Runbook

Operational guide for startup, pipeline execution, and troubleshooting.

## 1. Services and Startup

`docker-compose.yml` currently runs only:

- `agentic-layer` on port `8000`

`Connector` runs separately (`npm run dev` / `next start`).

## Startup Sequence

1. Start MySQL.
2. Start Docker Desktop.
3. Start Agentic Layer:
   ```bash
   docker compose up -d --build agentic-layer
   ```
4. Start Connector:
   ```bash
   cd Connector
   npm install
   npm run dev
   ```
5. Open `http://localhost:3000`.

## 2. Required Configuration

Set these in repo-root `.env`.

## Core

- `AGENTIC_LAYER_URL` (Connector -> Agentic base URL)
- `DEPLAI_SERVICE_KEY` (REST auth between Connector and Agentic)
- `WS_TOKEN_SECRET` (WebSocket token signing/verification)
- `NEXT_PUBLIC_AGENTIC_WS_URL` (optional explicit WS base; otherwise resolved from `AGENTIC_LAYER_URL`)
- `SESSION_SECRET` (Connector session encryption)
- `CORS_ORIGINS` (Agentic CORS allowlist)

## Database

- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`

## GitHub OAuth / App

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`

## Common Optional Runtime Keys

- `GROQ_API_KEY`
- `OPENROUTER_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `NEO4J_URI`
- `NEO4J_USER`
- `NEO4J_PASSWORD`

## 3. Pipeline Stages (Current)

UI stage order:

1. `0` preflight
2. `1` scan
3. `2` KG
4. `3` remediation
5. `4` PR
6. `4.5` merge gate
7. `4.6` post-merge actions
8. `6` QA
9. `7` architecture + cost
10. `7.5` approval gate
11. `8` IaC generation
12. `9` GitOps/policy gate
13. `10` deploy

Backend remediation is hard-capped at 2 cycles.

## 4. Operational Checks

## Backend health

```bash
curl http://localhost:8000/health
```

Expected fields:

- `docker_engine` check
- `neo4j` check

## Connector pipeline health

```bash
curl http://localhost:3000/api/pipeline/health
```

Requires authenticated session.

## 5. Stage Operations

## Stage 1: Scan

- Validate via `POST /api/scan/validate`.
- Stream via `WS /ws/scan/{project_id}`.
- Poll via `GET /api/scan/status?project_id=...`.
- Read results via `GET /api/scan/results?project_id=...`.

Scanner outputs land in `security_reports` volume.

## Stage 3: Remediation

- Start via `POST /api/remediate/start`.
- Stream via `WS /ws/remediate/{project_id}`.
- Human approval required: send `{"action":"approve_rescan"}` to remediation WS.

Persistence behavior:

- GitHub project: push branch + open PR.
- Local project: copy back to `Connector/tmp/local-projects/...`.

## Stage 7 and 7.5: Architecture/Cost/Approval

- Architecture route (`/api/architecture`) uses deterministic AWS template path in current UI flow.
- Stage7 route (`/api/pipeline/stage7`) proxies to backend subprocess agent.
- Stage7 payload includes diagram, cost estimate, budget gate.

## Stage 8: IaC

- Endpoint: `POST /api/pipeline/iac`.
- Hard gate: requires valid scan state.
- Behavior:
  - try backend terraform generator first,
  - fallback to template bundle if needed.

## Stage 9: Policy

- Budget and security gates are checked in UI.
- Deploy API also enforces budget guardrail server-side.

## Stage 10: Deploy

- Runtime apply path:
  - `POST /api/pipeline/deploy` with `runtime_apply=true`.
  - AWS only.
- Recovery/control paths:
  - `POST /api/pipeline/deploy/status`
  - `POST /api/pipeline/deploy/stop`
  - `POST /api/pipeline/deploy/destroy`
  - `POST /api/pipeline/runtime-details`

## 6. Docker Volumes

- `codebase_deplai`
- `security_reports`
- `LLM_Output`
- `grype_db_cache`

List:

```bash
docker volume ls
```

Inspect scan reports:

```bash
docker run --rm -v security_reports:/vol alpine sh -c "ls -lah /vol"
```

## 7. Troubleshooting

## Scan never leaves `not_initiated`

1. Verify Docker:
   ```bash
   docker info
   ```
2. Verify backend:
   ```bash
   curl http://localhost:8000/health
   ```
3. Verify shared key (`DEPLAI_SERVICE_KEY`) matches in both services.
4. Check logs:
   ```bash
   docker compose logs -f agentic-layer
   ```

## WebSocket closes with 1008

Likely token validation issue:

- `WS_TOKEN_SECRET` mismatch
- expired token
- project/user mismatch

Check:

- Connector `/api/scan/ws-token` response
- backend log around `_verify_ws_token`

## Remediation completed but no PR

Possible reasons:

- no safe file changes were produced,
- repository metadata/token issue,
- GitHub push failed.

Use:

- `POST /api/pipeline/remediation-pr` to resolve latest remediation PR
- backend logs for push and PR creation errors.

## IaC generation blocked

`/api/pipeline/iac` rejects when scan is:

- `running`
- `not_initiated`
- `error`

Run/complete scan first.

## Deploy blocked by budget

`/api/pipeline/deploy` returns block when:

- `estimated_monthly_usd > budget_limit_usd`
- and `budget_override != true`

## Runtime deploy fails quickly with stale bundle error

Stage 10 runtime deploy validates safety fields in Terraform bundle.
Re-run Stage 8 IaC generation, then retry deploy.

## 8. Dangerous Operations

Global backend cleanup endpoint:

- `POST /api/cleanup`

Only works when backend env has:

- `ALLOW_GLOBAL_CLEANUP=true`

This is destructive for all projects.
