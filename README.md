# DeplAI

DeplAI is an agentic DevSecOps pipeline that takes a local upload or GitHub repo, scans it, remediates vulnerabilities with human approval, then moves through architecture, cost, IaC generation, budget policy, and deployment.

## What Runs Today

- Frontend/BFF: `Connector` (Next.js 16)
- Backend orchestrator: `Agentic Layer` (FastAPI)
- Stage 7 agent: `diagram_cost-estimation_agent` (invoked by FastAPI as a subprocess)
- KG analysis: `KGagent` is imported by `Agentic Layer` during remediation (not a separate HTTP service in this pipeline path)
- Runtime deploy: AWS only (`/api/terraform/apply`)

`docker-compose.yml` currently starts only `agentic-layer`.

## Repository Layout

```text
DeplAI/
|- Connector/                      Next.js app, auth, dashboard, BFF routes
|- Agentic Layer/                  FastAPI scan/remediate/architecture/cost/terraform/runtime APIs
|- diagram_cost-estimation_agent/  Stage 7 diagram+cost+budget agent
|- KGagent/                        LangGraph KG analysis module used during remediation
|- terraform_agent/                Legacy/standalone terraform agent project (not active path)
|- ARCHITECTURE.md
|- RUNBOOK.md
|- FLOW_MIGRATION_NOTES.md
```

## Implemented Pipeline Flow

UI stages in `Connector/src/features/pipeline/data.ts`:

1. Stage 0 `preflight`
2. Stage 1 `scan`
3. Stage 2 `kg`
4. Stage 3 `remediate`
5. Stage 4 `pr`
6. Stage 4.5 `merge`
7. Stage 4.6 `postmerge`
8. Stage 6 `qa`
9. Stage 7 `arch` (diagram + cost generation)
10. Stage 7.5 `approve`
11. Stage 8 `iac`
12. Stage 9 `gitops` (budget + policy gate)
13. Stage 10 `deploy`

Notes:

- Remediation loop is hard-capped at 2 cycles in backend (`MAX_REMEDIATION_CYCLES = 2`).
- WebSocket streams are used for scan/remediation; later stages use HTTP.
- `skipScan` implies `skipRemediation`.
- Autopilot auto-fills QA defaults and auto-advances to architecture.

## Key Behaviors

- AWS architecture generation in `/api/architecture` is deterministic template-driven from QA context.
- Non-AWS architecture generation proxies to backend LLM route.
- `/api/pipeline/iac` hard-gates on scan status (`running`, `not_initiated`, `error` are blocked).
- `/api/pipeline/iac` tries backend terraform generator first, then falls back to built-in templates.
- `/api/pipeline/deploy` enforces budget guardrail before runtime apply or GitOps push.
- Runtime apply (`runtime_apply=true`) is AWS-only and executes Terraform in ephemeral Docker containers.

## Quick Start

## 1) Prerequisites

- Node.js 20+
- Python 3.12+
- Docker Desktop
- MySQL 8+

## 2) Configure `.env` at repo root

Minimum required:

```bash
NEXT_PUBLIC_APP_URL=http://localhost:3000
AGENTIC_LAYER_URL=http://localhost:8000
NEXT_PUBLIC_AGENTIC_WS_URL=ws://localhost:8000
DEPLAI_SERVICE_KEY=<shared-secret>
WS_TOKEN_SECRET=<ws-signing-secret>
SESSION_SECRET=<session-secret>

DB_HOST=localhost
DB_PORT=3306
DB_USER=deplai
DB_PASSWORD=<password>
DB_NAME=deplai

GITHUB_CLIENT_ID=<oauth-client-id>
GITHUB_CLIENT_SECRET=<oauth-client-secret>
GITHUB_APP_ID=<app-id>
GITHUB_PRIVATE_KEY=<pem-with-\n>
GITHUB_WEBHOOK_SECRET=<webhook-secret>
```

Common optional keys:

```bash
GROQ_API_KEY=
OPENROUTER_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=

AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=

NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=
```

## 3) Initialize database

```bash
mysql -u root -p < Connector/database.sql
```

## 4) Start backend

```bash
docker compose up -d --build agentic-layer
```

Health:

```bash
curl http://localhost:8000/health
```

## 5) Start frontend

```bash
cd Connector
npm install
npm run dev
```

Open: `http://localhost:3000`

## API Surfaces

Connector BFF (examples):

- `POST /api/scan/validate`
- `GET /api/scan/status?project_id=...`
- `GET /api/scan/results?project_id=...`
- `GET /api/scan/ws-token?project_id=...`
- `POST /api/remediate/start`
- `POST /api/architecture`
- `POST /api/cost`
- `GET /api/pipeline/health`
- `POST /api/pipeline/diagram`
- `POST /api/pipeline/stage7`
- `POST /api/pipeline/iac`
- `POST /api/pipeline/deploy`
- `POST /api/pipeline/deploy/status`
- `POST /api/pipeline/deploy/stop`
- `POST /api/pipeline/deploy/destroy`
- `POST /api/pipeline/runtime-details`

Agentic Layer (examples):

- `POST /api/scan/validate`
- `WS /ws/scan/{project_id}`
- `GET /api/scan/status/{project_id}`
- `GET /api/scan/results/{project_id}`
- `POST /api/remediate/validate`
- `WS /ws/remediate/{project_id}`
- `WS /ws/pipeline/{project_id}`
- `POST /api/architecture/generate`
- `POST /api/cost/estimate`
- `POST /api/stage7/approval`
- `POST /api/terraform/generate`
- `POST /api/terraform/apply`
- `POST /api/terraform/apply/status`
- `POST /api/terraform/apply/stop`
- `POST /api/aws/runtime-details`
- `POST /api/aws/destroy-runtime`

## Known Limits

- Pipeline UI is currently AWS-centric for delivery stages.
- Runtime deploy path is AWS only.
- Terraform RAG module has been removed; IaC generation now relies on Connector template fallback when backend generator is unavailable.
- KG enrichment is optional; remediation can proceed without Neo4j availability.

## Documentation

- Architecture: `ARCHITECTURE.md`
- Operations: `RUNBOOK.md`
- Flow migration notes: `FLOW_MIGRATION_NOTES.md`
- Architecture contract: `ARCHITECTURE_CONTRACTS.md`
