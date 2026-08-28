# Agno UI/UX Refactor Agent

A multi-agent system built on [Agno](https://docs.agno.com) that upgrades frontend components to enterprise quality — component by component, patch by patch — while being **structurally incapable** of touching business logic or backend code.

## Architecture

```
┌─────────────────── Workflow (deterministic control flow) ──────────────────┐
│                                                                             │
│  Stage 1    Stage 2     Stage 3       Stage 4        Stage 5               │
│  AST Scan → Token    → Vagueness  → Clarifier    → Design System          │
│  (func)     Extract    Gate (func)   Agent (HITL)   Agent (LLM)           │
│             (func)                                                         │
│  Stage 6      Stage 7          Stage 8      Stage 9                       │
│  Boundary  → Component     → Validate  → Retry Loop                      │
│  Classify    Refactorer       (func)      (Loop 7→8)                      │
│  (func)      Team (LLM)                                                   │
│                                                                             │
│  Stage 10           Stage 11       Stage 12                               │
│  Apply Patch     → Reporter    → Human Approval                          │
│  (HITL confirm)    Agent (LLM)   (@approval)                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Quick Start (Tier 0 — Local)

```bash
# 1. Start MongoDB (one-time setup)
mongod --dbpath ./tmp/mongo-data --port 27017 --bind_ip 127.0.0.1

# 2. Install dependencies
cd uiux-agent
python -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt

# 3. Configure
cp .env.example .env
# Edit .env: set ANTHROPIC_API_KEY

# 4. Run
python service/agent_os_app.py
# → http://localhost:7777/docs

# 5. Connect Control Plane
# os.agno.com → Add new OS → Local → http://localhost:7777
```

## Trigger a Run

```bash
curl -X POST http://localhost:7777/workflows/uiux-refactor-agent/runs \
  -F "message=Refactor the Settings module to enterprise SaaS style" \
  -F "user_id=aj" -F "session_id=settings-run-1"
```

## Safety Guarantees

| Guarantee | Enforcement |
|-----------|-------------|
| No business logic changes | Diff mask from boundary classifier; allowlist in tool layer |
| No backend file access | `Allowlist` class blocks API routes, lib/, all backend dirs |
| Token traceability | Design System Agent spec; refactorer instructions |
| Patch-only, never full regen | `write_patch` tool; `git apply` for atomic application |
| Human approval before merge | `@approval(type="required")` at Stage 12 |
| WCAG accessibility | `axe-core` validation gate at Stage 8 |
| Audit trail | AgentOS native tracing — every tool call logged |

## Repo Layout

```
uiux-agent/
├── tools/           # Deterministic code-analysis (zero LLM)
├── agents/          # Agno Agent definitions
├── workflows/       # Agno Workflow (the 12-stage pipeline)
├── guardrails/      # Custom pre/post hooks
├── schemas/         # Pydantic models
├── service/         # AgentOS wiring + entry point
├── eval/            # Regression fixtures
├── docker-compose.yml   # Tier 1 (Docker + Mongo)
└── Dockerfile
```

## Deployment Tiers

| Tier | DB | When to use |
|------|-----|-------------|
| 0 — Local | `mongod` on localhost | Solo dev, building/validating the pipeline |
| 1 — Docker | Mongo 7 container | Shared eval, CI, teammate handoff |
| 2 — Production | Atlas / self-hosted replica set | VPC-internal, multi-user, production |

The `db=` argument is the **only** thing that changes between tiers.
