# Customization Agent (UI/UX customizer)

Path: `Customization Agent/tenant_builder_app/backend/`. FastAPI on **8010**. Compose service `customization`. The browser never talks to it; Connector proxies `/api/customization/*`.

Optional second service: `uiux-agent/` via `UIUX_AGENT_BASE_URL` (default `http://127.0.0.1:7777`). Server-side only — never `NEXT_PUBLIC`.

## Trust

1. Session auth on Connector.
2. Ownership-checked project / repo. Source path is resolved from DB + clone/ZIP roots, not from a client-supplied filesystem path.
3. Proxy: `Connector/src/app/api/customization/[...path]/route.ts` → `CUSTOMIZATION_BACKEND_URL` / `CUSTOMIZATION_AGENT_BASE_URL`.
4. Customization calls Connector AI gateway (`DEPLAI_AI_GATEWAY_URL` + `DEPLAI_SERVICE_KEY` + user id). Keys stay in the Connector vault (`LlmConfig` on the backend: provider/model/access_mode/user_id only).

Tenant copies live on volume `customization_state` (`/app/tenant_builder_app/backend/tenants`). GitHub clones and ZIP trees are mounted the same as Connector (`github_repos`, `local_projects`).

## Engine stages (UI)

`ENGINE_STAGES` in `Connector/src/features/customization/config.ts`:

| Group | Stages |
| --- | --- |
| Analysis | Repository analyzed → Frontend map → Business logic boundaries → Product UX model → UX architecture → Design system → Screen plan |
| Implementation | Application shell → Screens → Responsive → Accessibility |
| QA | Visual QA → **Functional safety** → Preview verification → Final review |

**Scope is frontend-only.** Functional safety fails the run if the patch touches business-logic / backend-shaped paths (`frontend_customization/boundary.py`, `policies.py`, `validation.py`).

## Pipeline modes (studio)

`PIPELINE_MODE_OPTIONS`: hybrid (LLM + deterministic), llm_only, deterministic_only, diagnostic (dry run).

Customization modes: full_transformation, targeted_screen, design_system, responsive, accessibility.

Workflow chrome: draft → review → apply → validate → preview → ready.

## Backend layout

| Path | Role |
| --- | --- |
| `main.py` | HTTP: chat, implement, preview, assets, snapshots, admin reset |
| `frontend_customization/` | LangGraph intake → mapping → implementation → QA → delivery |
| `graph/customization_graph.py` | Older/full-stack graph (backend planner/scanner still in tree) |
| `services/preview_manager.py` | Local preview process |
| `services/snapshot_manager.py` | Checkpoints for revert |
| `services/ai_gateway.py` | Python client to Connector `/api/ai` |
| `services/deterministic_customizer.py` | Non-LLM token/theme edits |

Deploy can consume a customization snapshot (`customization_snapshot_id` / `tenant_id` on `/api/pipeline/deploy`, Agentic `RepositorySourceOverride` kind `customization_snapshot`).

Related: [Connector](connector.md) · [AI platform](ai-platform.md) · [Known gaps](known-gaps.md)
