# DeplAI technical architecture

This is a Level-1 view of the implementation in this repository. It separates
the browser-facing control plane from the trusted execution plane, then explains
the frameworks, boundaries, and data that make the workflow work.

For the product rationale, start with the [product overview](product-overview.md).
For the internals of each agent and workflow graph, see the
[agent architecture](agent-architecture.md).

## Level-1 architecture

```text
                                      GitHub
                           OAuth / App / repositories / PRs
                                        ^
                                        |
Browser -- HTTPS ------------------+---+-----------------------------+
                                  |                                 |
                                  v                                 |
                    +---------------------------+                  |
                    | Connector                 |                  |
                    | Next.js control plane     |------------------+
                    | UI, session, ownership,   |
                    | project/API facade        |                  |
                    +------------+--------------+                  |
                         |       |                                 |
               MySQL <---+       | X-API-Key                       |
                                 v                                 |
                    +---------------------------+                  |
                    | Agentic Layer             |                  |
                    | FastAPI execution plane   |                  |
                    | scans, planning, IaC,     |                  |
                    | AWS operations            |                  |
                    +-----+---------------+-----+                  |
                          |               |                        |
                    Docker workers    AWS APIs / Terraform          |
                    scan, remediation,  state, runtime              |
                    Terraform          infrastructure               |

Connector -- authenticated proxy --> Customization backend
                              FastAPI + LangGraph
                              manifest, edits, preview, snapshots
```

In production, Caddy is the only public ingress. It forwards normal application
traffic to the Connector and authenticated Agentic WebSockets under
`/agentic/ws/*`; MySQL and the internal services remain on the Docker network.
Local `compose.yaml` exposes the Connector and Agentic Layer for development.

## Architectural responsibilities

| Layer | Primary responsibility | Why it is separated |
| --- | --- | --- |
| Browser | Landing page, dashboard, project selection, review, and live workflow status. | Users interact with one workspace without receiving service credentials. |
| Connector | Authentication, authorization, project/repository ownership, GitHub access, MySQL persistence, local-project storage, and API adaptation. | Keeps browser traffic and ownership checks at a small, auditable boundary. |
| Agentic Layer | Long-running scan/remediation flows, repository analysis, architecture/cost flows, Terraform orchestration, and AWS operations. | Isolates Docker and cloud-capable work from the public web application. |
| Terraform Agent package | Bundle rendering, component registry, state/run handling, locking, validation, Terraform execution helpers, and deployment profiles. | Gives IaC a dedicated contract and execution model instead of emitting opaque text directly from a UI request. |
| Customization backend | Tenant manifest conversation, scoped repository changes, preview lifecycle, assets, snapshots, and quality gates. | Keeps mutable tenant work behind Connector authorization and separate from the delivery plane. |
| External systems | GitHub, Docker Engine, AWS, and optional LLM providers. | Retain their own credentials, audit surfaces, and failure modes. |

## Frameworks and implementation choices

| Area | Frameworks / services used | Benefit in this design |
| --- | --- | --- |
| Web control plane | Next.js 16 App Router, React 19, TypeScript, Tailwind CSS | Server-side API routes and a single typed dashboard for the workflow. |
| Identity and source control | `iron-session`, Octokit / GitHub App auth, `simple-git` | Encrypted browser sessions plus scoped GitHub installation tokens, repository sync, and PR creation. |
| Relational persistence | MySQL 8.4 through `mysql2` | Stores users, GitHub installations and repositories, projects, chat sessions/messages, and settings. |
| Execution API | FastAPI, Pydantic, Uvicorn, Python 3.13 image | Typed internal request contracts and asynchronous HTTP/WebSocket workflows. |
| Agent workflows | LangGraph, with LangChain components where required | Explicit state graphs, conditional routing, and inspectable stages rather than an unstructured agent loop. |
| Cloud and containers | Docker SDK, Boto3, Terraform 1.9 container | Runs scanners and Terraform in short-lived workers and uses AWS APIs for runtime operations. |
| IaC | Terraform AWS provider constrained to `~> 5.100.0`; curated exact-pinned registry modules and golden snippets | Reduces provider/module drift and constrains generated output to a known component surface. |
| Tenant customization | FastAPI, LangGraph, Pillow, optional project LLM configuration | Separates source scanning, planning, mutation, validation, previews, and assets. |
| Edge / deployment | Docker Compose and Caddy | One private service network in production, TLS termination, compression, and a narrow public ingress. |

The production compose file also starts Neo4j and Qdrant. A repository-wide code
search currently finds no application-level runtime client usage for either, so
they should be treated as provisioned platform dependencies rather than an
active knowledge-graph or vector-search feature.

## Core product flow

```text
project source
  -> ownership-checked Connector request
  -> Agentic repository/scan workflow
  -> structured context + review decisions + cost/approval
  -> generated Terraform bundle
  -> plan summary
  -> explicit confirmation
  -> Terraform apply and AWS runtime operations
```

The same project identity is used to scope the UI, connector records, source
directory resolution, workflow status, and WebSocket progress. The detailed
agent transitions are documented in [agent architecture](agent-architecture.md).

## Data and artifact boundaries

| Data / artifact | Main location | Role |
| --- | --- | --- |
| Users, installations, repositories, projects, chat, settings | MySQL | Connector’s durable ownership and workspace metadata. |
| GitHub clones | `Connector/tmp/repos` or the `github_repos` volume | Source for connected repositories; mounted read-only into the Agentic Layer. |
| Local project uploads | `Connector/tmp/local-projects` or the `local_projects` volume | Source for ZIP-based projects; mounted read-only into the Agentic Layer. |
| Scan reports and worker data | Named Docker volumes plus Agentic runtime | Inputs and results for scanner/remediation execution. |
| Repository analysis and architecture decisions | Project workspace artifacts returned through Agentic contracts | Carry detected source facts, review answers, profile, and derived view into generation. |
| Terraform artifacts and run state | `runtime/terraform-agent`, `iac_workspaces`, and optional S3 snapshots | Preserve generated files, state, logs, plan/apply artifacts, and remote-run recovery data. |
| Terraform mutual exclusion | DynamoDB lock table when a remote backend is configured | Prevents more than one active run per workspace. |
| Sensitive apply outputs | AWS Secrets Manager references | Keeps sensitive Terraform outputs out of the public response payload. |
| Tenant state, previews, assets, snapshots | Customization state/log volumes | Keeps customization mutations and preview files separate from project metadata. |

## Security and control boundaries

### Browser to Connector

- GitHub OAuth creates an encrypted `iron-session` browser cookie.
- Protected Connector routes check the active session and project, repository,
  or installation ownership before accessing sources or taking action.
- The Connector owns GitHub App token creation; those tokens are not a browser
  capability.

### Connector to internal services

- Connector-to-Agentic HTTP calls use `X-API-Key` with
  `DEPLAI_SERVICE_KEY`; the key must never be exposed to the browser.
- Scan/remediation/pipeline WebSockets use a short-lived HMAC token bound to a
  user and project ID.
- The Connector proxies customization traffic only after resolving a
  user-owned project and source location.

### Execution and cloud operations

- Terraform apply requires an explicit plan-confirmation flag. It can use
  supplied credentials or the default AWS credential chain, and executes in a
  temporary Docker volume.
- The runtime stores public outputs separately from sensitive outputs, which are
  written to AWS Secrets Manager by the Terraform apply path.
- Runtime destroy targets resources tagged for the named DeplAI project; it is
  still destructive and best-effort, so AWS-side verification is necessary.
- `POST /api/cleanup` is globally destructive and is disabled unless
  `ALLOW_GLOBAL_CLEANUP=true`.

### Important operational constraint

The current Agentic Layer mounts `/var/run/docker.sock` to create scanner,
remediation, and Terraform worker containers. Docker-socket access is
effectively host-administrator access. The production deployment is suitable
for trusted teams and repositories; executing arbitrary untrusted repositories
requires an isolated worker design outside the current implementation.

## Availability, progress, and recovery

- Long-running scan and remediation workflows send WebSocket events and retain
  status/results for REST recovery if the browser disconnects.
- Terraform generation and apply publish project-bound pipeline events; apply
  has status and stop endpoints and tracks an active container for cancellation.
- Terraform worker commands use timeouts, temporary Docker volumes, streamed
  JSON output, diagnostic extraction, and an attempted force-unlock when an
  interrupted plan/apply leaves a local lock record.
- Local Terraform artifacts can be uploaded to and reloaded from the configured
  S3 state bucket; workspace locking is backed by DynamoDB.
- The Connector gives upstream Agentic calls bounded timeouts and user-facing
  unavailable/timeout messages instead of treating an internal failure as a
  successful action.

## Deployment topology and lifecycle

| Environment | Start point | Public surface | Notes |
| --- | --- | --- | --- |
| Local | `docker compose up --build` | Connector `:3000`, Agentic Layer `:8000` | Starts MySQL, Connector, Agentic Layer, and customization backend with local-only defaults. |
| Agentic development | `docker-compose.dev.yml` | Agentic Layer `:8001` | Focused development service configuration. |
| Production | `docker-compose.production.yml` with `deploy/.env` | Caddy `:80` / `:443` | Caddy is the sole public service; Connector, Agentic, customization, MySQL, Neo4j, and Qdrant are private. |

See [deploy/README.md](../deploy/README.md) for production host preparation,
backup expectations, TLS, and the Docker trust-boundary warning.

## Current architectural boundaries

- AWS is the implemented deploy/apply and runtime provider. Azure and GCP are
  represented in natural-language architecture generation and cost estimation,
  not in the Terraform execution path.
- The repository contains an older standalone Terraform LangGraph workflow and
  a newer deployment-profile/multi-worker path. Both are documented because
  both are implemented; the Agentic Layer’s Terraform endpoint uses the newer
  `generate_terraform_bundle` path.
- A fallback can preserve a supported workflow when an LLM worker or Stage 7
  subprocess is unavailable. It is not an authorization bypass and does not
  imply that all requested infrastructure shapes are supported.
