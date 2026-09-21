# DeplAI Build product contract

Status: Phase 0 complete; Phase 0.5 implemented with live MySQL validation pending;
Phase 1 canonical contracts implemented at the user's explicit request.
Phase 1.5 adds encrypted secret storage, metadata-only user entry and a tested
runtime resolver contract; live SQL/browser validation and preview wiring remain pending.
Phase 2 adds private, non-executing GitHub/ZIP ingestion and deterministic repository
maps. See [ingestion](INGESTION.md) for revision semantics, limits and unsupported inputs.
Phase 3 adds read-only deterministic repository profiling with path-grounded evidence,
confidence, explicit unknowns and byte fingerprints; see [profiler](PROFILER.md).
This is the implementation contract for DeplAI Build;
the root `deplai_build_master_plan.md` specifies the complete phased roadmap.
Later phases must update this contract when they change an implemented boundary.

## Product boundary

DeplAI Agent is the navigation label. DeplAI Build is the full-stack web builder
inside its Agents workspace. Its boundary is
`NEW_PROJECT | IMPORT_REPOSITORY -> READY_TO_DEPLOY`.
Production deployment is a separate, explicitly approved handoff to the existing
deployment product. This product does not execute Terraform or deploy to AWS.

Entry modes:

- `NEW_PROJECT`: interpret a product request and build a full-stack web application.
- `IMPORT_REPOSITORY`: understand an exact existing revision and extend it under
  `PRESERVE_EXISTING`. Preserve frameworks, layout, business logic, migrations,
  integrations and design unless a requested change requires a reviewed migration.

## Lifecycle

| State | Meaning |
| --- | --- |
| DRAFT | Scoped intent recorded; execution has not started. |
| ANALYZING | Product or repository evidence is being gathered. |
| PLANNING | Architecture and implementation tasks are being reviewed. |
| BUILDING | Authorized implementation tasks are executing. |
| PREVIEW_STARTING | Required preview services are being prepared. |
| PREVIEW_READY | Required services are healthy on the recorded revision. |
| VERIFYING | Frozen revision is under independent acceptance verification. |
| WAITING_FOR_USER | Clarification, review or approval is required. |
| READY_TO_DEPLOY | All readiness evidence and user review are satisfied. |
| FAILED | The run failed with a persisted reason. |
| CANCELLED | Cancellation has been observed and resources reconciled. |

Phase 0.5 defines these states in the MySQL BuildSession migration and implements
deterministic transition guards. LLM output must never directly assign state. In particular, analysis
cannot jump to preview readiness, and preview readiness alone cannot authorize
deployment. Failures and cancellation preserve ordered state events. Transitions
to PREVIEW_READY and READY_TO_DEPLOY currently fail closed until trusted preview
and verification adapters are implemented; caller-supplied booleans cannot unlock them.

## Invariants

1. Preview means the actual required frontend, API, database, authentication and
   optional workers/resources operating together; no mock or screenshot completion.
2. Imported architecture is preserved by default; migration requires explicit review.
3. Imported and generated code is untrusted. Never execute it on the host or in
   an existing trusted worker with the host Docker socket or credentials.
4. Preview receives an explicit environment allowlist, scoped secrets and resource
   quotas. Host identity, metadata, internal services and sibling previews are denied.
5. Secrets are references in artifacts; raw values never enter source, logs or prompts.
6. `previewed_revision == verified_revision == handoff_revision` at readiness.
7. Readiness requires product acceptance, architecture checks, healthy full-stack
   preview, mandatory tests, migration validation, no security blockers, valid runtime
   and secret contracts, applicable packaging, and a valid BuildReadinessManifest.
8. A fresh verifier uses a frozen rubric and revision, not builder self-evaluation.
9. Repairs begin at a reversible checkpoint or isolated worktree.
10. Every mutable resource belongs to owner, organization, project and BuildSession.

## Ownership and integration map

| Concern | Current source and reuse decision |
| --- | --- |
| Entry route | `Connector/src/app/dashboard/agents/page.tsx`: server session check; redirects unauthenticated users. |
| Navigation | `Connector/src/features/workspace/WorkspaceNav.tsx`: shared desktop/mobile/search entry opens a new browser tab. |
| Build presentation | `Connector/src/features/deplai-build/`: isolated feature boundary, using existing workspace styles. |
| Authentication | `Connector/src/lib/auth.ts`, `session.ts`: existing GitHub identity and session authority. |
| Tenancy | `Connector/src/lib/organizations/`: reuse active membership and project permissions for every future Build API. |
| Persistence | `Connector/src/lib/db.ts`, `Connector/migrations/20260920_build_sessions.sql`: BuildSessions, scoped resources and ordered state events. Existing workflow sessions are not BuildSessions. |
| Repository access | `Connector/src/lib/github.ts`, `project-meta.ts`, `uiux/git-source-index.ts`: authorized repository reads, revision/path evidence and on-demand blobs. Audit before reuse for Build ingestion. |
| File boundaries | `Connector/src/lib/local-projects.ts`, `uiux/snapshots.ts`: existing containment/snapshot patterns; do not assume existing upload handling proves safe Build ingestion. |
| Model gateway | `Connector/src/lib/ai-platform/`, `Agentic Layer/ai_gateway.py`: existing routing, credentials and metering authority. No direct provider SDK in Build. |
| Agent orchestration | `Agentic Layer/agent/remediation_workflow.py`, `uiux-agent/service/deep_agent_app.py`: reference for checkpoint/tool patterns; their security-remediation and presentation-only contracts are not Build execution paths. |
| Streaming | `Connector/src/lib/agentic-websocket.ts`, `scan-context.tsx`, `Agentic Layer/scan_jobs.py`: examples of scoped transport and replay. Build will need its own durable ordered events. |
| Preview | Customization has its own preview flow. It does not prove whole-stack sandbox isolation; no shared production preview execution is enabled here. |
| Tests | Connector organization, AI-platform, deployment and WebSocket tests; worker suites remain independently owned. |

Build server code lives under `Connector/src/lib/deplai-build/`. Future APIs should
live under `Connector/src/app/api/build/`, introduced only with the relevant phase. The isolated
execution provider is a separate boundary, not an extension of the host-trusted
Agentic Docker runner. No service, database, container or API has been provisioned
by Phase 0.

## Model and commercial prerequisite

The requested primary agentic model is GLM-5.3. This is a product requirement, not
a verified provider model ID. Before model execution is introduced, verify live
availability, capabilities, pricing, provider configuration and explicit cost
authorization through the Connector gateway. Never substitute a model silently
or change the existing free-only security remediation policy.

## Phase gates and current status

Phase 0 adds only documentation and an authenticated workspace shell. Both entry
actions explain why they are unavailable. No prompts are submitted, repositories
imported, sessions created, models called, user code executed or readiness claimed.
Existing services keep their current routes and policies.

Phase 0.5 adds the internal persistence repository, migration runner, guards,
ownership registry, validated quota snapshot and non-executing sandbox contract.
See [threat model](THREAT_MODEL.md) for implemented controls and future enforcement
requirements. Local Docker is trusted development only; gVisor is the production
preview target. No Build APIs or runnable providers are exposed. New projects must
first obtain a real organization-scoped project record through an authorized future
entry flow. Live SQL validation is required before marking Phase 0.5 passed.
Phase 1's pure data contracts proceeded independently under the user's explicit
instruction; see [canonical artifacts](ARTIFACT_CONTRACTS.md). This does not complete
the pending SQL gate or authorize runtime execution. Follow subsequent acceptance
boundaries in the master plan.

See [Build secrets](SECRETS.md) for dedicated credential entry, storage, audit and
the runtime-only resolution boundary. No agent receives plaintext through normal tools.

Phase 4 adds the internal [semantic repository analyst](SEMANTIC_ANALYST.md), with
bounded revision-bound context, exact GLM-5.3 routing and validated repository YAML.
It introduces no public execution endpoint. Live semantic acceptance and trusted
paid-run authorization/persistence composition remain prerequisites; see the
[Phase 4 result](PHASE_4_RESULT.md).

Phase 5 adds [runtime inference](RUNTIME_INFERENCE.md). Its outputs are reviewable
metadata with explicit revision identity and unresolved-startup blockers. Phase 5.5
adds the [synthetic gVisor proof harness](../../deploy/preview-proof/README.md);
configuration or unit-test success alone cannot satisfy its live isolation gate.
