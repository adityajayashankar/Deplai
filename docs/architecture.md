# DeplAI architecture

This document describes the implementation currently present in the repository. It is derived from the Connector, Agentic Layer, Terraform Agent, customization backend, database schema, and Docker configuration.

## System boundary

DeplAI has a browser-facing control plane and a backend execution plane.

```text
                         ┌─────────────────────────────────────┐
                         │               Browser               │
                         │ Landing + Dashboard + Documentation │
                         └──────────────────┬──────────────────┘
                                            │ HTTPS / WebSocket
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Connector — Next.js 16                                                        │
│                                                                             │
│  App Router pages · iron-session · MySQL · GitHub OAuth/App · API façade   │
│  project ownership · file/repository operations · UI-specific adaptations  │
└─────────────┬───────────────────────────┬─────────────────────────┬─────────┘
              │ X-API-Key                 │ GitHub API              │ authenticated proxy
              ▼                           ▼                         ▼
┌──────────────────────────┐   ┌──────────────────────┐  ┌────────────────────┐
│ Agentic Layer — FastAPI  │   │ GitHub OAuth + App   │  │ Customization      │
│ scans/remediation        │   │ profiles/installations│  │ backend — FastAPI  │
│ analysis/planning        │   │ tokens/webhooks/repos │  │ tenant manifests   │
│ Terraform + AWS ops      │   └──────────────────────┘  │ previews/assets    │
└───────────┬──────────────┘                              └────────────────────┘
            │
            ├── Docker Engine: scanners, volumes, Terraform execution
            ├── Terraform Agent: bundle generation, state, locks, apply
            ├── remediation_pipeline: finding-to-fix orchestration
            └── AWS APIs: cost, Terraform-managed resources, runtime inspection
```

The Connector is the only browser-facing backend. The Agentic Layer is a trusted internal service authenticated with `DEPLAI_SERVICE_KEY`; browsers do not receive that key. The customization backend is also reached through the Connector proxy so its repository resolution remains tied to the authenticated DeplAI user.

## Components

### Connector (`Connector/`)

The Connector is a Next.js 16 application using the App Router, React 19, TypeScript, Tailwind CSS, MySQL, `iron-session`, Octokit, and server-side file access.

Its responsibilities are:

- Render the public landing page and authenticated dashboard applications.
- Complete GitHub OAuth login, establish the encrypted `deplai_session` cookie, and expose session state.
- Require authenticated sessions and verify project, repository, or installation ownership before protected operations.
- Maintain MySQL records for users, projects, GitHub installations/repositories, chat history, and settings.
- Manage GitHub App installation tokens, repository cloning/pulling, file/branch APIs, webhooks, and repository sync.
- Receive local ZIP uploads, extract them into project-scoped storage, and expose safe browse/read endpoints.
- Shape UI requests into internal Agentic Layer contracts and attach `X-API-Key`.
- Issue short-lived HMAC WebSocket tokens bound to a project and a user.
- Proxy customization requests while resolving a project’s source directory from ownership-checked database records.

The public landing page lives at `/`; the main dashboard is `/dashboard`. Other current routes include pipeline, deployment, instance-management, customization, documentation, project-installation, and code-view experiences.

### Agentic Layer (`Agentic Layer/`)

The Agentic Layer is a FastAPI service. It requires `DEPLAI_SERVICE_KEY` at startup and rejects internal HTTP requests without a matching `X-API-Key` header.

It owns:

- Scan validation, scan execution context, scan status/result retrieval, and scan-report cleanup.
- Remediation validation, remediation runners, and remediation orchestration.
- Repository analysis and architecture-review start/complete APIs.
- Architecture generation, cloud-cost estimation, Stage 7 approval generation, and Terraform generation.
- Terraform apply, status, stop, runtime-detail, EC2 action, and runtime-destruction APIs.
- Project-scoped scan/remediation/pipeline WebSockets.
- Health/readiness reporting and stale Terraform-workspace cleanup at startup.

Scan, remediation, and pipeline state is primarily held in process memory while a run is active. A restart clears active in-memory contexts and WebSocket subscribers; persistent findings and repository/project state are retrieved from their respective storage locations.

### Terraform Agent (`Terraform Agent/agent/`)

The Terraform Agent is imported as the `terraform_agent` Python package. Docker Compose mounts `Terraform Agent/` at `/app/terraform_agent`, while the small root compatibility package makes the same imports work in local development.

Core responsibilities:

- Build a manifest and dependency order from an architecture document.
- Build deterministic deployment-profile bundles for static sites and ECS-style profiles.
- Build repository-aware bundles and a dedicated EC2 application bundle.
- Validate and refine Terraform using plan attempts and diagnostics.
- Keep per-workspace run state, artifacts, generated files, and optional S3 snapshots.
- Acquire/release DynamoDB workspace locks when configured.
- Run Terraform commands, parse JSON event streams, separate sensitive outputs, and retry safe apply failures.
- Destroy an IaC run when requested through the alternate `/api/iac` router.

The Agentic Layer also exposes direct Terraform generation/apply APIs for the current dashboard deployment path. The `/api/iac` router provides an asynchronous run model with `run_id`, polling, a log WebSocket, and run destruction.

### Customization backend (`Customization Agent/tenant_builder_app/backend/`)

The optional customization backend manages tenant manifests and safely applies customization plans to tenant copies of projects.

The flow is:

1. The Connector authenticates the user and resolves an owned source repository or local project path.
2. The user sends a customization message through the Connector proxy.
3. The backend keeps up to six recent turns per tenant in memory, classifies the request, and sends a reduced or full manifest context to the configured LLM.
4. The user confirms the manifest.
5. The implementation endpoint runs the hybrid deterministic/LLM pipeline, returns changed files and diffs, can run quality gates, and can start a preview.

LLM interpreter, scanner, and planner failures deliberately surface as errors rather than silently falling back to broad deterministic behavior. The Connector maps unavailable backend errors to a clear `502` response.

## Identity, sessions, and ownership

### GitHub OAuth

`GET /api/auth/login` creates a random OAuth state, stores its ten-minute expiry in the encrypted session, and redirects to GitHub’s authorization endpoint. The request includes `prompt=select_account`, so a browser with an existing GitHub session is prompted to choose an account instead of silently reusing the most recent one.

`GET /api/auth/callback` verifies the state in constant time, exchanges the authorization code, reads the GitHub profile and email list, upserts the DeplAI user by email, writes session identity data, and binds compatible GitHub installations.

The `deplai_session` cookie is `HttpOnly`, `SameSite=Lax`, seven days long, and `Secure` in production. Production requires `SESSION_SECRET`; local development has a development fallback to reduce setup friction.

### GitHub App

The GitHub App integration uses its configured app ID and private key to create installation access tokens. Tokens are cached until expiry. Installation/repository records are synchronized into MySQL and are associated with a DeplAI user. Protected operations verify direct ownership and retain a legacy fallback through a project record when an older installation row has no user ID.

### Authorization layers

| Boundary | Enforcement |
| --- | --- |
| Browser → Connector | `iron-session`; protected routes use `requireAuth`. |
| Connector project access | Local-project, project, repository, and installation ownership helpers query MySQL. |
| Connector → Agentic Layer | `X-API-Key: DEPLAI_SERVICE_KEY`. |
| Browser → Agentic WebSocket | Connector-minted HMAC token with expiry, `project_id`, and user subject. |
| GitHub data | OAuth user identity plus GitHub App installation tokens; scoped write token for remediation PRs. |
| Customization backend | Connector session + project path resolution before upstream proxying. |

The Agentic Layer validates that WebSocket tokens have not expired, match the connecting project, and have a subject that matches the user in the stored scan/remediation context. A browser reconnect attaches to an active run instead of automatically starting it again.

## Persistence and workspace storage

### MySQL

`Connector/database.sql` defines the baseline tables:

| Table | Purpose |
| --- | --- |
| `users` | DeplAI user identity keyed by UUID, with unique email. |
| `github_installations` | GitHub App installations, account metadata, owner binding, suspension state, and raw metadata. |
| `github_repositories` | Installed repositories, branch, language metadata, sync/clone status, webhook ID, and hidden flag. |
| `projects` | User-owned local projects and optional links to GitHub repository records. |
| `chat_sessions` / `chat_messages` | Per-user persisted agent-chat history with API-enforced session/message limits. |

The Connector’s settings APIs additionally support workspace/user settings data. Deployments should apply the baseline schema before starting the UI and preserve schema compatibility during upgrades.

### File locations

- Local ZIP uploads are extracted to `Connector/tmp/local-projects/<user-id>/<project-id>` and the original ZIP is retained beside the user directory.
- GitHub repositories are cloned to `Connector/tmp/repos/<owner>/<repo>`.
- Docker Compose mounts both paths read-only into the Agentic Layer as `/local-projects` and `/repos`.
- Terraform Agent run state, generated bundles, artifacts, and knowledge cache use its runtime paths; optional configured S3/DynamoDB resources support snapshots and locking.
- Customization backend files are stored under its backend tenant data path, including assets, saved manifest, plan, repository index, and tenant repository copy.

ZIP extraction excludes hidden files and common generated directories such as `node_modules`, `.git`, build output, Python caches, virtual environments, and editor metadata. File browse/read helpers validate paths to prevent directory traversal.

## Execution flows

### Project onboarding

1. The user authenticates through GitHub OAuth.
2. For a GitHub project, the Connector synchronizes GitHub App installations and repository records, then creates/reuses a shallow clone when source access is needed.
3. For a local project, the Connector accepts a ZIP up to 1 GB, extracts the safe content, calculates file count/size, and saves a `projects` record.
4. `GET /api/projects` combines user-owned local projects and visible GitHub repositories into the dashboard project list.

### Security scan

1. The browser posts project ID, name, source type, and scan type (`sast`, `sca`, or `all`) to the Connector.
2. The Connector validates ownership; GitHub projects obtain an installation token and repository URL server-side.
3. The Connector posts the normalized context to `POST /api/scan/validate` in the Agentic Layer.
4. The browser requests a short-lived Connector WebSocket token and connects to `/ws/scan/{project_id}` through the Agentic endpoint.
5. Sending `{ "action": "start" }` starts or reconnects to the scan runner. Status and message frames stream progress.
6. The Connector retrieves status/results through protected routes; Agentic cache invalidation occurs before the completed status is emitted.

### Remediation

1. The Connector validates project ownership and resolves an installation token or supplied token for a GitHub project.
2. It submits a remediation context to Agentic and opens the remediation WebSocket.
3. The remediation pipeline extracts, groups, generates, and validates changes. The runner may request a decision or approval through command frames.
4. GitHub remediation supports a scoped installation token with content and pull-request write permissions. PR lookup/creation is always ownership checked by the Connector.

### Planning and IaC generation

1. Repository analysis produces source, framework, service, and infrastructure signals.
2. Architecture review starts with source context and finishes with collected answers and a deployment profile.
3. Architecture generation accepts deterministic AWS input by default or forwards explicitly requested LLM configuration to Agentic. Deterministic AWS generation derives region, free-tier mode, instance sizing, storage, traffic, VPC/subnet/security-group, S3, and CloudFront values from the prompt and review answers.
4. Cost estimation and Stage 7 approval consume architecture/deployment context.
5. The Connector calls Terraform generation with project metadata, architecture/profile/approval payload, security data, source root, renderer selection, state settings, AWS settings, and optional LLM configuration.
6. The Agentic Layer selects a renderer and returns generated files, manifest, dependency order, warnings, workspace/run identity, and renderer metadata.

### Database-aware EC2 application deployment

The deployment packager inspects the source repository before rendering an EC2 application bundle. It detects a database from:

1. Prisma schema datasource.
2. Postgres/MySQL/MariaDB Docker Compose image.
3. Known ORM/database packages in `package.json`.
4. `DATABASE_URL` in a supported environment sample.

If a database is detected but the deployment profile did not request one, the EC2 renderer promotes the profile to a small RDS configuration. Generated runtime environment variables include the Terraform-resolved database URL and connection fields. A deterministic per-project `JWT_SECRET`, `NODE_ENV=production`, and application port are also injected.

PostgreSQL defaults to `16.6`. The RDS configuration model has expanded support for standard RDS and Aurora controls, including storage type/autoscaling, Multi-AZ, backup retention, deletion protection, public access, Aurora replica count, cluster storage type, and Serverless v2 capacity bounds.

### Terraform apply and runtime operations

1. The dashboard submits generated files/run metadata, AWS credentials, region, and free-tier/plan-confirmation flags to the Connector.
2. The Connector sends the trusted request to Agentic, which starts Terraform execution and exposes status/stop paths.
3. The user confirms the plan summary before a guarded apply proceeds.
4. Runtime details call AWS APIs for project-tagged or specifically selected resources. The dashboard can start, stop, or reboot a target EC2 instance.
5. Runtime destruction is a best-effort cleanup of DeplAI-tagged EC2 instances, key pairs, available volumes, S3 buckets, CloudFront distributions, and security groups. CloudFront distributions may need asynchronous disablement before deletion.

## Deployment concerns

### Required configuration

The core configuration is in `.env.template`.

| Variable | Used by | Why it matters |
| --- | --- | --- |
| `DEPLAI_SERVICE_KEY` | Connector + Agentic | Authenticates internal API calls. Required for Agentic startup. |
| `WS_TOKEN_SECRET` | Connector + Agentic | Signs/verifies short-lived project-bound WebSocket tokens. |
| `SESSION_SECRET` | Connector | Encrypts browser session data. Required in production. |
| `NEXT_PUBLIC_APP_URL` | Connector OAuth | Canonical origin and OAuth callback base. |
| `AGENTIC_LAYER_URL` | Connector | Internal Agentic HTTP base; Compose default is `http://localhost:8001`. |
| `DB_*` | Connector | MySQL connection. |
| `GITHUB_CLIENT_*` | Connector | GitHub OAuth login. |
| `GITHUB_APP_*` | Connector | GitHub App installation/repository operations. |
| `AWS_*` | Agentic/Terraform | AWS cost, plan, apply, and runtime operations. |
| `CUSTOMIZATION_AGENT_BASE_URL` | Connector | Optional customization backend base URL. |

### Docker requirements

The Agentic container mounts `/var/run/docker.sock`. This gives it high privilege over the Docker daemon and is necessary for the current scanner/runtime workflow. Treat the host and Agentic service as a trusted execution boundary; do not expose the Agentic port publicly without network protection.

### Observability

- `GET /ready` confirms FastAPI readiness.
- `GET /health` reports Docker reachability and optional dependency checks.
- Connector `GET /api/pipeline/health` exposes Agentic health to authenticated dashboard clients.
- Scan/remediation/pipeline WebSockets emit status and timestamped message frames.
- Terraform runs retain state, generated files, warnings, diagnostics, logs, plan summaries, outputs, and errors in their run context.

### Destructive operations

`POST /api/cleanup` on the Agentic Layer removes all Docker volumes only when `ALLOW_GLOBAL_CLEANUP=true`. This is global across projects and should be disabled in normal production operation. Project deletion and runtime destruction are separate, ownership-checked pathways.
