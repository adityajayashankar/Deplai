# DeplAI UI/UX editor runtime

The supported service is `service.deep_agent_app:app`. The older Agno scaffold below is retained for reference and is not the Docker entrypoint.

## Run the supported service

Install `requirements-runtime.txt`, export `DEPLAI_SERVICE_KEY` and the platform's `OPENROUTER_API_KEY`, then run:

```sh
uvicorn service.deep_agent_app:app --host 127.0.0.1 --port 7777 --workers 1
```

Environment variables are read from the process (the runtime does not auto-load `.env`). Set `UIUX_RUN_DIRECTORY` to durable private storage. The default model is OpenRouter's `openrouter/free` router (200K context, zero-priced). Optionally set `UIUX_OPENROUTER_MODEL` to an exact `:free` model ID; it must still pass live zero-pricing and tool-support checks. No user model keys, paid fallback, MongoDB, GitHub token, repository mount, shell, or build runner is used.

For a native Connector using `Connector/.env.local`, start its matching local Docker worker from the repository root with `docker compose --env-file Connector/.env.local -f compose.yaml up -d --build --no-deps uiux-agent`. Both processes must use the same `DEPLAI_SERVICE_KEY`; the worker also needs the platform `OPENROUTER_API_KEY`. Starting Compose without this env file uses the local placeholder key and can produce service-authentication errors. `UIUX_CONNECTOR_URL` is an operator-controlled callback origin: native defaults to `http://127.0.0.1:3000`, local Docker to `http://host.docker.internal:3000`, production Docker to `http://connector:3000`.

## Agent architecture and contract

The bounded graph runs a planner, a dynamic editor with `read_file`, literal `search`, exact `edit_file`, and `finish` tools, then an independent reviewer with a fresh context and no write tools. All agents share one call/token/time budget. This follows the planning, filesystem, and delegation pattern described in [Deep Agents](https://docs.langchain.com/oss/python/deepagents/overview), with a purpose-built restricted harness instead of its default filesystem/delegation tools. The restriction makes one shared free-model budget and write boundary explicit.

Every endpoint requires the server-only `X-API-Key: DEPLAI_SERVICE_KEY` header. Connector authenticates the user and supplies trusted ownership IDs:

- `GET /uiux/health`: configuration status and runtime limits.
- `POST /uiux/runs`: `{request_id?:UUID,project_id,user_id,organization_id?,source_sha,prompt,files?:[{path,content}],scope?:string[],repository_access?:boolean}`. Returns HTTP 202 with the initial run. `source_sha` must be a 40-character Git SHA. Reusing a request ID returns the same run only for matching ownership and identical inputs; conflicting inputs are rejected. Run IDs use the UUID's 32-character hexadecimal form.
- `GET /uiux/runs/{run_id}?user_id=...&project_id=...`: persisted run, owner checked.
- `DELETE /uiux/runs/{run_id}?user_id=...&project_id=...`: cancels active work, owner checked.

Run fields include `run_id`, `source_sha`, `status` (`queued`, `running`, `completed`, `failed`, `cancelled`), `events` (`sequence`, `type`, `timestamp`, `message`), `changes` (`path`, `before`, `after`), `summary`, `warnings`, `conflicts`, and `usage` (`requests`, `input_tokens`, `output_tokens`, `budget_tokens`, `models`). A completed run contains proposals only: Connector must independently verify the original SHA and AST before exposing accepted diffs or creating a PR.

Conversation memory and run history are kept in the user's browser through IndexedDB. Server persistence is operational: the worker retains run execution state, and Connector retains trusted manifests and source baselines needed for callbacks, change verification, and PR creation. Neither server is the source of the UI's latest conversation history.

## Boundaries and known fragility

The default route is live-verified `openrouter/free` with a 200,000-token request context. No smaller-model fallback is used. Context estimates are tokenizer-dependent; the provider enforces its actual window. The aggregate run budget is 1,000,000 tokens across up to 18 requests, reconciled to reported prompt/completion usage after each response. Missing usage retains an estimate. Request-count, context, aggregate-token, and time exhaustion have separate error messages; none is presented as a provider rate limit.

The independent reviewer receives complete before/after source, not just a diff or the editor's tool instructions. Concrete behavior and scope conflicts still block publication. CSS-only process complaints about missing repository reads/builds are advisory because source is supplied and Connector independently validates the proposal.

Only existing CSS, SCSS, TSX, and JSX presentation files can be seeded and edited. Hidden paths, API/backend/services/hooks/auth folders, manifests, tests, and configurations are rejected for editing. With `repository_access:true`, the agent discovers the entire repository manifest through paginated `list_files` and fetches relevant unseeded files through `read_file`; trusted Connector callbacks may provide other source files as read-only context. The callback origin is fixed by server environment, and only the service authentication key is forwarded. Scope restricts writes to exact paths when provided; otherwise all eligible presentation paths can be explored and edited. No added/deleted files or new dependencies are supported. Exact replacements and fast hook/handler checks run on every write; Connector's AST guard is the authoritative business-logic gate. Visual copy can carry business meaning that static analysis cannot prove, so PR review remains necessary.

There is no total-repository size limit in dynamic discovery mode: Connector sends a small seed snapshot and the model fetches task-relevant files on demand. Execution budgets remain separate: two active runs per process, one per user, 18 model requests including retries and reviewer, 1,000,000 aggregate token units reconciled against actual provider usage, 600 seconds, 12 modified files, 200 cached files explored in one run, 128 KB per remote file, and 12,000 characters per model read. Seed payloads are limited to 2 MB and input JSON to 3 MB including chunked requests; these are transport/context budgets, not repository eligibility limits. Large or cross-module changes may need multiple runs. Requests default to `openrouter/free` (200K context). The catalog is refreshed at most every five minutes; the selected route must remain verified zero-priced; smaller-context fallbacks are disabled. Per-request provider maximum price is zero. Provider capacity can disappear, free account quotas are shared, and no implementation can promise free capacity. Retries honor reset headers and bounded backoff; long quota resets terminate with an actionable error instead of paying for a fallback. CSS-only missing-read/build process complaints are advisory; concrete scope or behavior conflicts still block.

Source and proposed files live only in each private run directory. Atomic records survive restarts; interrupted jobs become failed and never silently resume. Cancellation discards proposals. Deploy a single worker/replica for the in-process concurrency/rate limiter; horizontal scaling needs a shared queue and distributed quota locks. Run snapshots contain private source and need storage access controls and an operator retention policy. Source is sent to eligible OpenRouter providers; provider data policies may differ. The service does not execute dependency scripts or builds and does not generate a live preview. Sandboxed preview execution belongs to a separately isolated service.

Focused offline verification: `python -m pytest test_deep_agent_runtime.py -q`. These tests mock model responses; they do not spend OpenRouter or Codex model calls.

---

## Legacy Agno scaffold (not used by the supported runtime)

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
