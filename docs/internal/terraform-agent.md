# Terraform Agent

Path: `Terraform Agent/`. Python package imported by Agentic as `terraform_agent` (see `Terraform Agent/terraform_agent/__init__.py` and Agentic Docker PYTHONPATH). It is not a separate HTTP service in the local or production Compose stacks.

## What it owns

| Piece | Path | Role |
| --- | --- | --- |
| IaC run store | `agent/iac_pipeline.py` | In-memory `_RUNS` keyed by `run_id`. Status: pending → selecting_params → validating → planning → applying → completed/failed |
| Param selection | `agent/param_selector.py` | LLM-backed Terraform parameters when `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY` is set; otherwise slug defaults from the project name |
| Graph / nodes | `agent/graph.py`, `agent/nodes/` | Repo parse → infra plan → terraform generate → validate → refine → final output |
| Templates / catalog | `agent/template_registry.py`, `agent/module_catalog.py`, `agent/internal_registry/` | Known service types and internal module contracts |
| Engine | `agent/engine/` | Bundle, locking, storage, bootstrap, research, runtime, execution, deployment profile, enterprise bundle, manifest |
| Executor | `agent/executor.py` | `plan`, `stream_apply`, `destroy`, `get_outputs` against a workspace |

Terraform itself runs in Docker image `hashicorp/terraform:1.9.0` from Agentic (`terraform_apply.py`), not from a Terraform binary on the Connector host.

## How Agentic calls it

1. Connector `POST /api/pipeline/iac` or `/api/pipeline/deploy` (after ownership checks) → Agentic `/api/terraform/generate`, `/consult`, `/apply`.
2. Agentic `terraform_apply.py` renders files, writes a workspace under `IAC_WORKSPACE_ROOT` (Compose: `/workspace/iac-workspaces` volume `iac_workspaces`), runs `terraform plan` in Docker.
3. Apply is **blocked** until Connector sends `confirm_plan_summary: true`. Until then Agentic returns status `awaiting_plan_confirmation`.
4. Optional remote state: `state_bucket` + `lock_table` on the deploy body. Locks live in `agent/engine/locking.py`.

## In-memory caveat

`iac_pipeline._RUNS` and Agentic apply context are process-local. Multi-worker Agentic or a restart loses live run status. The comment in `iac_pipeline.py` says to replace with Redis for production multi-worker.

## Env that affects generation

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY` | Param selector LLM |
| `IAC_PARAM_SELECTOR_MODEL` | Override (default `claude-sonnet-4-5`) |
| `IAC_MAX_VALIDATION_RETRIES` | Default 3 |
| `IAC_WORKSPACE_ROOT` | Workspace directory |
| `IAC_WORKSPACE_TTL_HOURS` | Default 24 |
| `IAC_TERRAFORM_PARALLELISM` | Default 10 |
| `DEPLAI_CLAUDE_MAX_TERRAFORM_GEN_COST_USD` | Cap (default 1.0) |
| `DEPLAI_FREE_TIER_EC2_TYPES` | Free-tier instance allowlist |
| `DEPLAI_ALLOW_EC2_DISABLE_FALLBACK` | Allow disabling fallback instance types |

AWS credentials for apply are **per request** (`aws_access_key_id` / secret / session / region on the deploy body), not the Connector’s long-lived env, unless the operator also set host `AWS_*` for cost/runtime helpers.

Related: [Deploy pipeline](deploy-pipeline.md) · [Agentic Layer](agentic-layer.md)
