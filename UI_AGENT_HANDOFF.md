# DeplAI UI Agent Handoff

## 1. Purpose

This document is a build-ready product and engineering brief for generating or refining the DeplAI user interface.

It is intended for an implementation agent that needs:

- platform context
- system architecture boundaries
- API surface and contracts
- integration behavior
- operational runbook expectations
- UI information architecture and UX guardrails

If there is a mismatch between this document and runtime behavior, backend route handlers in Connector and Agentic Layer are the source of truth.

## 2. Platform Overview

DeplAI is an agentic DevSecOps platform that orchestrates software delivery from repository intake through scan, remediation, architecture design, cost estimation, IaC generation, and deployment.

Primary value proposition:

1. Validate and scan a codebase for SAST and SCA issues.
2. Drive a supervised remediation loop with human merge gates.
3. Generate architecture and cost outputs for deployment planning.
4. Produce IaC bundles and deploy via GitOps or runtime apply.

Current active runtime path:

- Frontend + BFF: Next.js app in Connector
- Orchestration backend: FastAPI app in Agentic Layer
- Stage 7 diagram and cost: subprocess via diagram_cost-estimation_agent
- Knowledge graph enrichment: KGagent imported in-process by backend remediation flow
- Runtime deploy: AWS-focused via backend terraform apply APIs

## 3. Users and Core Journeys

### 3.1 Primary User Roles

1. Developer: scans project, triggers remediation, reviews generated PR.
2. Security Engineer: inspects findings severity, validates remediation decisions.
3. Platform/DevOps Engineer: approves architecture/cost and executes IaC + deploy.

### 3.2 End-to-End Journey

1. Select or upload project.
2. Run scan validation and stream scan execution.
3. Inspect findings.
4. Start remediation and review generated change set.
5. Open/merge PR gate.
6. Provide deployment Q/A context.
7. Generate architecture and cost.
8. Approve Stage 7.5 payload.
9. Generate IaC.
10. Apply policy and budget checks.
11. Deploy via GitOps or runtime apply.

## 4. System Architecture

## 4.1 Logical Components

1. Connector (Next.js)
   - Dashboard, stage orchestration UI
   - Auth/session and ownership checks
   - BFF routes under /api/*
   - GitHub app/token interactions
2. Agentic Layer (FastAPI)
   - Scan and remediation orchestration
   - Pipeline websocket bus
   - Architecture, cost, stage7, terraform, runtime endpoints
3. KGagent
   - Optional graph enrichment (Neo4j and Qdrant)
4. Stage 7 agent
   - Diagram + cost + approval payload packaging

## 4.2 Runtime Data/Infra Dependencies

1. MySQL: app metadata in Connector.
2. Docker engine + volumes:
   - codebase_deplai
   - security_reports
   - LLM_Output
   - grype_db_cache
3. GitHub APIs: repos, PRs, app installations, variables, workflows.
4. Cloud provider APIs:
   - AWS pricing/runtime
   - Azure pricing (retail API)
   - GCP estimation path

## 4.3 Stage Model for UI

Canonical order surfaced in UI:

1. 0 preflight
2. 1 scan
3. 2 KG analysis
4. 3 remediation
5. 4 remediation PR
6. 4.5 merge gate
7. 4.6 post-merge actions
8. 6 Q/A context gathering
9. 7 architecture + cost
10. 7.5 approval gate
11. 8 IaC generation
12. 9 GitOps/policy gate
13. 10 deploy

Operational constraints:

- Remediation cycles are capped at 2 in backend.
- Runtime apply currently supports AWS only.
- Deploy can be blocked when estimated_monthly_usd > budget_limit_usd unless budget_override=true.

## 5. API Surface for UI

Authentication model summary:

1. User session required for Connector BFF routes.
2. Connector calls Agentic Layer with X-API-Key (DEPLAI_SERVICE_KEY).
3. WebSocket channels use short-lived HMAC token (WS_TOKEN_SECRET), project-scoped.

### 5.1 High-Priority UI Endpoints (Connector BFF)

These are the endpoints the UI should treat as primary for pipeline execution.

#### Scan and Remediation

1. POST /api/scan/validate
   - Validates project and scanner context.
   - For github project_type, resolves installation token and repository_url.
2. GET /api/scan/ws-token?project_id={id}
   - Returns short-lived token for ws connections.
3. GET /api/scan/status?project_id={id}
4. GET /api/scan/results?project_id={id}
5. POST /api/remediate/start
   - Accepts project_id and optional llm/provider overrides.

#### Architecture, Cost, Stage 7

1. POST /api/architecture
   - Required: prompt
   - Provider default aws
   - AWS path can return deterministic architecture if no explicit llm override
2. POST /api/cost
   - Required: architecture_json
   - provider in aws|azure|gcp
   - optional aws credentials for live AWS pricing
3. POST /api/pipeline/stage7
   - Required: infra_plan
   - Optional: budget_cap_usd, pipeline_run_id, environment

#### IaC and Deploy

1. POST /api/pipeline/iac
   - Required: project_id
   - Requires at least one context source:
     - qa_summary, or
     - architecture_context, or
     - architecture_json
   - AWS path requires architecture_json
2. POST /api/pipeline/deploy
   - Required: project_id
   - Modes:
     - runtime_apply=true -> backend terraform apply (AWS only)
     - runtime_apply=false -> GitOps repo flow
3. POST /api/pipeline/deploy/status
4. POST /api/pipeline/deploy/stop
5. POST /api/pipeline/deploy/destroy
6. POST /api/pipeline/runtime-details
7. POST /api/pipeline/deploy/verify

#### Pipeline Ops

1. GET /api/pipeline/health
2. GET /api/pipeline/ws-config
3. POST /api/pipeline/remediation-pr

### 5.2 Agentic Layer Backend Endpoints (called by BFF)

1. POST /api/scan/validate
2. WS /ws/scan/{project_id}
3. GET /api/scan/status/{project_id}
4. GET /api/scan/results/{project_id}
5. DELETE /api/scan/results/{project_id}
6. POST /api/remediate/validate
7. WS /ws/remediate/{project_id}
8. WS /ws/pipeline/{project_id}
9. POST /api/repository-analysis/run
10. POST /api/architecture/review/start
11. POST /api/architecture/review/complete
12. POST /api/architecture/generate
13. POST /api/cost/estimate
14. POST /api/stage7/approval
15. POST /api/terraform/generate
16. POST /api/terraform/apply
17. POST /api/terraform/apply/status
18. POST /api/terraform/apply/stop
19. POST /api/aws/runtime-details
20. POST /api/aws/destroy-runtime
21. GET /health

### 5.3 Key Request Contracts (UI-facing summary)

#### POST /api/scan/validate

```json
{
  "project_id": "string",
  "project_name": "string",
  "project_type": "local|github",
  "scan_type": "all|sast|sca",
  "owner": "optional",
  "repo": "optional"
}
```

#### POST /api/remediate/start

```json
{
  "project_id": "string",
  "cortex_context": "optional string",
  "github_token": "optional",
  "llm_provider": "optional",
  "llm_api_key": "optional",
  "llm_model": "optional",
  "remediation_scope": "all|major"
}
```

#### POST /api/architecture

```json
{
  "prompt": "string",
  "provider": "aws|azure|gcp",
  "project_name": "optional",
  "qa_summary": "optional",
  "deployment_region": "optional",
  "llm_provider": "optional",
  "llm_api_key": "optional",
  "llm_model": "optional"
}
```

#### POST /api/cost

```json
{
  "architecture_json": {},
  "provider": "aws|azure|gcp",
  "project_id": "optional",
  "aws_access_key_id": "optional",
  "aws_secret_access_key": "optional"
}
```

#### POST /api/pipeline/iac

```json
{
  "project_id": "string",
  "provider": "aws|azure|gcp",
  "qa_summary": "optional",
  "architecture_context": "optional",
  "architecture_json": {},
  "aws_region": "optional",
  "llm_provider": "optional",
  "llm_api_key": "optional",
  "llm_model": "optional"
}
```

#### POST /api/pipeline/deploy

```json
{
  "project_id": "string",
  "provider": "aws|azure|gcp",
  "runtime_apply": true,
  "files": [
    { "path": "terraform/main.tf", "content": "...", "encoding": "utf-8" }
  ],
  "run_id": "optional",
  "workspace": "optional",
  "aws_access_key_id": "optional",
  "aws_secret_access_key": "optional",
  "aws_region": "optional",
  "estimated_monthly_usd": 12.34,
  "budget_limit_usd": 20,
  "budget_override": false
}
```

## 6. Integrations and External Systems

### 6.1 GitHub

Integration modes:

1. GitHub App installation token flow for repository operations.
2. Optional PAT flow for GitOps repository creation and variable updates.
3. Webhook ingestion route available at /api/webhooks/github.

UI implications:

- Show installation suspended state clearly.
- Distinguish installation-token mode vs user-token mode where relevant.
- Surface PR URL and branch metadata when remediation/IaC persistence succeeds.

### 6.2 Docker and Scanners

1. Scan/remediation rely on Docker availability.
2. Scanner artifacts persist in Docker volumes.
3. Health checks should explicitly display docker_engine status.

### 6.3 KG Dependencies

1. Neo4j outage should degrade KG enrichment only, not block core remediation pipeline.
2. UI should present degraded state copy, not hard-fail entire workflow.

### 6.4 Cloud and Pricing

1. AWS cost may use live credentials.
2. Azure and GCP cost paths can run without cloud credentials.
3. Runtime deploy currently enforces AWS path.

## 7. Operational Runbook for UI/Platform Behavior

## 7.1 Local Startup Sequence

1. Start database (MySQL).
2. Start Docker Desktop.
3. Start backend:

```bash
docker compose up -d --build agentic-layer
```

4. Start Connector:

```bash
cd Connector
npm install
npm run dev
```

5. Open http://localhost:3000

## 7.2 Health Checks

1. Backend:

```bash
curl http://localhost:8000/health
```

2. Connector pipeline health (authenticated):

```bash
curl http://localhost:3000/api/pipeline/health
```

UI requirement:

- Render both overall and per-check status (healthy/degraded/down).

## 7.3 Common Failure Modes to Model in UI

1. Scan not started: status not_initiated.
2. Scan still running: block IaC with actionable warning.
3. WS close code 1008: token issue (expired, invalid signature, project mismatch).
4. Budget guardrail block: deploy returns 422 with blocked=true.
5. Runtime apply stale bundle: deploy returns 409 requiring Stage 8 regenerate.
6. Agentic layer unreachable: show AGENTIC_LAYER_URL and retry guidance.

## 8. UI Information Architecture

## 8.1 Required Screens

1. Project Intake
   - repository selection/upload
   - ownership and source diagnostics
2. Pipeline Board
   - stage timeline with state transitions
   - websocket event stream panel
3. Scan Results
   - SAST/SCA tabs
   - severity filtering
4. Remediation Workspace
   - generated changes summary
   - approve re-scan action
   - PR status
5. Architecture and Cost Workspace
   - prompt/context controls
   - architecture graph preview
   - cost breakdown and budget indicator
6. IaC Review
   - generated file explorer and diff-style view
   - warnings panel
7. Deploy Console
   - runtime apply vs GitOps mode selector
   - progress logs and status polling
   - stop/destroy/runtime-details controls
8. Ops/Health Panel
   - service checks and dependency status

## 8.2 Pipeline State Model

Each stage should support:

1. pending
2. active
3. running
4. success
5. error
6. blocked
7. degraded

Gate stages (4.5, 6, 7.5, 9, 10) must enforce explicit user action before advancing.

## 8.3 UX Rules for Agent Implementation

1. Do not hide backend error payloads; map them to user-safe copy plus technical detail drawer.
2. Preserve idempotency guards for repeated clicks on long-running operations.
3. Always display source-of-truth stage IDs and last updated timestamp.
4. Distinguish validation errors (400/422) from runtime failures (500/502/504).
5. For websocket-driven stages, reconnect with token refresh and exponential backoff.

## 9. Non-Functional Requirements

1. Security
   - Never expose service keys or cloud secrets in client-rendered logs.
   - Redact credentials in request/response inspectors.
2. Reliability
   - Use optimistic UI only where rollback state is defined.
   - Poll fallback for status when websocket unavailable.
3. Observability
   - Capture request_id/stage_id correlation for each action.
   - Persist stage transition audit trail.
4. Performance
   - Keep route timeout messaging explicit for long-running tasks.
   - Virtualize large file/result lists in scan and IaC screens.

## 10. Appendix: Full Connector Route Inventory

Authentication and session:

- GET /api/auth/login
- GET /api/auth/callback
- POST /api/auth/logout
- GET /api/auth/session

Project and repository management:

- GET /api/projects
- POST /api/projects/upload
- GET /api/projects/{id}
- DELETE /api/projects/{id}
- GET /api/projects/local/contents
- GET /api/projects/local/file
- GET /api/repositories
- DELETE /api/repositories/{id}
- GET /api/repositories/branches
- GET /api/repositories/contents
- GET /api/repositories/file
- POST /api/repositories/refresh
- GET /api/installations
- DELETE /api/installations
- POST /api/sync

Pipeline + analysis:

- POST /api/scan/validate
- GET /api/scan/status
- GET /api/scan/results
- GET /api/scan/ws-token
- POST /api/remediate/start
- POST /api/repository-analysis/run
- POST /api/architecture
- POST /api/architecture/review/start
- POST /api/architecture/review/complete
- POST /api/cost
- GET /api/pipeline/health
- GET /api/pipeline/ws-config
- POST /api/pipeline/diagram
- POST /api/pipeline/stage7
- POST /api/pipeline/iac
- POST /api/pipeline/remediation-pr
- POST /api/pipeline/deploy
- POST /api/pipeline/deploy/status
- POST /api/pipeline/deploy/stop
- POST /api/pipeline/deploy/destroy
- POST /api/pipeline/deploy/verify
- POST /api/pipeline/runtime-details
- POST /api/pipeline/keypair/ppk

GitHub and chat:

- POST /api/github/create-repo
- POST /api/webhooks/github
- POST /api/chat
- GET /api/chat/sessions
- POST /api/chat/sessions
- GET /api/chat/sessions/{id}
- PATCH /api/chat/sessions/{id}
- DELETE /api/chat/sessions/{id}

Assets:

- GET /api/assets/aws-icon/{name}

## 11. Implementation Notes for UI Agent

When generating UI, prioritize:

1. Stage-oriented workflow dashboard with clear gate checkpoints.
2. Explicit separation of scan, remediation, architecture/cost, IaC, and deploy domains.
3. A resilient operations layer with health, retries, and recovery controls.
4. Provider-aware UX that clearly labels AWS-only runtime deploy limitations.

This document should be treated as the baseline brief for screen generation and interaction design.