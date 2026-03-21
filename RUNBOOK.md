# DeplAI Operations Runbook

This runbook covers startup, configuration, operational procedures, and troubleshooting for every stage of the DeplAI pipeline.

---

## Table of Contents

1. [Environment Variables Reference](#1-environment-variables-reference)
2. [Service Startup Order](#2-service-startup-order)
3. [Stage-by-Stage Operations](#3-stage-by-stage-operations)
   - [Stage 0 – Pipeline Preflight](#stage-0--pipeline-preflight)
   - [Stage 1 – Code Scan](#stage-1--code-scan)
   - [Stage 2 – KG Agent Analysis](#stage-2--kg-agent-analysis)
   - [Stage 3 – Remediation Supervisor](#stage-3--remediation-supervisor)
   - [Stage 4 – Create PR](#stage-4--create-pr)
   - [Stage 4.5 – Merge Confirmation Gate](#stage-45--merge-confirmation-gate)
   - [Stage 4.6 – Post-Merge Actions](#stage-46--post-merge-actions)
   - [Stage 5 – Re-scan Loop (hard stop at 2 cycles)](#stage-5--re-scan-loop-hard-stop-at-2-cycles)
   - [Stage 6 – Q/A](#stage-6--qa)
   - [Stage 7 – Cost Estimation](#stage-7--cost-estimation)
   - [Stage 8 – Terraform IaC Generation](#stage-8--terraform-iac-generation)
   - [Stage 9 – GitOps CI/CD + GitHub Push](#stage-9--gitops-cicd--github-push)
   - [Stage 10 – Deploy on AWS](#stage-10--deploy-on-aws)
4. [Connector (Next.js) Operations](#4-connector-nextjs-operations)
5. [Agentic Layer (FastAPI) Operations](#5-agentic-layer-fastapi-operations)
6. [KGagent Operations](#6-kgagent-operations)
7. [Docker Volume Management](#7-docker-volume-management)
8. [Health Checks](#8-health-checks)
9. [Incident Playbooks](#9-incident-playbooks)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Environment Variables Reference

All variables go in the repo-root `.env` file (loaded by both `Connector/` and `Agentic Layer/`).

### Core Services

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | Yes | Connector public URL (e.g. `http://localhost:3000`) |
| `AGENTIC_LAYER_URL` | Yes | Agentic Layer internal URL (e.g. `http://localhost:8000`) |
| `NEXT_PUBLIC_AGENTIC_WS_URL` | Yes | Agentic Layer WebSocket URL (e.g. `ws://localhost:8000`) |
| `DEPLAI_SERVICE_KEY` | Yes | Shared HMAC key for Connector→Agentic Layer authentication |
| `WS_TOKEN_SECRET` | Yes | Secret used to sign short-lived WebSocket auth tokens |
| `SESSION_SECRET` | Yes | Next-auth session encryption secret |
| `CORS_ORIGINS` | Yes | Comma-separated allowed CORS origins for Agentic Layer |

### Scanner Timeouts (large repo tuning)

| Variable | Required | Default | Description |
|---|---|---|---|
| `BEARER_TIMEOUT_SECONDS` | No | `1800` | Max wait for Bearer scan before timeout |
| `SYFT_TIMEOUT_SECONDS` | No | `1200` | Max wait for Syft SBOM generation |
| `GRYPE_TIMEOUT_SECONDS` | No | `900` | Max wait for Grype vulnerability scan |
| `REMEDIATION_MAX_FAILED_BATCHES` | No | `4` | Max consecutive remediation batch hard-failures before abort |
| `REMEDIATION_MAX_STALLED_BATCHES` | No | `8` | Max consecutive no-safe-change batches before ending the cycle |
| `SCANNER_TIMEOUT_SECONDS` | No | fallback | Legacy fallback used if specific scanner timeout vars are unset |

### Database

| Variable | Required | Default | Description |
|---|---|---|---|
| `DB_HOST` | Yes | — | MySQL host |
| `DB_PORT` | No | `3306` | MySQL port |
| `DB_USER` | Yes | — | MySQL user |
| `DB_PASSWORD` | Yes | — | MySQL password |
| `DB_NAME` | Yes | — | MySQL database name |

### GitHub OAuth + App

| Variable | Required | Description |
|---|---|---|
| `GITHUB_CLIENT_ID` | Yes | OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | Yes | OAuth App client secret |
| `GITHUB_APP_ID` | Yes | GitHub App ID (for repo access) |
| `GITHUB_PRIVATE_KEY` | Yes | GitHub App private key (PEM, newlines as `\n`) |
| `GITHUB_WEBHOOK_SECRET` | Yes | GitHub webhook HMAC secret |

### LLM Backends

| Variable | Required | Description |
|---|---|---|
| `GROQ_API_KEY` | Recommended | Primary LLM for architecture gen + scanning chat; free tier available |
| `ANTHROPIC_API_KEY` | Optional | `claude` remediation backend |
| `OPENAI_API_KEY` | Optional | `openai` remediation backend + Terraform RAG agent |
| `OPENROUTER_API_KEY` | Optional | Fallback for architecture gen + remediation |

LLM fallback chain for architecture generation:
```
user-supplied provider → GROQ_API_KEY → OPENROUTER_API_KEY → error
```

LLM fallback chain for remediation:
```
user-selected provider → GROQ_API_KEY → error
```

### Cloud Cost Estimation

| Variable | Required | Description |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | Optional | Live AWS Pricing API (`us-east-1`). Without this, AWS cost estimation fails. |
| `AWS_SECRET_ACCESS_KEY` | Optional | Paired with above. IAM permission needed: `pricing:GetProducts`. |

Azure and GCP cost estimation require no credentials.

### KGagent

| Variable | Required | Description |
|---|---|---|
| `NEO4J_URI` | Required if KG enabled | Neo4j bolt URI (e.g. `bolt://localhost:7687`) |
| `NEO4J_USERNAME` | Required if KG enabled | Neo4j username |
| `NEO4J_PASSWORD` | Required if KG enabled | Neo4j password |
| `QDRANT_URL` | Required if KG enabled | Qdrant HTTP URL (e.g. `http://localhost:6333`) |
| `TAVILY_API_KEY` | Optional | Web search tool for KG agent CVE lookup |
| `HUGGING_FACE_HUB_TOKEN` | Optional | Private HuggingFace model access for KG embeddings |

---

## 2. Service Startup Order

Start services in this order to avoid dependency failures:

```
1. MySQL             (database for Connector)
2. Neo4j             (KGagent graph store)
3. Qdrant            (KGagent vector store)
4. Docker Engine     (scan/remediation containers)
5. Agentic Layer     (FastAPI, port 8000)
6. KGagent           (LangGraph server)
7. Connector         (Next.js, port 3000)
```

### Start all (Docker Compose)

```bash
# From repo root
docker compose up -d --build
```

### Start Agentic Layer only

```bash
docker compose up -d --build agentic-layer
```

### Start Connector (development)

```bash
cd Connector
npm install
npm run dev
```

### Start KGagent

```bash
cd KGagent
pip install -r ../Agentic\ Layer/requirements.txt
python -m pipeline.serve
```

---

## 3. Stage-by-Stage Operations

### Stage 0 – Pipeline Preflight

**What it does:** Checks aggregated readiness before starting the single-page pipeline.

**Connector endpoint:** `GET /api/pipeline/health`

**Checks include:**
- `scan`
- `remediation`
- `architecture`
- `diagram`
- `cost`
- `terraform`
- `gitops_deploy`

If required checks are `down`, pipeline execution is blocked.

### Stage 1 – Code Scan

**What it does:** Ingests the codebase into a Docker volume, then runs SAST (Bearer) and SCA (Syft + Grype) in parallel containers. Progress is streamed over WebSocket; results are cached in `security_reports` volume.

**Endpoints:**
- `POST /api/scan/validate` — register project and trigger scan
- `GET /api/scan/status?project_id=...` — poll status
- `GET /api/scan/results?project_id=...` — fetch parsed findings
- `GET /api/scan/ws-token` — mint short-lived WS auth token
- `WS /ws/scan/{project_id}` — real-time progress stream

**Scan types:**

| scan_type | Scanners |
|---|---|
| `sast` | Bearer (static code analysis) |
| `sca` | Syft + Grype (SBOM + vulnerability matching) |
| `all` | Both in parallel (default) |

**For GitHub projects, also include:**
- `github_token` — personal access token or app installation token
- `repository_url` — full HTTPS URL (`.git` suffix)

**Operational notes:**
- Progress comes as `ScanMessage` JSON events on the WebSocket.
- Results persist as `<name>_<id>_Bearer.json`, `<name>_<id>_Grype.json`, `<name>_<id>_sbom.json` in the `security_reports` volume.
- Grype DB is cached in `grype_db_cache` volume. First run downloads ~200MB; subsequent runs skip the download.
- `project_id` must match `[a-zA-Z0-9_-]{1,80}`.

**If scan stays at `not_initiated`:**
1. Check Docker Engine is running: `docker info`
2. Check Agentic Layer is reachable: `curl http://localhost:8000/health`
3. Verify `DEPLAI_SERVICE_KEY` matches in both `.env` files.
4. Check logs: `docker compose logs agentic-layer`

---

### Stage 2 – KG Agent Analysis

**What it does:** After scan completes, `RemediationRunner` concurrently queries the knowledge graph for each finding. Each query runs the LangGraph agent loop: planner → tool calls → nudge/finalize. Results are injected as context into the remediation supervisor prompt.

**KGagent must be running.** If unreachable, remediation continues without KG context (finding-only prompts used).

**KG Agent tools:**
- `search_cve` — semantic search in Qdrant
- `get_cve_details` — Neo4j node lookup
- `get_fix_patterns` — CWE→fix graph traversal
- `web_search` — Tavily search (requires `TAVILY_API_KEY`)
- `get_related_cwes` — CWE graph neighbors

**Check KGagent connectivity:**
```bash
curl http://localhost:<kg-port>/health
```

See `KGagent/ops/KG_OPS_RUNBOOK.md` for KG-specific operational procedures.

---

### Stage 3 – Remediation Supervisor

**What it does:** Runs the multi-agent Planner/Proposer/Critic/Synthesizer loop to generate and apply code patches. Presents diffs to the user for human approval before any persistence.

**Endpoints:**
- `POST /api/remediate/start` — store remediation context + optional LLM override
- `WS /ws/remediate/{project_id}` — real-time remediation stream

**Supervisor agent roles:**

| Agent | Role |
|---|---|
| Planner | Explores repo structure, reads files, builds repair plan |
| Proposer | Generates `{path, search, replace}` JSON patches |
| Critic | Validates patches for coverage, correctness, safety |
| Synthesizer | Applies accepted patches; force-applies on max rounds |

**LLM provider selection:**
Pass `llm_provider`, `llm_api_key`, `llm_model` in `/api/remediate/start` body. Omitting uses `GROQ_API_KEY`.

**Remediation scope:**
Pass `remediation_scope` in `/api/remediate/start`:
- `"all"` (default)
- `"major"` (critical/high only)

**Approval gate:**
WebSocket emits `waiting_approval` after patches are applied. User must send `{"action": "approve_rescan"}` to proceed to PR creation.

**Operational notes:**
- `MAX_ROUNDS` (Proposer↔Critic cycles) is set in `remediation_supervisor.py`.
- Proposer JSON parse errors are auto-sanitized by `_sanitize_json_control_chars()` in `claude_remediator.py`.

**If remediation WebSocket closes with 1008 Unauthorized:**
- Verify `WS_TOKEN_SECRET` is identical in both Connector and Agentic Layer `.env`.
- Token `sub` claim must be a string — check minting in `api/scan/ws-token/route.ts`.

---

### Stage 4 – Create PR

**What it does:** After the user approves the remediation, patches are committed and pushed to a new branch; a GitHub PR is opened automatically.

**Persistence details:**
- Branch name: `deplai-remediation-<timestamp>`
- PR is created via GitHub API using the stored installation token or runtime `github_token`.
- `.git/config` remote URL is rewritten after push to strip the token.

**If PR is not created:**
1. Verify `github_token` has `repo` write scope.
2. Check Agentic Layer logs for the `git push` output.
3. Confirm the repository URL in the remediation request is correct.
4. Use `POST /api/pipeline/remediation-pr` to resolve an existing open remediation PR when stream PR URL is missing.

Common no-op cause: no file changes after Synthesizer → `NO_CHANGES` state; check remediation logs.

---

### Stage 4.5 – Merge Confirmation Gate

**What it does:** The pipeline enters `awaiting_merge_confirmation` and pauses after PR creation.

User action required in the pipeline UI:
1. Merge remediation PR in GitHub.
2. Click merge confirmation in UI.

Without this explicit confirmation, IaC flow does not continue.

---

### Stage 4.6 – Post-Merge Actions

**What it does:** Runs mandatory post-merge controls before IaC.

Actions:
- `Code Refresh` → `POST /api/repositories/refresh`
- `Re-run Scan` → scan status/results refresh + security gate

Security gate:
- If critical/high findings remain, IaC/deploy stages are blocked.
- Only when major findings are cleared does pipeline proceed.

---

### Stage 5 – Re-scan Loop (hard stop at 2 cycles)

**What it does:** Re-runs Bearer + Syft + Grype on the patched codebase. If vulnerabilities remain and fewer than 2 full cycles have completed, the loop restarts from Stage 2 (KG analysis → remediate → PR → re-scan). Hard stops after cycle 2 regardless of remaining findings.

**Cycle counter:** tracked per `project_id` session. Resets when a new scan is initiated.

**Hard stop behaviour:**
- Cycle 3 re-scan completes → pipeline advances to Stage 6 regardless of open findings.
- Remaining findings are surfaced in the Q/A chat for the user to decide whether to continue manually or proceed to deployment.

**To inspect which cycle a project is on:**
```bash
docker compose logs agentic-layer | grep "cycle"
```

**To compare scan results across cycles:**
```bash
docker run --rm -v security_reports:/vol alpine sh -c "ls -lah /vol/*<project_id>*"
```

---

### Stage 6 – Q/A

**What it does:** After the remediation loop completes, the chat session resumes. The user describes their deployment target and infrastructure shape. The LLM calls `generate_architecture` to produce a structured `{title, nodes, edges}` JSON from natural language.

**Tool called:** `generate_architecture`
- params: `{prompt, provider: "aws"}`
- Result stored in `lastArchitectureJsonRef` on the frontend for use in Stage 7.

**LLM fallback chain for architecture generation:**
```
user-supplied provider → GROQ_API_KEY → OPENROUTER_API_KEY → error
```

**If architecture gen fails:**
1. Check `GROQ_API_KEY` / `OPENROUTER_API_KEY` in `.env`.
2. Check Agentic Layer logs: `docker compose logs agentic-layer`.
3. Try a shorter, simpler prompt.

---

### Stage 7 – Diagram + Cost Estimation

**What it does:** First generates a diagram artifact from architecture JSON, then queries the AWS Pricing API to return a monthly cost breakdown per service.

**Endpoint:** `POST /api/cost/estimate` (Agentic Layer)
**Connector BFF:** `POST /api/cost`

**Request:**
```json
{
  "architecture_json": { "nodes": [...] },
  "provider": "aws",
  "aws_access_key_id": "AKIA...",
  "aws_secret_access_key": "..."
}
```

**Response:**
```json
{
  "success": true,
  "provider": "aws",
  "total_monthly_usd": 342.50,
  "currency": "USD",
  "breakdown": [
    {"service": "EC2 t3.medium", "monthly_usd": 30.37},
    {"service": "RDS db.t3.micro", "monthly_usd": 16.79}
  ],
  "errors": []
}
```

**Required IAM permission:** `pricing:GetProducts` on `arn:aws:pricing:us-east-1:*:*`

**If AWS cost estimate returns all errors:**
1. Verify `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` are set.
2. Verify the IAM policy grants `pricing:GetProducts`.
3. The `errors` array lists per-service failures — partial results are still returned.

---

### Stage 8 – Terraform IaC Generation

**What it does:** Generates Terraform files for the architecture. Attempts the ChromaDB RAG agent first; auto-falls back to static AWS templates.

**Connector BFF endpoint:** `POST /api/pipeline/iac`

**Request:**
```json
{
  "project_id": "my-project",
  "provider": "aws",
  "project_name": "my-app",
  "architecture_json": { ... },
  "openai_api_key": "sk-..."
}
```

**Response:**
```json
{
  "success": true,
  "provider": "aws",
  "project_name": "my-app",
  "files": [
    {"name": "main.tf", "content": "..."},
    {"name": "variables.tf", "content": "..."},
    {"name": "outputs.tf", "content": "..."}
  ],
  "source": "rag_agent"
}
```

**`source` values:**
- `rag_agent` — ChromaDB RAG agent generated the Terraform
- `template` — Static AWS template used (RAG agent unavailable or failed)

**Ansible note:** Current bundle includes baseline hardening skeleton only (syntax-checkable placeholder). It is not a full host orchestration pipeline yet.

**Pre-requisite for RAG agent (one-time setup):**
```bash
cd "Agentic Layer/terraform_rag_agent"
python src/indexer.py   # builds ChromaDB vector DB in data/vector_db/
```

**If RAG agent produces `source: "template"`:**
1. Check `OPENAI_API_KEY` is set.
2. Verify `data/vector_db/` exists: `ls "Agentic Layer/terraform_rag_agent/data/vector_db/"`
3. If missing, run `python src/indexer.py`.
4. Static template fallback is safe to use in production.

---

### Stage 9 – Budget Policy Gate

**What it does:** Enforces budget policy before deploy. If estimate exceeds configured cap, pipeline pauses for operator override.

**Budget hard block (enforced):**
- Request includes `estimated_monthly_usd` and `budget_limit_usd`.
- Deployment is blocked when `estimated_monthly_usd > budget_limit_usd`.
- Current single-page default budget limit: `$100`.

**Operator actions:**
1. If paused by policy, click budget override in the dashboard to continue.
2. Proceed to Stage 10 runtime deployment.

---

### Stage 10 – Deploy on AWS

**What it does:** Dashboard Stage 10 is a manual gate. Clicking deploy calls `POST /api/pipeline/deploy` with `runtime_apply=true`, applies generated Terraform directly, and returns outputs including CloudFront URL to the UI.

**Connector BFF endpoint:** `POST /api/pipeline/deploy`

**Runtime Terraform flow:**
```
terraform init
terraform apply -auto-approve
terraform output -json
```

**Expected outputs surfaced in UI/logs:**
- `cloudfront_url`
- `instance_public_ip` / `instance_url`
- `security_logs_bucket`

**If deployment fails:**
1. Verify `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION`.
2. Check API response `details.apply_log_tail` and `details.stderr_tail`.
3. Confirm account quotas/service limits for EC2, S3, and CloudFront.

---

## 4. Connector (Next.js) Operations

### Development

```bash
cd Connector
npm run dev         # http://localhost:3000 with hot reload
```

### Production

```bash
cd Connector
npm run build
npm start
```

### Logs

Development logs appear in the terminal running `npm run dev`. For production use your process manager (PM2, systemd, etc.).

### Database init

```bash
mysql -u <user> -p <dbname> < Connector/database.sql
```

### Session/auth issues

- Verify `SESSION_SECRET` is consistent across restarts.
- OAuth callback URL must be: `<NEXT_PUBLIC_APP_URL>/api/auth/callback/github`
- Verify `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` match the registered OAuth App.

---

## 5. Agentic Layer (FastAPI) Operations

### Start

```bash
docker compose up -d --build agentic-layer
```

### Logs

```bash
docker compose logs -f agentic-layer
```

### Restart

```bash
docker compose restart agentic-layer
```

### Manual endpoint tests

```bash
# Health check
curl http://localhost:8000/health

# Architecture generation (requires GROQ_API_KEY)
curl -X POST http://localhost:8000/api/architecture/generate \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $DEPLAI_SERVICE_KEY" \
  -d '{"prompt":"simple 2-tier web app on AWS","provider":"aws"}'

# Cost estimation (Azure, no credentials needed)
curl -X POST http://localhost:8000/api/cost/estimate \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $DEPLAI_SERVICE_KEY" \
  -d '{"architecture_json":{"nodes":[{"type":"VirtualMachine","size":"Standard_B2s"}]},"provider":"azure"}'

# Terraform generation (static template fallback if no vector DB)
curl -X POST http://localhost:8000/api/terraform/generate \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $DEPLAI_SERVICE_KEY" \
  -d '{"architecture_json":{"nodes":[{"type":"EC2"}]},"provider":"aws","project_name":"test"}'
```

---

## 6. KGagent Operations

See `KGagent/ops/KG_OPS_RUNBOOK.md` for full KGagent procedures.

### Start

```bash
cd KGagent
pip install -r ../Agentic\ Layer/requirements.txt
python -m pipeline.serve
```

### Start Neo4j (Docker)

```bash
docker run -d --name neo4j \
  -e NEO4J_AUTH=neo4j/<password> \
  -p 7474:7474 -p 7687:7687 \
  neo4j:5
```

### Start Qdrant (Docker)

```bash
docker run -d --name qdrant \
  -p 6333:6333 \
  qdrant/qdrant
```

### Check connectivity

```bash
curl http://localhost:7474          # Neo4j browser
curl http://localhost:6333/healthz  # Qdrant health
```

---

## 7. Docker Volume Management

### List DeplAI volumes

```bash
docker volume ls | grep deplai
```

Expected volumes:
- `codebase_deplai` — active scanned/remediated codebase (`/repo/<project_id>/`)
- `security_reports` — Bearer/Syft/Grype JSON outputs
- `LLM_Output` — remediation summary artifacts
- `grype_db_cache` — Grype vulnerability DB cache

### Inspect files in a volume

```bash
docker run --rm -v codebase_deplai:/data alpine ls /data
docker run --rm -v security_reports:/vol alpine sh -c "ls -lah /vol"
```

### Clear files for a specific project

```bash
# Remove codebase
docker run --rm -v codebase_deplai:/data alpine rm -rf /data/<project_id>

# Remove scan reports
docker run --rm -v security_reports:/vol alpine sh -c "rm -f /vol/*<project_id>*"
```

### Full reset (destroys all volumes)

```bash
docker compose down -v
docker compose up -d --build
```

Note: This deletes all scan results and cached data. Use only when troubleshooting persistent volume issues.

---

## 8. Health Checks

| Service | Check | Expected |
|---|---|---|
| Agentic Layer | `curl http://localhost:8000/health` | `{"status":"ok"}` or `{"status":"healthy"}` |
| Connector | Open `http://localhost:3000` | Login page loads |
| Neo4j | `curl http://localhost:7474` | HTML page |
| Qdrant | `curl http://localhost:6333/healthz` | JSON with title |
| MySQL | `mysqladmin -u <user> -p ping` | `mysqld is alive` |
| Docker | `docker info` | No error |

### Quick pipeline smoke test

```bash
# 1. Agentic Layer health
curl http://localhost:8000/health

# 2. Scan validate (GitHub project)
curl -s -X POST http://localhost:8000/api/scan/validate \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $DEPLAI_SERVICE_KEY" \
  -d '{"project_id":"smoke-test","repository_url":"https://github.com/org/repo.git","github_token":"...","scan_type":"all"}' | python -m json.tool

# 3. Architecture gen during Q/A phase (GROQ_API_KEY needed)
curl -s -X POST http://localhost:8000/api/architecture/generate \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $DEPLAI_SERVICE_KEY" \
  -d '{"prompt":"3-tier web app on AWS","provider":"aws"}' | python -m json.tool

# 4. Cost estimation (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY needed)
curl -s -X POST http://localhost:8000/api/cost/estimate \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $DEPLAI_SERVICE_KEY" \
  -d '{"architecture_json":{"nodes":[{"type":"EC2","instance_type":"t3.medium"}]},"provider":"aws","aws_access_key_id":"'$AWS_ACCESS_KEY_ID'","aws_secret_access_key":"'$AWS_SECRET_ACCESS_KEY'"}' | python -m json.tool

# 5. Terraform gen (static fallback, no vector DB needed)
curl -s -X POST http://localhost:8000/api/terraform/generate \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $DEPLAI_SERVICE_KEY" \
  -d '{"architecture_json":{"nodes":[{"type":"EC2"}]},"provider":"aws","project_name":"smoke-test"}' | python -m json.tool
```

---

## 9. Incident Playbooks

### 9.1 Scan shows "No vulnerabilities" unexpectedly

```bash
# Check report files exist and are non-empty
docker run --rm -v security_reports:/vol alpine sh -c "ls -lah /vol/*<project_id>*"
```

If Grype report is empty or missing:
- Check Grype container logs: `docker logs deplai-grype-<project_id>`
- Verify SBOM file is non-empty
- Re-trigger the scan

### 9.2 No report files in security_reports

Likely causes:
- Scan failed before scanners executed
- Docker volume mount issue
- Failed project ingest (git clone error or bad local path)

```bash
docker compose logs -f agentic-layer
```

Look for: volume creation errors, git clone failures, local project path not found.

### 9.3 WebSocket stuck in `running`

Checks:
- Client sent `{"action":"start"}` after connecting
- Agentic Layer accepted the WS token
- Runner emitted terminal `completed` or `error` event

Action:
```bash
docker compose restart agentic-layer
# Then re-trigger scan or remediation
```

Scope note:
- WebSocket streams are implemented for scan/remediation only.
- Later pipeline stages (health, merge gate, refresh, rerun gate, architecture, diagram, cost, terraform, deploy) run via HTTP endpoints and UI stage logs.

### 9.4 GitHub remediation did not create PR

Checks:
- Runtime token has `repo` write scope
- Repository URL is correct
- Branch push succeeded (check Agentic Layer logs for `git push` output)

Common causes:
- No file changes after remediation (`NO_CHANGES`)
- Suspended GitHub App installation
- Token scope insufficient

### 9.5 GitHub App installation suspended

Behavior: Scan/remediation for GitHub repos fails unless a runtime personal access token is provided.

Action: Unsuspend the App installation in GitHub → Settings → Applications, or pass a runtime `github_token` with `repo` scope.

### 9.6 All WebSocket connections fail with 1008

Root cause: `WS_TOKEN_SECRET` mismatch between Connector and Agentic Layer, or `user.id` type mismatch in token.

Fix:
1. Ensure `WS_TOKEN_SECRET` is identical in both services.
2. Verify token minting uses `String(user.id)` (not a number) in `api/scan/ws-token/route.ts`.
3. Restart both services after `.env` changes.

---

## 10. Troubleshooting

### Architecture generation returns empty JSON or parse error

1. Verify `GROQ_API_KEY` is valid and has quota remaining.
2. Check Agentic Layer logs for the raw LLM response.
3. Try `llm_provider: "openrouter"` with `OPENROUTER_API_KEY` set.

### AWS cost estimation returns all errors

1. Verify `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` are set.
2. IAM permission required: `pricing:GetProducts` on resource `arn:aws:pricing:us-east-1:*:*`.
3. Service: `pricing.us-east-1.amazonaws.com` must be reachable from the Agentic Layer container.

### Terraform RAG agent produces `source: "template"` instead of `source: "rag_agent"`

1. Check `OPENAI_API_KEY` is set.
2. Verify vector DB exists:
   ```bash
   ls "Agentic Layer/terraform_rag_agent/data/vector_db/"
   ```
3. If missing, build it:
   ```bash
   cd "Agentic Layer/terraform_rag_agent"
   python src/indexer.py
   ```
4. Static template fallback is safe to use in production.

### Remediation: "Codebase volume is not a git repository"

Cause: `.git` directory was removed from the ingested codebase.
Fix: This is handled automatically by the fix in `environment.py` (uses `git remote set-url` instead of `rm -rf .git`). If seen on an existing project, trigger a fresh scan to re-ingest the repo, then start remediation again.

### Remediation: GitHub push fails

1. Verify `github_token` has `repo` write scope.
2. Check `repository_url` in the remediation request.
3. Check Agentic Layer logs for the exact `git push` error message.
4. Verify `.git/config` remote URL does not contain a stale/expired token.

### Chat: tool call silently dropped

1. Open browser DevTools → Network → watch `POST /api/chat` responses.
2. Check `toolCall` field — if it is a `CLIENT_TOOL`, it must reach `executeTool` in `agent-chat.tsx`.
3. Verify the tool name has a matching `case` in the `executeTool` switch statement.

### Chat: run_scan fires before user confirms

Handled by `CONFIRMATION_TOOLS` logic in `chat/route.ts`. If the LLM response contains `?` and the tool is `run_scan` or `start_remediation`, the tool call is stripped and the user must answer first. If you see unexpected scans, check whether the LLM response contains a question mark.

### Proposer JSON parse errors in remediation logs

Handled automatically by `_sanitize_json_control_chars()` in `claude_remediator.py`. If errors persist, check the raw LLM response in logs — the model may be emitting JSON outside the expected `{...}` wrapper.

---

## Recovery and Rollback

- **Local projects:** source of truth is `Connector/tmp/local-projects/<user_id>/<project_id>`
- **GitHub projects:** source of truth is Git history; remediation is isolated on a generated branch + PR. Close the PR or revert the commit to roll back.
- If a scan degrades unexpectedly after remediation, close the remediation PR, re-ingest the original codebase (trigger a new scan), and investigate the diff.
