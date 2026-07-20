# DeplAI API reference

This reference covers the Connector’s browser-facing API and the Agentic Layer’s internal execution API. It reflects routes implemented in the repository.

## API conventions

### Connector API

The Connector is the browser-facing backend at the Next.js origin, normally `http://localhost:3000` in development.

- Protected routes use the encrypted `deplai_session` cookie and return `401` when no signed-in user is present.
- Project, repository, installation, and local-file operations additionally check ownership.
- Success responses are JSON unless the endpoint intentionally streams/downloads data.
- Failures usually use `{ "error": "..." }`; upstream Agentic unavailability is surfaced as `502` or `503` with an actionable message.
- Browser clients must call Connector routes, not Agentic Layer routes directly.

### Agentic Layer API

The Agentic Layer normally runs at `http://localhost:8001` through Docker Compose. Its container listens on port 8000.

All non-health HTTP endpoints require:

```http
X-API-Key: <DEPLAI_SERVICE_KEY>
Content-Type: application/json
```

The Connector adds this header server-side. Do not put the service key in browser code.

### WebSocket security

The Connector issues a short-lived HMAC token for scan/remediation/pipeline sockets. The token includes an expiry, user subject, and project ID. The Agentic Layer rejects tokens that are invalid, expired, for another project, or whose subject does not match the stored workflow context.

## Connector authentication

| Method | Route | Authentication | Description |
| --- | --- | --- | --- |
| `GET` | `/api/auth/login` | Public | Begins GitHub OAuth. Creates state in session and redirects to GitHub. The request includes `prompt=select_account`; pass `?force=1` to clear the post-logout guard and begin the chooser flow. |
| `GET` | `/api/auth/callback` | OAuth callback | Validates state, exchanges code, creates/updates the DeplAI user, records session identity, and redirects to `/dashboard`. |
| `POST` | `/api/auth/logout` | Session optional | Destroys the DeplAI session. Optionally requests backend cleanup only when `CLEANUP_SCAN_VOLUMES_ON_LOGOUT=true`; sets a short-lived logout guard cookie. |
| `GET` | `/api/auth/session` | Public | Returns the current `SessionData` only when logged in; otherwise returns `{ "isLoggedIn": false }`. |

## Connector projects and GitHub

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/projects` | Lists authenticated user’s local projects and visible GitHub repositories; synchronizes/claims installations best-effort before returning results. |
| `POST` | `/api/projects/upload` | Accepts multipart `file` (ZIP) and `name`; maximum ZIP size is 1 GB. Extracts safe files and creates a local project. |
| `GET` | `/api/projects/[id]` | Gets project information. |
| `DELETE` | `/api/projects/[id]` | Deletes a user-owned local project and associated stored content; may notify Agentic cleanup paths. |
| `GET` | `/api/projects/local/contents` | Lists a local project directory after ownership validation. |
| `GET` | `/api/projects/local/file` | Reads a local project file after ownership and traversal validation. |
| `GET` | `/api/installations` | Lists user-owned GitHub App installations. |
| `DELETE` | `/api/installations` | Disconnects an installation accessible to the user. |
| `GET` | `/api/repositories` | Lists GitHub repositories available to the authenticated user. |
| `GET` | `/api/repositories/[id]` | Reads repository metadata. |
| `DELETE` | `/api/repositories/[id]` | Soft-hides an owned repository. |
| `GET` | `/api/repositories/branches` | Lists branches for an owned installation/repository. |
| `GET` | `/api/repositories/contents` | Lists repository content using a scoped installation token. |
| `GET` | `/api/repositories/file` | Reads repository file content after ownership checks. |
| `POST` | `/api/repositories/refresh` | Refreshes repository data/clone state. |
| `POST` | `/api/github/create-repo` | Creates a GitHub repository through an owned installation. |
| `POST` | `/api/sync` | Synchronizes GitHub installation/repository information. |
| `POST` | `/api/webhooks/github` | Receives GitHub webhook deliveries and updates installation/repository state. |

### Local project upload

`POST /api/projects/upload` uses `multipart/form-data`:

| Field | Required | Notes |
| --- | --- | --- |
| `file` | Yes | A `.zip` archive no larger than 1 GB. |
| `name` | Yes | Display name for the project. |

The response contains `success` and the new project’s ID, type, local path, file count, and byte size.

## Connector scan and remediation

| Method | Route | Description |
| --- | --- | --- |
| `POST` | `/api/scan/validate` | Validates ownership and sends normalized scan context to Agentic. |
| `GET` | `/api/scan/status?project_id=…` | Returns scan state. |
| `GET` | `/api/scan/results?project_id=…` | Returns parsed scan results. |
| `GET` | `/api/scan/ws-token?project_id=…` | Mints a short-lived WebSocket token for an owned project. |
| `POST` | `/api/remediate/start` | Validates remediation context and forwards GitHub credentials/token data server-side. |
| `POST` | `/api/pipeline/remediation-pr` | Queries remediation pull-request status for an owned project. |

### Scan validation request

```json
{
  "project_id": "project-or-repository-id",
  "project_name": "payment-service",
  "project_type": "github",
  "scan_type": "all",
  "owner": "octo-org",
  "repo": "payment-service"
}
```

`project_type` is `local` or `github`; `scan_type` is `sast`, `sca`, or `all`. The Connector resolves the GitHub repository URL and installation token itself. Do not send a GitHub token from normal browser scan code.

### Remediation start request

```json
{
  "project_id": "project-or-repository-id",
  "llm_provider": "optional-provider",
  "llm_api_key": "optional per-request key",
  "llm_model": "optional model",
  "remediation_scope": "all"
}
```

`remediation_scope` is `all` or `major`. For GitHub projects the Connector obtains a scoped GitHub App token where possible and checks token ownership when a personal token is supplied.

## Connector planning, IaC, and runtime APIs

| Method | Route | Description |
| --- | --- | --- |
| `POST` | `/api/repository-analysis/run` | Runs source/repository analysis for an owned project. |
| `POST` | `/api/architecture/review/start` | Starts a guided architecture review. |
| `POST` | `/api/architecture/review/complete` | Completes a guided review and returns deployment context/profile. |
| `POST` | `/api/architecture` | Creates an architecture document. AWS requests without explicit LLM settings use the deterministic architecture path. |
| `POST` | `/api/cost` | Estimates cost from architecture data. |
| `POST` | `/api/pipeline/stage7` | Builds the review/approval payload for the Stage 7 handoff. |
| `POST` | `/api/pipeline/iac` | Generates Terraform and supports the consultant/renderer flow. |
| `GET` | `/api/pipeline/iac-status/[runId]` | Proxies status for an asynchronous IaC run. |
| `GET` | `/api/pipeline/iac-ws-proxy/[runId]` | WebSocket proxy for IaC run logs. |
| `POST` | `/api/pipeline/iac/pr` | Creates or retrieves an IaC pull-request handoff for GitHub projects. |
| `GET` | `/api/pipeline/cost-estimate` | Retrieves/caches pipeline cost-estimate data. |
| `POST` | `/api/pipeline/deploy` | Starts deployment/apply with plan confirmation handling. |
| `POST` | `/api/pipeline/deploy/status` | Returns active deployment status. |
| `POST` | `/api/pipeline/deploy/stop` | Requests a running deployment stop. |
| `POST` | `/api/pipeline/deploy/verify` | Verifies configured runtime endpoints. |
| `POST` | `/api/pipeline/deploy/destroy` | Performs best-effort cleanup of DeplAI-managed runtime resources. |
| `POST` | `/api/pipeline/runtime-details` | Retrieves AWS runtime/resource details. |
| `POST` | `/api/pipeline/runtime-instance` | Performs `start`, `stop`, or `reboot` on a selected EC2 instance. |
| `GET` | `/api/pipeline/keypair/ppk` | Converts/downloads a generated EC2 key in PPK form where available. |
| `GET` | `/api/pipeline/ws-config` | Returns the Agentic WebSocket base derived from the configured Agentic URL. |
| `GET` | `/api/pipeline/health` | Returns Agentic service health for the dashboard. |
| `GET` | `/api/pipeline/diagram` | Serves pipeline/architecture diagram data. |

### Terraform generation request

`POST /api/pipeline/iac` accepts a project ID plus the selected planning inputs. Key fields are:

```json
{
  "project_id": "project-id",
  "provider": "aws",
  "iac_mode": "deterministic",
  "deployment_profile": { "document_kind": "deployment_profile" },
  "approval_payload": {},
  "architecture_json": {},
  "qa_summary": "",
  "aws_region": "ap-south-1",
  "workspace": "optional-workspace",
  "state_bucket": "optional-state-bucket",
  "lock_table": "optional-lock-table",
  "terraform_renderer": "auto",
  "consultant_action": "start"
}
```

`provider` currently accepts `aws`, `azure`, or `gcp`; the current deployment/runtime execution path is AWS-focused. `iac_mode` is `deterministic` or `llm`. Renderer options are `auto`, `deplai_deterministic`, and `deplai_ec2_app`.

The response includes success state, generated files, manifest, dependency order, warnings, run/workspace IDs, renderer metadata, and plan/execution metadata where applicable.

### Runtime request shape

Runtime APIs require an owned project plus AWS credentials/region supplied through the dashboard payload. The Agentic Layer accepts AWS access key ID, secret access key, optional session token for Terraform apply, `project_name`, and `aws_region`. Runtime details may include a selected `instance_id`; EC2 actions additionally require `action` equal to `start`, `stop`, or `reboot`.

## Connector settings, chat, and assets

| Method | Route | Description |
| --- | --- | --- |
| `GET` / `PATCH` | `/api/settings` | Reads or updates user/workspace settings; privileged settings require admin access. |
| `POST` | `/api/settings/cleanup` | Requests guarded cleanup behavior from authenticated settings UI. |
| `POST` | `/api/chat` | Sends a chat request, including supported LLM provider configuration. |
| `GET` / `POST` | `/api/chat/sessions` | Lists or creates user chat sessions. |
| `GET` / `PATCH` / `DELETE` | `/api/chat/sessions/[id]` | Reads, updates, or deletes an owned chat session. |
| `GET` | `/api/assets/aws-icon/[name]` | Serves an allowed AWS icon asset. |
| `GET` | `/api/ec2/logs` | Retrieves available EC2 log data for an owned runtime context. |

## Connector customization proxy

All `/api/customization/[...path]` routes require a Connector session. The proxy keeps the customization backend inaccessible directly from normal browser code and resolves owned project paths for repository-bound operations.

| Connector route | Upstream customization route | Description |
| --- | --- | --- |
| `GET /api/customization/manifest?tenant_id=…` | `GET /manifest` | Gets tenant manifest and confirmation state. |
| `POST /api/customization/chat` | `POST /chat` | Sends a tenant customization request. |
| `POST /api/customization/confirm` | `POST /confirm` | Confirms a tenant manifest. |
| `POST /api/customization/implement` | `POST /api/tenant/implement` | Resolves an owned `project_id` to `base_repo_path`, then applies approved changes. |
| `POST /api/customization/reset-repo` | `POST /api/admin/tenant/reset-repo` | Resolves project path and rebuilds tenant copy from base source. |
| `POST /api/customization/assets/upload` | `POST /api/tenant/assets/upload` | Uploads a supported tenant branding asset. |
| `GET /api/customization/assets/[tenant]` | `GET /api/tenant/assets/[tenant]` | Lists tenant asset metadata. |
| `GET /api/customization/assets/[tenant]/[type]` | `GET /api/tenant/assets/[tenant]/[type]` | Serves a stored asset. |
| `GET /api/customization/preview/*` | local/proxied preview | Serves preview status/content through ownership-aware preview handling. |
| `GET /api/customization/resolve-repo-path?project_id=…` | Connector only | Resolves an owned project to a source path; not forwarded upstream. |

The backend also exposes health, plan, repo-index, preview start/status/stop, and manifest reset APIs. It requires manifest confirmation before implementation and returns `409` if confirmation is missing or stale.

## Agentic Layer HTTP API

All routes in this table require `X-API-Key` unless marked otherwise.

### Security and remediation

| Method | Route | Request/behavior |
| --- | --- | --- |
| `POST` | `/api/scan/validate` | Stores a `ScanValidationRequest`: project ID/name/type, user ID, scan type, and optional GitHub token/repository URL. |
| `GET` | `/api/scan/results/{project_id}` | Returns parsed scan results. |
| `GET` | `/api/scan/status/{project_id}` | Returns `running`, `found`, `not_found`, `not_initiated`, or other current status. |
| `DELETE` | `/api/scan/results/{project_id}` | Deletes scan reports for one project. |
| `POST` | `/api/remediate/validate` | Stores a remediation context with source type, optional GitHub data, optional LLM configuration, and scope. |
| `POST` | `/remediation/run` | Runs remediation-pipeline work. |
| `GET` | `/remediation/status` | Returns remediation status. |
| `POST` | `/remediation/pr` | Performs remediation pull-request operation. |
| `POST` | `/remediation/refresh` | Refreshes remediation context/results. |
| `POST` | `/remediation/navigate` | Handles remediation navigation actions. |
| `POST` | `/api/cleanup` | Globally deletes Docker volumes only if `ALLOW_GLOBAL_CLEANUP=true`; destructive. |

### Planning and generation

| Method | Route | Request/behavior |
| --- | --- | --- |
| `POST` | `/api/repository-analysis/run` | Accepts repository-analysis request and returns repository context. |
| `POST` | `/api/architecture/review/start` | Starts architecture-review question flow. |
| `POST` | `/api/architecture/review/complete` | Completes review and produces deployment-profile data. |
| `POST` | `/api/architecture/generate` | Accepts prompt, provider, and optional LLM configuration; returns validated architecture JSON. |
| `POST` | `/api/cost/estimate` | Accepts architecture JSON, provider, and optional AWS credentials; returns cost totals/breakdown. |
| `POST` | `/api/stage7/approval` | Accepts infrastructure plan, budget cap, pipeline run ID, and environment; returns approval payload. |
| `POST` | `/api/terraform/generate` | Accepts architecture/profile/source/approval/security/AWS/renderer inputs; returns generated Terraform bundle details. |

### Apply and runtime

| Method | Route | Request/behavior |
| --- | --- | --- |
| `POST` | `/api/terraform/apply` | Accepts run/workspace/files and AWS credentials; may return `requires_plan_confirmation`. |
| `POST` | `/api/terraform/apply/status` | Gets Terraform apply state for a project or project name. |
| `POST` | `/api/terraform/apply/stop` | Stops active Terraform apply work. |
| `POST` | `/api/aws/runtime-details` | Returns AWS account/resource counts and selected/project-matched instance details. |
| `POST` | `/api/aws/instance-action` | Starts, stops, or reboots one EC2 instance. |
| `POST` | `/api/aws/destroy-runtime` | Best-effort deletion of DeplAI-tagged runtime resources. |

### Asynchronous IaC router

| Method | Route | Description |
| --- | --- | --- |
| `POST` | `/api/iac/generate-and-apply` | Creates an IaC run and schedules a background pipeline. Requires project ID, service type, repository context, customizations, and AWS credentials. |
| `GET` | `/api/iac/status/{run_id}` | Returns run status, plan summary, recent logs, outputs/keypair on success, or error on failure. |
| `DELETE` | `/api/iac/run/{run_id}` | Destroys resources for a stored IaC run. |

### Health

| Method | Route | Authentication | Description |
| --- | --- | --- | --- |
| `GET` | `/ready` | Public | Lightweight service readiness response. |
| `GET` | `/health` | Public | Dependency-oriented health response, including Docker reachability and optional checks. |

## Agentic Layer WebSockets

| Socket | Purpose | Start command |
| --- | --- | --- |
| `/ws/scan/{project_id}?token=…` | Scan progress and interactive scan actions. | `{ "action": "start" }` |
| `/ws/remediate/{project_id}?token=…` | Remediation progress and decision/approval actions. | `{ "action": "start" }` |
| `/ws/pipeline/{project_id}?token=…` | Dashboard pipeline-event stream. | Connect with a valid token. |
| `/api/iac/ws/{run_id}` | IaC runner log/status stream. | Connect after `generate-and-apply`. |

Shared scan/remediation command frames use:

```json
{ "action": "start" }
```

Other supported command names are `continue_round`, `push_current`, and `approve_push`. The server sends status frames such as:

```json
{ "type": "status", "status": "running" }
```

and timestamped message frames such as:

```json
{
  "type": "message",
  "data": {
    "index": 1,
    "total": 0,
    "type": "info",
    "content": "Repository analysis started",
    "timestamp": "2026-07-19T00:00:00+00:00"
  }
}
```

The asynchronous IaC WebSocket sends `{ "type": "log", "data": "…" }` frames and finishes with a `done` frame containing status, optional outputs/keypair, and error when applicable.

## Error handling and safe client behavior

- Treat `401` as a prompt to re-authenticate.
- Treat `403` as an ownership/admin/operation guard; do not retry by changing IDs client-side.
- Treat `409` from customization implementation as a requirement to confirm the manifest again.
- Treat `502`/`503` as service/dependency unavailability and surface the returned diagnostic. Connector IaC routes retry appropriate Agentic network and transient HTTP failures across localhost/loopback variants.
- Never retry an apply/destroy request blindly. Query status or runtime details first and require explicit user confirmation for a new apply.
- Never invoke global Agentic cleanup from normal user logout or browser automation. It is disabled by default for a reason.
