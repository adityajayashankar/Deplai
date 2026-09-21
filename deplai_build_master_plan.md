# Deplai Build — Master Product Build Plan and Phased Coding-Agent Prompts

**Status:** Product build specification  
**Target:** Initial full-stack web application builder  
**Primary agentic model:** GLM-5.3  
**Product boundary:** `NEW_PROJECT | IMPORT_REPOSITORY -> READY_TO_DEPLOY`  
**Deployment:** Explicitly outside this product; handed off only after readiness is verified.

---

## 1. Product Definition

Deplai Build is an Emergent-style autonomous full-stack application builder that will eventually sit inside Deplai, but this document treats it as its own product with a clean boundary.

The product must support two equally important entry paths:

1. **Create New** — a user describes a software product in natural language and Deplai Build turns that into a working full-stack web application.
2. **Import Existing Repository** — a user imports an existing codebase; Deplai Build reconstructs its architecture and runtime, starts the complete application, and continues development without gratuitously rewriting the existing stack.

The product is complete for a project only when the application reaches `READY_TO_DEPLOY`.

### 1.1 North-star flow

```text
NEW PROJECT                         IMPORT REPOSITORY
     |                                      |
     v                                      v
Product Understanding              Repository Understanding
     |                                      |
     +------------------+-------------------+
                        v
                System Architecture
                        |
                        v
             Capability Determination
                        |
        +---------------+----------------+
        |               |                |
        v               v                v
   Frontend/API      DB/Auth         Optional Systems
                                    cache / queue /
                                    workers / realtime /
                                    storage / search /
                                    AI / integrations
                        |
                        v
                Implementation Graph
                        |
                        v
               Specialist Engineering
                        |
                        v
                 FULL-STACK PREVIEW
                        |
              +---------+---------+
              |                   |
              v                   v
         User Interaction       Automated QA
              |                   |
              +---------+---------+
                        v
                     Repair
                        |
                        v
                   Verification
                        |
                        v
                 User Approval Loop
                        |
                        v
                READY_TO_DEPLOY
```

### 1.2 What full-stack live preview means

Live preview is the defining capability. It is **not** a screenshot, frontend-only iframe, mocked API, or source-code preview.

If the user's application architecture contains:

```text
Frontend
Backend/API
PostgreSQL
Redis
Background Worker
Queue
Object Storage
WebSockets
```

then those required components must actually function together inside the temporary preview environment.

The user must be able to use the preview like a real application:

- sign up and sign in;
- create and edit records;
- persist data;
- call real APIs;
- upload files;
- trigger asynchronous jobs;
- observe worker results;
- receive realtime events;
- test role permissions;
- traverse multiple pages;
- interact with the complete workflow.

Preview is temporary development runtime. It is not production deployment.

### 1.3 Architecture intelligence principle

The system architect has freedom to choose technologies, but it must choose the **simplest architecture that satisfies the user's requirements**.

A yoga marketing website must not receive Kafka, Redis, workers, Kubernetes, or microservices merely because they exist.

A high-volume event-processing system may genuinely require Kafka, multiple consumers, idempotency, event retention, and workers.

Every optional architecture component must therefore contain:

- selected / not selected;
- selected technology;
- requirement that caused the decision;
- alternatives considered;
- reasons alternatives were rejected;
- implementation complexity impact;
- preview complexity impact;
- expected operating-cost implications.

### 1.4 Imported repositories are sacred

For `IMPORT_REPOSITORY`, the default policy is `PRESERVE_EXISTING`.

Deplai Build must preserve:

- framework choices;
- repository layout;
- business logic outside the requested change;
- working integrations;
- package conventions;
- migration history;
- design language unless redesign is requested;
- service boundaries unless the requested feature requires change.

A system architect may propose an architectural migration only when:

1. the user explicitly requests it, or
2. the current architecture cannot satisfy the requested requirement and the conflict is surfaced for approval.

The builder must never silently turn an imported Vue/Nest/Mongo/RabbitMQ application into Next/FastAPI/Postgres/Redis.

### 1.5 Initial scope

The first product version targets **full-stack web applications**.

Not initial scope:

- native mobile generation;
- desktop apps;
- production deployment implementation;
- every programming language/framework;
- every cloud service;
- arbitrary infrastructure migration.

The product should be designed to extend later without weakening the full-stack web objective.

---

## 2. Core Product Principles

These rules apply to every phase and every coding-agent prompt in this document.

### 2.1 Work on one phase only

A coding agent must implement only the requested phase.

Do not implement future phases because they appear useful.

Do not redesign unrelated modules.

When the phase passes its acceptance gate, stop.

### 2.2 Inspect before editing

Before changing code:

1. inspect repository structure;
2. identify existing implementation related to the phase;
3. identify current conventions;
4. identify reusable code;
5. identify tests;
6. identify existing contracts;
7. determine the smallest safe change.

Never invent paths without inspection.

### 2.3 Deterministic systems before LLM guessing

Use deterministic software for:

- schema validation;
- process startup;
- file access;
- framework/package detection;
- Git revision tracking;
- permissions;
- health checks;
- service routing;
- test execution;
- migration execution;
- scanner execution;
- quota enforcement;
- state transitions.

Use GLM-5.3 for ambiguity and engineering reasoning:

- product interpretation;
- architecture;
- implementation planning;
- code implementation;
- debugging;
- UX reasoning;
- review;
- semantic repository understanding.

### 2.4 No fake completion

An agent does not declare its own work complete merely because files were written.

Completion must be proven through relevant evidence such as:

- compilation;
- type checking;
- migrations;
- process health;
- API responses;
- browser interaction;
- worker execution;
- database state;
- automated tests;
- security checks;
- independent verification.

### 2.5 Structured contracts over conversational memory

Important decisions live in versioned artifacts, not only chat history.

### 2.6 User code is untrusted

Imported and generated code must be treated as potentially malicious.

Never execute it directly on the host.

### 2.7 Exact revision integrity

The source revision being previewed, tested, verified, and handed off must always be explicitly identifiable.

The invariant is:

```text
verified_revision == previewed_revision == handoff_revision
```

when the application reaches `READY_TO_DEPLOY`.

### 2.8 Preview does not inherit host identity

A preview environment never automatically inherits:

- host environment variables;
- host credentials;
- cloud instance identity;
- host network access;
- sibling preview access;
- internal Deplai services.

### 2.9 No plaintext secrets in source

Secrets are references and runtime injections, not values written into code or `.deplai` artifacts.

### 2.10 Every risky operation is bounded

Every build session needs configurable limits for:

- CPU;
- memory;
- disk;
- PIDs;
- preview lifetime;
- idle time;
- concurrent agent sessions;
- browser sessions;
- model tokens;
- tool calls;
- repair loops.

### 2.11 Independent verification

The final verifier uses a fresh model session, a frozen acceptance rubric, and the frozen preview revision.

It does not receive builder chain-of-thought or self-evaluation.

### 2.12 Git before self-healing

Every repair attempt starts from a reversible checkpoint or isolated worktree.

---

## 3. Canonical Application Artifacts

Every project workspace has a `.deplai/` directory.

```text
.deplai/
  product.yaml
  repository.yaml
  architecture.yaml
  runtime.yaml
  preview.yaml
  secrets.schema.yaml
  session.yaml
  task-graph.json

  design/
    system.yaml
    routes.yaml
    pages.yaml
    interactions.yaml

  database/
    schema.yaml
    migrations.yaml

  api/
    openapi.yaml

  analytics/
    kpis.yaml
    events.yaml

  testing/
    acceptance.yaml
    test-plan.yaml

  security/
    threat-model.yaml
    report.yaml

  verification/
    report.yaml

  build/
    status.json
```

Every contract must carry a `schema_version`.

### 3.1 `product.yaml`

Represents:

- product purpose;
- users/personas;
- roles;
- features;
- user journeys;
- business rules;
- pages;
- domain entities;
- integrations;
- KPIs;
- non-functional requirements;
- acceptance criteria;
- assumptions.

### 3.2 `repository.yaml`

Represents the current state of an imported repository:

- frameworks;
- modules;
- services;
- APIs;
- DB;
- auth;
- workers;
- queues;
- jobs;
- storage;
- integrations;
- service relationships;
- confidence/evidence.

### 3.3 `architecture.yaml`

Represents the desired architecture:

- architectural style;
- frontend;
- backend;
- APIs;
- DB technology;
- cache;
- queue/event system;
- workers;
- schedulers;
- realtime;
- object storage;
- search;
- vector storage;
- AI systems;
- auth/RBAC;
- external integrations;
- container/runtime needs;
- architectural decision justifications.

### 3.4 `runtime.yaml`

Represents the runnable application topology.

Example:

```yaml
schema_version: 1

services:
  web:
    type: frontend
    framework: nextjs
    directory: apps/web
    install: pnpm install
    dev: pnpm dev
    build: pnpm build
    port: 3000
    public: true
    dependencies:
      - api

  api:
    type: backend
    framework: fastapi
    directory: apps/api
    install: pip install -r requirements.txt
    dev: uvicorn main:app --reload --host 0.0.0.0 --port 8000
    port: 8000
    dependencies:
      - primary-db
      - cache

  email-worker:
    type: worker
    directory: apps/workers/email
    command: python worker.py
    dependencies:
      - primary-db
      - cache

resources:
  primary-db:
    type: postgres

  cache:
    type: redis

routes:
  - path: /
    target: web
  - path: /api
    target: api
```

### 3.5 `preview.yaml`

Represents temporary preview behavior:

- public origin;
- routing;
- active worktree/revision;
- isolation profile;
- network policy;
- hot reload;
- cookie strategy;
- WebSocket requirements;
- SSE requirements;
- health requirements;
- resource limits;
- idle TTL;
- hard TTL.

### 3.6 `secrets.schema.yaml`

Contains metadata only:

- secret identifier;
- human name;
- purpose;
- required/optional;
- scope;
- classification;
- consuming services;
- required for preview?;
- required for deployment?;
- configured status.

Raw values never appear in this artifact.

### 3.7 `task-graph.json`

Each task includes:

- ID;
- objective;
- specialist;
- dependencies;
- read paths;
- write paths;
- required skills;
- required tools;
- expected artifacts;
- acceptance criteria;
- verification commands;
- rollback boundary.

---

## 4. Mandatory Coding-Agent Completion Format

Every phase prompt ends with this required response.

```text
PHASE RESULT

Status: PASS | PARTIAL | FAIL

IMPLEMENTED
- exact capabilities added

FILES CHANGED
- exact paths

TESTS EXECUTED
- exact commands
- exact results

ACCEPTANCE CRITERIA
- criterion -> PASS | FAIL

SECURITY / ISOLATION EVIDENCE
- required from preview-related phases onward

SECRET HANDLING EVIDENCE
- required from secret/preview phases onward

QUOTA / RESOURCE EVIDENCE
- required from preview phases onward

REVISION EVIDENCE
- active Git SHA/worktree
- verified revision where applicable

KNOWN LIMITATIONS
- intentional unsupported behavior

REGRESSIONS CHECKED
- existing behavior confirmed

NEXT PHASE PREREQUISITES
- only facts the next phase must know
```

An agent must not return PASS if a mandatory acceptance criterion is failing.

---

# PHASED IMPLEMENTATION PROMPTS

---

# Phase 0 — Product Boundary and Codebase Discovery

## Paste this prompt into the coding agent

### OBJECTIVE

Establish the Deplai Build product boundary in the existing codebase before implementing product functionality.

This phase is discovery, documentation, and minimal scaffolding only.

### CONTEXT

Deplai Build is an Emergent-style full-stack web application builder. It supports `NEW_PROJECT` and `IMPORT_REPOSITORY`, provides a whole-stack live preview, supports iterative modification, testing, verification, and stops at `READY_TO_DEPLOY`.

Production deployment is outside this product.

### REQUIRED WORK

1. Inspect the repository thoroughly.
2. Identify current frontend/backend conventions relevant to adding this product.
3. Identify existing modules for:
   - routing;
   - persistence;
   - authentication identity;
   - file handling;
   - Git/repository handling;
   - model/provider abstraction;
   - agentic code;
   - streaming/SSE/WebSockets;
   - shared UI components;
   - tests.
4. Create `docs/deplai-build/PRODUCT_CONTRACT.md`.
5. Define product states:
   - DRAFT
   - ANALYZING
   - PLANNING
   - BUILDING
   - PREVIEW_STARTING
   - PREVIEW_READY
   - VERIFYING
   - WAITING_FOR_USER
   - READY_TO_DEPLOY
   - FAILED
   - CANCELLED
6. Document two entry modes:
   - NEW_PROJECT
   - IMPORT_REPOSITORY
7. Document invariants:
   - preview is full-stack;
   - import preserves existing architecture by default;
   - deployment begins only after READY_TO_DEPLOY;
   - code running in preview is untrusted;
   - preview/test/handoff revisions must match.
8. Create the smallest clean module/package boundary for Deplai Build if none exists.

### OUT OF SCOPE

Do not build:

- agents;
- preview runtime;
- container runtime;
- repository import;
- DB/resource adapters;
- production deployment;
- MCP.

### TESTS

Run all existing relevant tests after scaffolding.

### ACCEPTANCE CRITERIA

- Product contract exists and is authoritative.
- Code ownership boundary is clear.
- Product lifecycle is documented.
- No speculative implementation of later phases.
- Existing application behavior remains unchanged.

STOP after this phase.

---

# Phase 0.5 — Threat Model, BuildSession, Tenancy, and Host Boundary

## Paste this prompt into the coding agent

### OBJECTIVE

Create the durable state and security boundary required before any imported/generated code is executed.

### THREAT MODEL

Treat user code as potentially malicious.

Document and design defenses for:

- malicious imported repository;
- malicious generated code;
- package lifecycle scripts;
- arbitrary shell execution;
- filesystem traversal;
- secret theft;
- SSRF;
- cloud metadata access;
- internal-network probing;
- sibling-preview access;
- cross-user access;
- resource exhaustion;
- fork bombs;
- disk exhaustion;
- malicious uploads;
- dependency/supply-chain behavior.

### BUILDSESSION

Introduce a durable BuildSession entity/model containing at minimum:

- session_id;
- owner_user_id;
- project_id;
- source_type;
- source_revision;
- state;
- active_worktree_id;
- active_preview_revision;
- preview_id;
- secret_scope_id;
- quota_profile_id;
- created_at;
- updated_at;
- last_activity_at;
- failure_reason.

### STATE MACHINE

Implement state-transition guards in code.

LLMs must never be able to directly assign session state.

Examples:

- DRAFT -> ANALYZING allowed.
- ANALYZING -> PREVIEW_READY invalid.
- PREVIEW_STARTING -> PREVIEW_READY requires a healthy preview.
- VERIFYING -> READY_TO_DEPLOY requires readiness validation.

### TENANCY

Every mutable resource created by this product belongs to one owner/project/BuildSession scope.

Resource ownership includes:

- workspace;
- worktree;
- preview;
- generated DB;
- Redis/resource instances;
- worker processes;
- secrets;
- logs;
- artifacts;
- browser sessions.

### SANDBOX PROVIDER CONTRACT

Create a provider abstraction for untrusted runtime isolation.

Design for:

- LocalDockerSandbox — local/trusted development only;
- GVisorSandbox — target production preview isolation;
- Future FirecrackerSandbox — stronger isolation later.

Do not hard-code the entire product to one sandbox technology.

### REQUIRED SANDBOX CONTROLS

Provider configuration must support:

- CPU limit;
- memory limit;
- disk limit;
- PID limit;
- execution timeout;
- idle timeout;
- hard lifetime;
- network policy;
- environment allowlist.

### NETWORK POLICY

Default deny access to:

- host network;
- sibling previews;
- private/internal services;
- cloud metadata endpoints;
- private address ranges unless explicitly required by preview resources.

Outbound public Internet access must be policy controlled.

### ENVIRONMENT

Preview environments must not inherit the host process environment.

### OUT OF SCOPE

Do not execute user code yet.

### TESTS

Add tests for:

- valid/invalid state transitions;
- resource ownership checks;
- BuildSession isolation;
- no host-environment inheritance;
- quota-profile validation.

### ACCEPTANCE CRITERIA

- Durable BuildSession exists.
- Transition guards are deterministic.
- Session/resource ownership exists.
- Sandbox provider interface exists.
- GVisor is the target production-preview provider.
- Host environment is not inherited by default.
- No user app code has been executed.

STOP.

---

# Phase 1 — Canonical Application Contracts

## Paste this prompt into the coding agent

### OBJECTIVE

Implement the versioned `.deplai` contracts that all future agents and preview subsystems will use.

### REQUIRED STRUCTURE

Create schema definitions and helpers for:

```text
.deplai/
  product.yaml
  repository.yaml
  architecture.yaml
  runtime.yaml
  preview.yaml
  secrets.schema.yaml
  session.yaml
  task-graph.json
  design/
  database/
  api/
  analytics/
  testing/
  security/
  verification/
  build/
```

### REQUIREMENTS

All primary contracts require `schema_version`.

Implement deterministic parsers/validators.

#### product.yaml

Support:

- purpose;
- users;
- roles;
- features;
- journeys;
- pages;
- business rules;
- domain entities;
- integrations;
- KPIs;
- assumptions;
- non-functional requirements;
- acceptance criteria with stable IDs.

#### architecture.yaml

Support optional components:

- frontend;
- backend;
- database;
- cache;
- queue/event system;
- workers;
- scheduler;
- realtime;
- storage;
- search;
- vector store;
- AI systems;
- auth/RBAC;
- integrations.

Every optional architecture decision supports:

- selected;
- technology;
- reason;
- alternatives;
- rejection reasons;
- complexity/cost notes.

#### runtime.yaml

Support service classes:

- frontend;
- backend;
- worker;
- scheduler;
- supporting-service.

Support resource classes:

- postgres;
- mongodb;
- redis;
- queue;
- object-storage;
- search;
- vector-store.

Each service supports:

- directory;
- install command;
- dev command;
- build command;
- production command;
- port;
- public/private;
- dependencies;
- health check;
- required environment keys;
- secret references.

#### preview.yaml

Support:

- preview origin;
- routing rules;
- source revision/worktree;
- isolation profile;
- network policy;
- hot reload;
- WebSocket requirements;
- SSE requirements;
- cookie strategy;
- idle TTL;
- hard TTL;
- resource profile.

#### secrets.schema.yaml

Support metadata only:

- id;
- name;
- purpose;
- required;
- classification;
- scope;
- consumers;
- preview requirement;
- deployment requirement.

Secret classifications:

- SYSTEM_INTERNAL;
- USER_PROVIDED;
- GENERATED_PREVIEW;
- INTEGRATION;
- DEPLOYMENT_ONLY.

### VALIDATION

Reject:

- duplicate identifiers;
- missing dependencies;
- dependency cycles;
- invalid ports;
- unknown route targets;
- undefined secret references;
- unsupported schema version;
- malformed task graph.

### FIXTURES

Create at least:

1. frontend-only application;
2. Next.js + Postgres;
3. React + FastAPI + Postgres;
4. frontend + API + Postgres + Redis + worker;
5. queue-based architecture;
6. invalid dependency cycle;
7. invalid secret reference;
8. invalid preview route.

### ACCEPTANCE CRITERIA

All valid fixtures pass.
All invalid fixtures fail with actionable errors.
No LLM is needed for schema validation.

STOP.

---

# Phase 1.5 — Secrets Vault and Runtime Injection

## Paste this prompt into the coding agent

### OBJECTIVE

Implement secret metadata, secure storage abstraction, and preview-time injection without exposing plaintext secrets to agents or source code.

### SECRETSTORE INTERFACE

Implement operations equivalent to:

- createSecret;
- updateSecret;
- deleteSecret;
- getMetadata;
- listRequiredSecrets;
- resolveForRuntime.

Do not expose a generic unrestricted `listAllSecretValues` interface.

### STORAGE MODEL

Primary records store references/metadata, not plaintext secret values.

Use the approved encrypted secret-storage backend available in the codebase/environment.

### USER FLOW

Users supply integration/project credentials through a dedicated secret-entry interface.

Do not encourage credentials in chat.

### SOURCE REPRESENTATION

Generated source may read environment variables such as:

`STRIPE_SECRET_KEY`

but generated source must never contain the value.

Runtime manifests refer to opaque identifiers such as:

`secret://project/stripe-secret`

### AGENT VISIBILITY

By default an agent may know:

- the secret exists;
- its identifier;
- its type;
- whether configured;
- which service may consume it.

The agent does not receive the raw value.

### TOOL/INTEGRATION USAGE

Where a credentialed tool call is required, the trusted tool/integration layer resolves the reference and performs the call.

### PREVIEW INJECTION

At process start:

SecretStore -> runtime resolver -> authorized service process environment.

Only services listed as consumers receive the secret.

### GENERATED PREVIEW SECRETS

Support generated temporary credentials such as:

- JWT signing secret;
- session key;
- preview DB password.

These are scoped to the preview and must not silently become production credentials.

### AUDIT

Audit:

- reference ID;
- BuildSession;
- consumer service;
- category of use;
- timestamp.

Never log raw values.

### TESTS

- Agent normal tools cannot read plaintext secret.
- Authorized preview process receives secret.
- Unauthorized service does not receive it.
- Secret value never appears in Git diff.
- Secret value never appears in logs.

### ACCEPTANCE CRITERIA

All tests pass and raw secrets remain opaque to the agent layer.

STOP.

---

# Phase 2 — Safe Repository Ingestion

## Paste this prompt into the coding agent

### OBJECTIVE

Import existing applications safely without executing or modifying them.

### ENTRY SOURCES

Support clean abstractions for:

- Git repository URL;
- Git branch/ref;
- ZIP/archive upload where supported.

### REQUIRED METADATA

Record:

- source type;
- original URL where applicable;
- branch/ref;
- resolved commit SHA;
- repository root;
- import timestamp;
- VCS information.

### SECURITY

Defend against:

- archive path traversal;
- malicious symlinks;
- archive bombs where practical;
- files escaping workspace;
- accidental credential surfacing;
- automatic command execution.

### CRITICAL RULE

Repository ingestion must not run:

- npm install;
- pip install;
- make;
- Docker builds;
- package lifecycle scripts;
- repository-defined commands.

### REPOSITORY MAP

Produce deterministic initial map containing:

- directories;
- manifests;
- package manager files;
- config files;
- Docker files;
- `.env` templates;
- CI files;
- migrations;
- test directories;
- likely code roots.

### IMPORT POLICY

Mark imported projects with:

`architecture_policy: PRESERVE_EXISTING`

### TESTS

- normal Git repo;
- branch selection;
- monorepo;
- malformed URL;
- invalid ZIP;
- traversal attempt;
- symlink edge case;
- large reasonable repository.

### ACCEPTANCE CRITERIA

- Exact source revision recorded.
- Source remains byte-identical.
- No repository-defined code runs.
- Unsafe archive fixtures are rejected.

STOP.

---

# Phase 3 — Deterministic Repository Profiler

## Paste this prompt into the coding agent

### OBJECTIVE

Infer everything possible about an imported codebase without using an LLM.

### DETECT

- languages;
- frameworks;
- package managers;
- monorepo systems;
- build tools;
- test frameworks;
- ORMs;
- migration frameworks;
- DB clients;
- queue libraries;
- worker frameworks;
- realtime libraries;
- storage SDKs;
- Docker configuration;
- CI configuration;
- entrypoints;
- probable commands;
- probable ports;
- environment-key references.

### COMMON SOURCES

Inspect patterns in:

- package.json;
- pnpm-workspace.yaml;
- yarn.lock;
- turbo.json;
- nx.json;
- requirements.txt;
- pyproject.toml;
- poetry.lock;
- Pipfile;
- Dockerfile*;
- docker-compose*;
- Procfile;
- schema.prisma;
- drizzle config;
- alembic.ini;
- manage.py;
- pom.xml;
- build.gradle;
- Cargo.toml;
- `.env.example`;
- GitHub workflows.

### EVIDENCE

Every detection includes:

- value;
- confidence;
- source path;
- field/pattern responsible.

### UNKNOWN

Use `UNKNOWN` when evidence is insufficient.

Do not make architecture recommendations.

### ACCEPTANCE CRITERIA

Create fixtures covering at least:

- Next.js;
- React/Vite;
- Express/Nest;
- FastAPI;
- Django;
- Next + FastAPI monorepo;
- Redis worker app;
- Docker Compose app.

Output is deterministic across repeated runs.

STOP.

---

# Phase 4 — Semantic Repository Analyst

## Paste this prompt into the coding agent

### OBJECTIVE

Use GLM-5.3 to turn deterministic repository evidence into a coherent CURRENT-STATE software model.

### INPUT

Provide only relevant context:

- deterministic repository profile;
- repository map;
- selected config files;
- selectively retrieved source files.

Do not blindly submit the whole repository.

### DETERMINE

- application purpose;
- domain modules;
- service boundaries;
- frontend;
- backend;
- API structure;
- DB usage;
- auth/session model;
- roles;
- queues;
- workers;
- scheduled jobs;
- WebSockets/SSE;
- object storage;
- integrations;
- test strategy;
- runtime relationships.

### OUTPUT

Generate `.deplai/repository.yaml`.

### EVIDENCE AND CONFIDENCE

Every significant finding should include evidence paths and confidence.

If interpretation is uncertain, preserve uncertainty rather than fabricating certainty.

### IMPORT PROTECTION

This agent is read-only.

It must not edit source or propose framework replacement unless the user explicitly requested architectural migration.

### ACCEPTANCE CRITERIA

For representative repos, a human can understand how the application is structured from `repository.yaml`.

No source changes occur.

STOP.

---

# Phase 5 — Runtime Manifest Inference

## Paste this prompt into the coding agent

### OBJECTIVE

Infer how the complete imported application can be started, without executing it outside the sandbox.

### DETERMINE PER PROCESS

- service ID;
- working directory;
- install command;
- dev command;
- build command if known;
- expected port;
- health endpoint if present;
- required resources;
- environment keys;
- startup dependencies.

### COMMAND CLASSIFICATION

Classify discovered commands:

- SAFE_METADATA;
- REQUIRES_SANDBOX;
- REQUIRES_NETWORK;
- REQUIRES_SECRET;
- UNSAFE.

No repository-defined execution in this phase.

### ENVIRONMENT

Read `.env.example` and configuration references.

Identify:

- generated preview values;
- user-provided secrets;
- optional settings;
- internal service URLs.

### BOOT GRAPH

Generate a deterministic startup graph.

Example:

```text
Postgres -> Migration -> API
Redis -----------------> API
API + Redis -----------> Worker
API -------------------> Frontend
```

### REVISION CONTRACT

`runtime.yaml` must point at an explicit source revision/worktree identity.

Never use vague concepts such as "latest files".

### ACCEPTANCE CRITERIA

Runtime fixtures contain enough data for the preview subsystem to attempt complete startup later.

No user code runs outside sandbox.

STOP.

---

# Phase 5.5 — Sandbox, Proxy, Filesystem, Egress, and Quota Proof

## Paste this prompt into the coding agent

### OBJECTIVE

Prove the full security/runtime boundary using synthetic test processes before running a real imported application.

This phase is a hard gate before full-stack preview.

### SANDBOX

Run an empty hardened sandbox using the production-preview provider target (gVisor).

Local Docker may be retained for trusted developer convenience but cannot satisfy the production-preview acceptance gate.

### CANONICAL FILESYSTEM MODEL

Create:

- canonical project Git repository;
- main worktree;
- task worktree.

Set:

`BuildSession.active_preview_revision = task worktree`

The preview process must mount/use exactly that worktree.

Modify a file in the task worktree.

The preview process must observe the same modification without an asynchronous source-copy service.

### BUILD/RUNTIME WRITABLE PATHS

Keep runtime/build noise separate where practical:

- node_modules;
- `.next`;
- cache directories;
- temporary files;
- uploads;
- runtime state.

Do not allow these to confuse Git revision identity.

### NETWORK INGRESS

Only the preview gateway may expose HTTP(S) access to the user.

Do not publicly expose raw application ports.

### NETWORK EGRESS

Verify user code cannot reach:

- host network;
- sibling preview;
- private control-plane addresses;
- cloud metadata addresses;
- arbitrary private subnets.

Add policy-controlled public egress for approved cases such as package registries and explicitly configured integrations.

### PREVIEW PROXY MATRIX

Test:

- ordinary HTTP;
- TLS termination;
- path routing;
- WebSocket upgrade;
- SSE streaming;
- realistic request body size;
- frontend hot-reload WebSocket behavior.

### COOKIE/AUTH MATRIX

Create synthetic frontend/API services.

Verify:

1. API login sets cookie;
2. browser receives it through preview origin;
3. later API request sends it;
4. frontend and API path rewriting does not break SameSite/domain/path behavior;
5. CSRF assumptions are explicit.

### QUOTAS

Create `QuotaProfile` enforcement for:

- CPU;
- RAM;
- disk;
- PIDs;
- hard runtime;
- idle runtime.

Create abusive fixtures for CPU, memory, and process count.

One preview must not destabilize another.

### TTL / GARBAGE COLLECTION

Implement:

- `last_activity_at`;
- idle timeout;
- hard timeout;
- STOPPED state;
- hard destroy;
- orphan cleanup.

### OBSERVABILITY

Begin structured tracing/metrics now for:

- sandbox create time;
- proxy configure time;
- startup failure stage;
- resource kills;
- GC events.

### ACCEPTANCE CRITERIA

All must pass:

- HTTP;
- TLS;
- auth cookie round-trip;
- WebSocket;
- SSE;
- hot-reload WebSocket;
- exact worktree file visibility;
- host network blocked;
- metadata blocked;
- sibling preview blocked;
- resource limit enforcement;
- idle GC;
- orphan cleanup.

Do not proceed if any mandatory security boundary is unproven.

STOP.

---

# Phase 6 — Full-Stack Live Preview V1

## Paste this prompt into the coding agent

### OBJECTIVE

Run a real complete imported full-stack application inside the hardened preview environment.

### INITIAL SUPPORTED ARCHITECTURES

Support only:

1. frontend-only React/Vite/Next;
2. frontend + Node backend + Postgres;
3. frontend + FastAPI + Postgres.

Do not add Redis/workers/queues yet.

### SOURCE OF TRUTH

Preview uses:

`BuildSession.active_preview_revision`

Record in preview metadata:

- Git SHA;
- worktree ID;
- runtime manifest version;
- preview manifest version.

### STARTUP PIPELINE

1. validate contracts;
2. resolve exact worktree;
3. construct preview-only environment;
4. resolve authorized secret references;
5. create sandbox;
6. provision Postgres where required;
7. install dependencies inside sandbox;
8. run migrations;
9. start backend;
10. backend health check;
11. start frontend;
12. frontend health check;
13. configure gateway;
14. validate public URL;
15. validate revision identity;
16. mark PREVIEW_READY.

### DEPENDENCY-INSTALL SAFETY

Dependency installation executes inside resource-limited sandbox.

Package scripts are untrusted code.

Network policy should allow only required registries/endpoints during installation.

### HOT RELOAD

A legitimate source edit in the active worktree must appear in preview without full production image rebuild.

### FAILURE CODES

Implement explicit failures such as:

- SANDBOX_CREATE_FAILED;
- WORKSPACE_MOUNT_FAILED;
- DEPENDENCY_INSTALL_FAILED;
- SECRET_RESOLUTION_FAILED;
- DATABASE_START_FAILED;
- MIGRATION_FAILED;
- BACKEND_START_FAILED;
- BACKEND_HEALTH_FAILED;
- FRONTEND_START_FAILED;
- FRONTEND_HEALTH_FAILED;
- PROXY_CONFIGURATION_FAILED;
- COOKIE_VALIDATION_FAILED;
- WEBSOCKET_VALIDATION_FAILED;
- REVISION_MISMATCH;
- RESOURCE_LIMIT_EXCEEDED;
- PREVIEW_TIMEOUT.

### HEALTH SEMANTICS

A process being `RUNNING` is not enough.

PREVIEW_READY requires:

- required services healthy;
- gateway healthy;
- exact revision match;
- required preview secrets resolved;
- required DB healthy.

### ACCEPTANCE TEST A — REAL CRUD

Using actual browser preview:

1. create account;
2. authenticate with real preview cookie/session;
3. create DB-backed record;
4. reload page;
5. confirm persisted record.

### ACCEPTANCE TEST B — FRONTEND HOT RELOAD

Edit source in active worktree.

Confirm preview shows the change.

Confirm preview revision metadata still points to that worktree.

### ACCEPTANCE TEST C — BACKEND CHANGE

Edit API behavior.

Confirm backend reload/restart and changed behavior through preview gateway.

### ACCEPTANCE TEST D — NETWORK BOUNDARY

Attempt metadata/internal-network request from app process.

It must fail.

### ACCEPTANCE TEST E — DEGRADED HEALTH

Kill one required process.

Preview must stop reporting PREVIEW_READY.

### ACCEPTANCE CRITERIA

All acceptance tests pass with isolation, secret, quota, proxy, and revision evidence.

STOP.

---

# Phase 6.5 — Cost, Quota, Kill-Switch, and Builder Observability Gate

## Paste this prompt into the coding agent

### OBJECTIVE

Add mandatory resource/cost governance before preview architectures become more complex and before agents can loop extensively.

### QUOTA PROFILE

Implement configurable limits per BuildSession/project/user tier for:

- max CPU;
- max RAM;
- max disk;
- max PIDs;
- max preview lifetime;
- idle TTL;
- max concurrent previews;
- max concurrent browser sessions;
- max active agent sessions;
- max model input/output tokens;
- max tool calls per task;
- max wall-clock task time;
- max repair attempts;
- max runtime-resource count.

### ENFORCEMENT

Limits are deterministic and enforced outside the LLM.

When a limit is exceeded:

- record exact reason;
- cancel or pause the relevant activity safely;
- keep project state consistent;
- surface actionable UI status;
- never let a runaway model/tool silently continue.

### KILL SWITCHES

Support:

- cancel current agent task;
- stop preview;
- hard-destroy preview;
- disable external network egress;
- cancel all active work for BuildSession.

### MODEL BUDGETING

Track per invocation:

- model;
- input tokens;
- output tokens;
- cached tokens if reported;
- latency;
- task/agent ID;
- tool-call count.

Allow a task budget to stop additional model turns when exhausted.

### BUILDER OBSERVABILITY

Instrument product-internal operations relevant to debugging the builder itself:

- repository analysis duration;
- preview startup stage timing;
- dependency install time;
- agent invocation timing;
- tool timings;
- browser QA timings;
- repair-loop count;
- preview resource usage;
- failure stage and reason.

Use structured logs/traces/metrics rather than free-form text only.

### ACCEPTANCE TESTS

- token budget exhaustion stops agent predictably;
- preview CPU limit triggers controlled failure;
- idle preview reclaims resources;
- global BuildSession cancel stops model, browser, and preview activity;
- no orphan resource remains after hard destroy;
- metrics/traces identify the slowest preview-start stage.

### ACCEPTANCE CRITERIA

All governance and kill-switch tests pass before proceeding to richer preview resources.

STOP.

---

# Phase 7 — Advanced Preview Resources: Redis, Workers, Schedulers, Storage

## Paste this prompt into the coding agent

### OBJECTIVE

Expand the full-stack preview runtime to support common asynchronous architectures without making those resources default.

### PROVIDER MODEL

Create a standardized `PreviewResourceAdapter` contract equivalent to:

- validateConfig;
- provision;
- healthCheck;
- connectionEnvironment;
- metrics/status;
- reset;
- stop;
- destroy.

### IMPLEMENT THIS PHASE

- Redis resource adapter;
- MongoDB adapter if not already supported;
- background worker process support;
- scheduler/cron process support;
- S3-compatible local preview storage;
- WebSocket/SSE routing support where not already generalized.

### QUEUE SUPPORT V1

Support architectures based on:

- Redis + BullMQ;
- Redis + Celery.

These resources are provisioned **only** when `runtime.yaml` requires them.

### WORKER STATES

Track:

- STARTING;
- RUNNING;
- STOPPED;
- CRASHED;
- RESTARTING;
- BLOCKED.

Capture:

- command;
- revision;
- exit code;
- restart count;
- logs;
- health/heartbeat where applicable.

### OBJECT STORAGE

For preview, use a local S3-compatible provider where practical.

Expose S3-compatible endpoint/credentials only inside the authorized preview environment.

### SCHEDULERS

Support scheduled processes/jobs without requiring production infrastructure.

Track:

- schedule;
- last run;
- next run;
- last status.

### ACCEPTANCE BENCHMARK

Run a sample application containing:

- frontend;
- API;
- Postgres;
- Redis;
- background worker.

Workflow:

1. user triggers action in browser;
2. API enqueues job;
3. worker consumes job;
4. worker modifies DB;
5. frontend reflects final DB state.

Repeat with worker temporarily stopped and restarted.

### ACCEPTANCE CRITERIA

Full workflow works inside preview without using production cloud resources.

STOP.

---

# Phase 8 — Complex Preview Resources: RabbitMQ, Kafka, Search, Vector Support

## Paste this prompt into the coding agent

### OBJECTIVE

Support advanced user-application architectures only when architecture decisions justify them.

### IMPLEMENT

Add preview adapters for:

- RabbitMQ;
- Kafka-compatible local runtime;
- optional local search engine adapter;
- pgvector support;
- generic vector-store adapter contract.

Do not make any of these default.

### KAFKA MODEL

Represent Kafka semantics correctly:

- brokers;
- topics;
- partitions;
- message keys;
- consumer groups;
- retention configuration;
- producers;
- consumers;
- health.

Do not reduce Kafka to a generic background-job queue abstraction.

### QUEUE/EVENT VISIBILITY

Expose provider-appropriate metrics such as:

- pending/waiting;
- active consumers;
- completed/processed where meaningful;
- failed/dead-lettered;
- lag where supported.

Do not force every provider into identical semantics.

### COST/QUOTA CHECK

Before provisioning complex resources, verify the BuildSession quota profile allows them.

A preview request that exceeds permitted complexity must fail clearly rather than silently over-provisioning.

### ACCEPTANCE BENCHMARK

Create controlled Kafka scenario:

API -> topic -> consumer group -> DB update -> frontend update.

Validate:

- event delivery;
- consumer restart;
- group behavior;
- preview health reporting;
- resource cleanup.

### ACCEPTANCE CRITERIA

Kafka preview works for an application that genuinely requires it while remaining opt-in through runtime architecture.

STOP.

---

# Phase 9 — Live Preview Product Experience

## Paste this prompt into the coding agent

### OBJECTIVE

Build the user-facing full-stack preview workspace around the runtime that now works.

### TWO ENTRY-MODE UX STATES

The UI must visibly distinguish:

#### NEW PROJECT

- product is being designed from scratch;
- architecture may be freely proposed;
- initial design/build stages shown.

#### IMPORTED PROJECT

- existing architecture detected;
- `PRESERVE_EXISTING` badge/state visible;
- current revision visible;
- change requests framed as modifications, not regeneration;
- architecture migrations require explicit user approval.

### CORE WORKSPACE AREAS

Provide access to:

- Conversation / Instructions;
- Live Preview;
- Build/Task status;
- Services;
- Files;
- Architecture;
- Database;
- API;
- Workers/Queues;
- Logs;
- Tests;
- Git/Revision status.

### PREVIEW AREA

Support:

- actual preview URL;
- reload;
- open external window;
- desktop/tablet/mobile viewport presets;
- preview health;
- active Git SHA/worktree;
- restart;
- stop/start;
- expired/idle state;
- clear failure stage.

### SERVICES PANEL

Show per service/resource:

- name;
- type;
- status;
- port/internal route where safe;
- health;
- restart count;
- revision where applicable.

Example:

```text
frontend       RUNNING
api            HEALTHY
postgres       HEALTHY
redis          HEALTHY
email-worker   RUNNING
report-worker  CRASHED
```

### LOGS

Support per-service filtering.

Do not combine every process into a single unreadable stream.

### PREVIEW CONTROLS

Support:

- restart service;
- restart preview;
- reset preview data;
- stop preview;
- start/wake preview.

### QUEUE PANEL

Where supported show provider-appropriate queue/event status.

### SECURITY UX

Do not expose secret values or internal host network data.

### ACCEPTANCE CRITERIA

A user can tell:

- whether the whole stack is healthy;
- which component failed;
- what revision is running;
- whether the project is imported or greenfield;
- whether a worker/queue is functioning.

STOP.

---

# Phase 10 — Agent Runtime + Deny-by-Default Tool Permissions

## Paste this prompt into the coding agent

### OBJECTIVE

Introduce the programmable coding-agent harness using GLM-5.3, with hard permissions present from the first executable agent acceptance test.

### ABSTRACTION

Create a Deplai-owned `AgentRuntime` interface with capabilities equivalent to:

- createSession;
- executeTask;
- steer;
- followUp;
- cancel;
- subscribe;
- compact;
- fork;
- destroy.

### IMPLEMENTATIONS

Implement:

1. `PiAgentRuntime` using Pi SDK where appropriate.
2. A lightweight `StubAgentRuntime` or fake adapter used in contract tests so the Deplai interface does not silently become Pi-specific.

The rest of the product must depend on `AgentRuntime`, not directly on Pi session internals.

### MODEL

Configure GLM-5.3 through a model/provider abstraction.

Support:

- streaming;
- tool calls;
- cancellation;
- timeout;
- retry;
- usage accounting;
- reasoning profile if provider exposes it.

### INITIAL CODING TOOLS

Provide only approved tools such as:

- read;
- grep/search;
- find;
- list;
- edit;
- write/patch;
- Git diff;
- controlled shell in the project's sandbox/worktree;
- runtime logs/status.

### AGENT MANIFEST

Every agent session receives a structured manifest containing:

- role;
- task ID;
- model;
- read paths;
- write paths;
- allowed tools;
- forbidden tools;
- skills;
- max iterations;
- wall-clock timeout;
- token/tool budget.

### PERMISSIONS

Permissions are enforced outside the LLM.

A prompt saying "do not edit database files" is not security.

The tool layer must reject unauthorized:

- file writes;
- shell commands;
- external access;
- secret reads;
- runtime actions.

### TOOL RISK CLASSIFICATION

Support categories:

- READ;
- WRITE;
- DESTRUCTIVE;
- EXTERNAL;
- SECRET_RELATED.

### EVENT NORMALIZATION

Normalize Pi/provider events into product-owned events:

- AGENT_STARTED;
- MESSAGE_DELTA;
- TOOL_STARTED;
- TOOL_COMPLETED;
- FILE_CHANGED;
- AGENT_COMPLETED;
- AGENT_FAILED;
- AGENT_CANCELLED.

### ACCEPTANCE TEST A

Task: add a `/health` endpoint to a sample project.

Agent must:

- inspect;
- make minimal edit;
- run relevant test/startup;
- verify endpoint;
- produce diff.

### ACCEPTANCE TEST B — FORBIDDEN WRITE

Give a frontend-scoped agent a malicious/instructed attempt to modify a forbidden database path.

Expected result:

`DENIED_BY_POLICY`

The legitimate frontend write must still succeed.

### ACCEPTANCE TEST C — FORBIDDEN SECRET

Agent attempts normal-tool access to raw project secret.

Expected result: denied.

### ACCEPTANCE CRITERIA

- generic AgentRuntime works;
- Pi adapter works;
- stub adapter proves interface independence;
- GLM-5.3 can complete a bounded coding task;
- hard permission tests pass.

STOP.

---

# Phase 11 — Skills, Context Engineering, Compaction, and Handoffs

## Paste this prompt into the coding agent

### OBJECTIVE

Give agents deep, task-specific engineering knowledge while keeping model context focused and durable.

### SKILL SYSTEM

Implement loadable skills inspired by small progressive-disclosure engineering guides.

Initial skill folders:

```text
skills/
  nextjs/
  react/
  fastapi/
  postgres/
  mongodb/
  redis/
  bullmq/
  celery/
  kafka/
  docker/
  playwright/
  accessibility/
  api-design/
  auth-rbac/
```

Each skill should contain:

- purpose;
- when to use;
- when not to use;
- architecture patterns;
- implementation rules;
- anti-patterns;
- common failures;
- verification commands;
- references/tool suggestions.

### CONTEXT ENGINE

Maintain structured project intelligence:

- RepositoryMap;
- CurrentRepositoryArchitecture;
- DesiredArchitecture;
- RuntimeManifest;
- API map;
- DB schema summary;
- symbol/file summaries;
- recent changes;
- current task;
- acceptance criteria;
- relevant logs/errors.

### RETRIEVAL

Context sent to GLM should be task-relevant.

Do not submit the entire codebase merely because the model accepts a large context window.

### COMPACTION

When context grows, produce a durable compact state preserving:

- task objective;
- architectural decisions;
- user constraints;
- files changed;
- tests run;
- unresolved errors;
- active revision;
- runtime status;
- next intended step.

### HANDOFF

Define a structured `AgentHandoff` artifact for fresh sessions.

### ACCEPTANCE TEST

Run a long multi-step task that requires compaction/forking.

Continue in a fresh session without losing critical architecture or task state.

### ACCEPTANCE CRITERIA

- context is targeted;
- skills load on demand;
- compaction preserves required state;
- handoff allows reliable continuation.

STOP.

---

# Phase 12 — Git Checkpoints, Worktrees, Revision Truth, and Parallel Safety

## Paste this prompt into the coding agent

### OBJECTIVE

Make every significant agent change reversible and ensure preview always runs a known worktree/revision.

This phase is a prerequisite for automated repair.

### IMPLEMENT

Provide operations for:

- checkpoint current working state;
- create task branch;
- create task worktree;
- compute diff;
- commit verified task;
- merge verified task;
- discard rejected task;
- restore checkpoint.

### REVISION RULES

Every task gets:

- base revision;
- task branch/worktree;
- resulting revision.

When previewing an unmerged task:

`BuildSession.active_preview_revision` must point to that exact worktree/revision.

When task passes:

- merge/commit according to policy;
- update active preview revision;
- revalidate preview revision.

When task fails:

- discard/restore;
- preview returns to the previous known-good revision.

### PARALLEL AGENTS

Parallel execution is allowed only when:

- dependencies permit;
- write ownership does not overlap;
- shared contracts are frozen or explicitly coordinated.

Detect conflicts rather than silently overwriting them.

### HISTORY

Record useful task history:

- checkpoint;
- agent role;
- task ID;
- summary;
- changed files;
- verification result;
- commit/revision.

### ACCEPTANCE TEST A

Run two non-conflicting tasks in parallel worktrees and merge both.

### ACCEPTANCE TEST B

Run two tasks modifying the same lines.

Conflict must be detected explicitly.

### ACCEPTANCE TEST C

Run a failing task and restore previous preview revision.

### ACCEPTANCE CRITERIA

No automated repair or specialist task can irreversibly mutate the last verified revision.

STOP.

---

# Phase 13 — Product Analyst for Greenfield Projects

## Paste this prompt into the coding agent

### OBJECTIVE

Implement the first greenfield reasoning specialist.

The Product Analyst converts a user's software idea into a testable product specification. It does not write application code.

### INPUT

Natural-language product request plus any user constraints.

### EXTRACT

- product purpose;
- target users;
- roles;
- primary workflows;
- core features;
- supporting features;
- optional features;
- pages/screens;
- business rules;
- domain entities;
- permissions;
- external integrations;
- KPIs;
- non-functional requirements;
- explicit assumptions;
- acceptance criteria.

### FEATURE PRIORITY

Classify:

- CORE;
- SUPPORTING;
- OPTIONAL.

### QUESTIONS

Ask only questions whose answers materially change product behavior or architecture.

Do not ask the user to choose technical implementation details unless the user explicitly wants to.

### ACCEPTANCE CRITERIA IDS

Each acceptance criterion needs a stable ID used later by testing/verifier.

Example:

```text
AC-ORG-INVITE-001
Admin can invite a teammate by email and the invitee can accept into the correct organization with the default role.
```

### OUTPUT

Generate/update `.deplai/product.yaml`.

### TEST PROMPTS

Evaluate on:

- simple yoga service website;
- CRM;
- booking platform;
- asynchronous report platform;
- developer API product.

### ACCEPTANCE CRITERIA

Specifications are coherent, user-centric, and testable without prematurely choosing unnecessary technologies.

STOP.

---

# Phase 14 — System Architect and Technology Selection

## Paste this prompt into the coding agent

### OBJECTIVE

Build the central architecture intelligence that decides what system the user's product actually needs.

### INPUTS

- `product.yaml`;
- `repository.yaml` for imported projects;
- user constraints/preferences;
- supported preview capabilities;
- architecture policy (`FREE_GREENFIELD` or `PRESERVE_EXISTING`).

### DECISIONS

Determine only what is required:

#### Architecture style

- frontend-only;
- full-stack monolith;
- modular monolith;
- service-oriented;
- microservices only when justified.

#### Frontend

Choose suitable framework/structure.

#### Backend

Choose suitable backend language/framework or determine separate backend is unnecessary.

#### Database

Choose SQL/document/managed option based on actual domain/access patterns.

#### Cache

Choose none or cache technology.

#### Async/event processing

Choose none or an appropriate technology such as:

- BullMQ;
- Celery;
- RabbitMQ;
- Kafka;
- equivalent supported mechanism.

#### Workers

Determine worker roles and whether asynchronous execution is necessary.

#### Realtime

Choose none / SSE / WebSockets as appropriate.

#### Storage/search/vector

Add only if justified.

#### AI architecture

If needed, decide simple model API vs RAG/vector/agents. AI is not assumed by default.

#### Auth and RBAC

Determine identity, organization, and permission needs.

#### Application runtime artifacts

Determine Docker/scripts/healthcheck requirements for the user's application.

### REQUIRED JUSTIFICATION

For every optional component record:

- selected;
- selected technology;
- reason;
- rejected alternatives;
- complexity impact;
- expected scale requirement;
- preview/runtime implications;
- cost notes.

### IMPORTED PROJECT CONFLICT PROTOCOL

If `architecture_policy=PRESERVE_EXISTING`:

- preserve existing technology by default;
- do not migrate frameworks merely because a different option is preferred;
- if a requested feature is incompatible with current architecture, produce `ARCHITECTURE_CHANGE_REQUIRED` with evidence and proposed options;
- require user approval before migration work is scheduled.

### PRINCIPLE

Prefer the simplest architecture satisfying requirements.

Do not architecture-cosplay with Kafka/microservices/Redis/Kubernetes.

### OUTPUT

Generate/update:

- `.deplai/architecture.yaml`;
- initial `.deplai/runtime.yaml` proposal.

### ACCEPTANCE BENCHMARKS

Architect:

1. marketing site — should remain simple;
2. ordinary CRUD SaaS — should avoid unnecessary distributed systems;
3. large CSV report generator — should recognize async work/storage needs;
4. realtime collaborative app — should reason about realtime;
5. high-volume multi-consumer event platform — should be able to justify Kafka;
6. imported project — should preserve architecture.

### ACCEPTANCE CRITERIA

Architecture choices differ meaningfully across these cases and include explicit rationale.

STOP.

---

# Phase 15 — Independent Architecture Critic

## Paste this prompt into the coding agent

### OBJECTIVE

Create an independent architecture-review session before implementation begins.

### INDEPENDENCE

The critic must use a fresh model session.

It receives:

- product requirements;
- repository current state if imported;
- architecture proposal;
- supported runtime capabilities.

It does not receive the architect's hidden reasoning transcript.

### REVIEW FOR

- overengineering;
- underengineering;
- missing systems;
- wrong DB choice;
- unnecessary cache;
- unnecessary Kafka;
- missing async processing;
- unnecessary microservices;
- incorrect service boundaries;
- auth/RBAC gaps;
- data-consistency problems;
- preview incompatibility;
- security risks;
- unreasonable operational/cost burden.

### VERDICT

Structured result:

- APPROVE;
- APPROVE_WITH_CHANGES;
- REJECT.

Each finding includes:

- severity;
- affected decision;
- evidence;
- proposed correction.

### BOUNDED LOOP

If revision is required:

Critic -> Architect -> revised architecture -> Critic.

Set a maximum number of iterations.

### ACCEPTANCE TESTS

Seed proposals containing:

- Kafka for a contact form;
- missing queue for very expensive async reports;
- ten microservices for a small CRUD app;
- Mongo for strongly relational accounting data without rationale;
- architecture migration in imported project without approval.

Critic should flag them.

### ACCEPTANCE CRITERIA

Poor architecture fixtures are rejected/changed and reasonable simple designs are not punished for simplicity.

STOP.

---

# Phase 15.5 — Continuous Evaluation Gate

## Paste this prompt into the coding agent

### OBJECTIVE

Introduce regression benchmarks now, rather than waiting until the entire product is complete.

### INITIAL PERMANENT BENCHMARK SET

At minimum create:

#### B1 — Simple CRUD SaaS

Architecture should remain uncomplicated.

#### B2 — Imported application preservation

Architect/analyst must preserve existing stack.

#### B3 — Kafka rejection

Prompt intentionally sounds "enterprise" but does not need Kafka.

Architect must reject Kafka.

#### B4 — Async reporting

Requirements should trigger queue/worker/storage reasoning.

#### B5 — Preview CRUD

Known full-stack fixture must reach healthy preview and pass browser CRUD.

### SCORE

Track:

- architecture correctness;
- unnecessary component count;
- preview-start success;
- import-preservation violations;
- acceptance-pass rate;
- token usage;
- repair loops where relevant.

### RELEASE GATE

Changes to:

- architecture prompts;
- GLM settings;
- tools;
- skills;
- repository analysis;
- preview runtime

must run the relevant benchmark subset before promotion.

### ACCEPTANCE CRITERIA

Benchmark runner exists and can compare current results to a stored baseline.

STOP.

---

# Phase 16 — Task Graph and Dynamic Engineering Team

## Paste this prompt into the coding agent

### OBJECTIVE

Translate the approved architecture into a dependency-aware graph of small, bounded engineering tasks and instantiate only the specialist capabilities that are actually needed.

### POSSIBLE SPECIALIST ROLES

Support role definitions for:

- Repository Analyst;
- Product Analyst;
- System Architect;
- Architecture Critic;
- UX Director;
- Frontend Engineer;
- Database Architect;
- API Architect;
- Backend Engineer;
- Auth/RBAC Engineer;
- Queue/Worker Engineer;
- Realtime Engineer;
- Storage Engineer;
- Search Engineer;
- AI Systems Engineer;
- Integration Engineer;
- Analytics/KPI Engineer;
- Runtime/Application Engineer;
- Test Engineer;
- Security Engineer;
- Browser QA;
- Visual QA;
- Independent Verifier;
- Debug/Repair specialist.

Do not instantiate every role for every project.

### TASK CONTRACT

Every task must contain:

- stable task ID;
- human-readable title;
- objective;
- assigned specialist role;
- dependency task IDs;
- input artifacts;
- read paths;
- write paths;
- required tools;
- required skills;
- expected output artifacts;
- acceptance criteria IDs;
- verification commands/checks;
- rollback/checkpoint requirement;
- whether task may run in parallel.

### GRAPH RULES

- Graph must be acyclic.
- A task cannot begin until mandatory dependencies pass.
- Parallel tasks must not have overlapping write ownership unless a coordination contract explicitly permits it.
- Shared contracts such as API schema or DB schema should be finalized before parallel consumers depend on them.
- Runtime-affecting tasks must declare expected `runtime.yaml` changes.

### DYNAMIC TEAM EXAMPLES

#### Simple brochure site

Likely team:

- Product Analyst;
- UX Director;
- Frontend Engineer;
- Browser/Visual QA.

#### CRUD SaaS

Likely team:

- Product Analyst;
- Architect;
- UX;
- Frontend;
- DB;
- API/Backend;
- Auth;
- Test;
- Verifier.

#### Async report platform

Adds:

- Storage Engineer;
- Queue/Worker Engineer;
- Runtime Engineer.

#### AI product

Adds AI Systems Engineer only when required.

### ACCEPTANCE TESTS

Generate task graphs for at least the four example project classes above.

Confirm:

- no invalid cycle;
- no unnecessary specialists;
- dependencies make sense;
- file ownership is non-overlapping where parallelism is allowed.

### ACCEPTANCE CRITERIA

Every task can be understood and executed independently from its structured contract.

STOP.

---

# Phase 17 — Product Workspace and Agent Activity UX

## Paste this prompt into the coding agent

### OBJECTIVE

Create the user-facing build workspace that combines instructions, build activity, architecture, services, and the live application without exposing model chain-of-thought.

### REQUIRED AREAS

Provide clear navigation for:

- Conversation / User Instructions;
- Live Preview;
- Build Graph;
- Architecture;
- Services;
- Files;
- Database;
- API;
- Workers/Queues;
- Logs;
- Tests;
- Git/Revision;
- Secrets metadata/configuration status.

### AGENT ACTIVITY

Show only useful product events:

- agent role;
- task title;
- task status;
- high-level tool operation;
- changed files;
- tests run;
- error/failure state;
- completion/verification.

Do not expose hidden chain-of-thought.

### BUILD GRAPH

Render the current task DAG with states such as:

- BLOCKED;
- READY;
- RUNNING;
- VERIFYING;
- PASSED;
- FAILED;
- CANCELLED.

### USER CONTROLS

Allow:

- pause build;
- resume build;
- cancel current task;
- retry a failed task;
- request change;
- stop/wake preview;
- inspect task evidence.

### ARCHITECTURE VIEW

Visualize selected architecture, for example:

```text
Frontend -> API -> Postgres
               -> Redis -> Worker
```

Display why optional components exist using architecture decision reasons.

### IMPORTED PROJECT UX

Imported projects must clearly display:

- existing architecture reconstructed;
- preserve-existing mode;
- source Git revision;
- current modification request;
- architecture migration approval if required.

### GREENFIELD UX

Greenfield projects should show progression from:

requirements -> architecture -> design -> build -> preview -> verify.

### ACCEPTANCE CRITERIA

A non-technical user can answer:

- what is being built;
- what is running;
- which task failed;
- why Redis/Kafka/etc. exists;
- which revision is being previewed;
- whether the app is imported or new.

STOP.

---

# Phase 18 — UX Director and Design Intelligence

## Paste this prompt into the coding agent

### OBJECTIVE

Implement an independent UX/design planning specialist so the Frontend Engineer receives a deliberate design system rather than inventing generic AI UI while coding.

### INPUTS

- product.yaml;
- architecture.yaml;
- existing design system for imported projects;
- user brand constraints;
- reference images/URLs if provided;
- application type and audience.

### OUTPUT ARTIFACTS

Generate/update:

- `.deplai/design/system.yaml`;
- `.deplai/design/routes.yaml`;
- `.deplai/design/pages.yaml`;
- `.deplai/design/interactions.yaml`.

### DESIGN SYSTEM

Define:

- visual direction;
- typography families/scale;
- spacing scale;
- layout/grid strategy;
- color roles;
- borders/radii;
- elevation/shadow strategy;
- navigation model;
- component vocabulary;
- data-display patterns;
- form patterns;
- chart language;
- motion/transitions;
- loading states;
- empty states;
- success/error states;
- responsive behavior;
- accessibility requirements.

### PAGE SPEC

Every major page must define:

- route;
- purpose;
- target role;
- primary action;
- secondary actions;
- data required;
- page sections;
- components;
- key interaction states;
- mobile behavior;
- empty/loading/error states.

### ANTI-AI-SLOP REQUIREMENTS

Explicitly avoid habitual patterns such as:

- every section being a floating card;
- random gradients;
- huge rounded wrappers everywhere;
- generic three-stat-card dashboards regardless of product;
- meaningless icons;
- decorative copy with no function;
- weak information hierarchy;
- excessively spacious enterprise dashboards that waste screen area;
- identical layouts for unrelated product categories.

### IMPORTED PROJECT BEHAVIOR

When an existing application already has a design system:

- infer it;
- preserve it by default;
- extend existing tokens/components;
- redesign only when requested.

### QUALITY RUBRIC

Create design quality rubric covering:

- information hierarchy;
- density;
- spacing consistency;
- typography;
- layout alignment;
- accessibility;
- responsiveness;
- component consistency;
- interaction quality.

### ACCEPTANCE BENCHMARKS

Generate distinct design systems for:

- financial SaaS;
- developer tool;
- CRM;
- yoga service website.

They must not look like recolored copies of the same template.

STOP.

---

# Phase 19 — Frontend Engineer

## Paste this prompt into the coding agent

### OBJECTIVE

Implement high-quality frontend UI against approved product, design, API, and architecture contracts.

### OWNERSHIP

The Frontend Engineer may write only frontend/UI-owned paths declared by the task.

It must not silently change:

- DB migrations;
- backend business logic;
- queue architecture;
- secret storage;
- runtime infrastructure outside explicitly authorized frontend changes.

### REQUIRED INPUTS

- product requirements;
- page specs;
- design system;
- API contract;
- current runtime;
- current Git revision;
- relevant skills.

### IMPLEMENT

Where required:

- routes/pages;
- navigation;
- forms;
- client validation UX;
- loading/skeleton states;
- empty states;
- error states;
- accessible interactions;
- responsive behavior;
- real API binding;
- realtime UI binding;
- appropriate transitions/motion;
- tables/charts based on real product data.

### MOCKING RULE

Temporary mocks are allowed only when a dependent backend contract is not implemented yet.

Before final task completion, replace mocks when the real endpoint is available.

Do not leave fake dashboard numbers in the final verified application.

### PREVIEW LOOP

For every meaningful screen:

1. implement;
2. update/start preview;
3. open actual route;
4. inspect browser console;
5. inspect failed network calls;
6. interact with primary controls;
7. check target viewport(s);
8. repair defects;
9. provide screenshot/trace evidence where applicable.

### COMPLETION

`npm/pnpm build` success alone does not mark frontend complete.

### ACCEPTANCE CRITERIA

- pages match design artifact;
- required workflows are interactable;
- no uncaught console errors;
- real API used where available;
- responsive states pass;
- accessibility baseline passes;
- preview revision matches task worktree.

STOP.

---

# Phase 20 — Database Architect

## Paste this prompt into the coding agent

### OBJECTIVE

Implement the database selected by the approved architecture using correct schema, migrations, constraints, indexes, and data-isolation rules.

### INPUTS

- product entities/business rules;
- architecture DB decision;
- existing repository DB state if imported;
- auth/tenant model;
- API requirements.

### DESIGN

Consider:

- entities/documents;
- relationships;
- constraints;
- uniqueness;
- indexes;
- transaction boundaries;
- enums;
- timestamps;
- tenant boundaries;
- audit requirements;
- soft delete only when justified;
- data lifecycle;
- seed/sample data.

### TECHNOLOGY RULE

Do not switch DB technology because another technology is preferred.

Respect approved architecture.

### IMPORTED REPOSITORY

For existing projects:

- inspect current schema and migration history;
- generate incremental migrations;
- preserve existing data semantics;
- never reset/recreate DB destructively unless explicitly authorized for preview-only fixture data.

### MIGRATION VALIDATION

Test:

- fresh schema creation;
- migration against representative previous schema state where feasible;
- seed process;
- indexes/constraints;
- application startup after migration.

### CONTRACT UPDATE

Update `.deplai/database/schema.yaml` and runtime migration requirements.

### ACCEPTANCE CRITERIA

- schema satisfies requirements;
- migrations run successfully in preview;
- tenant boundaries are structurally supported where required;
- no destructive imported-project migration occurs unexpectedly.

STOP.

---

# Phase 21 — API Architect, Backend Engineer, and Auth/RBAC

## Paste this prompt into the coding agent

### OBJECTIVE

Define API contracts first, then implement backend business logic and required authentication/authorization without frontend/backend drift.

### API CONTRACT FIRST

Where appropriate produce/update OpenAPI or equivalent structured contract defining:

- routes;
- methods;
- request schema;
- response schema;
- error model;
- authentication;
- authorization role/permission;
- pagination;
- filtering;
- sorting;
- idempotency semantics where relevant.

### BACKEND IMPLEMENTATION

Implement:

- routes/controllers;
- services/domain logic;
- validation;
- persistence integration;
- transactions;
- external-service boundaries;
- consistent errors;
- runtime health endpoint.

### AUTHENTICATION

If product requires auth, implement according to architecture:

- user identity;
- session/token lifecycle;
- password/OAuth/magic-link flows as chosen;
- secure cookie/session behavior in preview;
- logout/revocation.

### ORGANIZATIONS/RBAC

Where required implement:

- organizations/tenants;
- memberships;
- roles;
- permissions;
- server-side authorization;
- tenant isolation.

Client-side hiding is not authorization.

### CROSS-DOMAIN CHANGE PROTOCOL

If backend work requires a DB schema change:

- issue a structured SchemaChangeRequest;
- route to Database Architect;
- wait for approved migration;
- resume backend task.

Do not silently edit DB-owned files outside permission.

### TESTS

At minimum cover relevant:

- happy path;
- validation;
- unauthenticated;
- forbidden;
- cross-tenant access;
- not found;
- conflicts;
- transaction failures;
- session/cookie behavior.

### ACCEPTANCE CRITERIA

Frontend can interact with actual backend/database through the full preview and authorization is enforced server-side.

STOP.

---

# Phase 22 — Queue, Worker, Realtime, Storage, Search, and AI-System Specialists

## Paste this prompt into the coding agent

### OBJECTIVE

Implement non-request/response subsystems only when selected in the approved architecture.

### QUEUE/WORKER ENGINEER

When asynchronous processing is required, implement:

- job/event schema;
- producer;
- consumer;
- worker entrypoint;
- retry/backoff;
- idempotency;
- concurrency policy;
- failure handling;
- dead-letter/recovery where appropriate;
- graceful shutdown;
- health/runtime visibility;
- runtime manifest entries.

### TECHNOLOGY SEMANTICS

Treat technologies according to their actual role.

BullMQ/Celery/RabbitMQ/Kafka are not interchangeable labels.

#### If BullMQ/Celery

Focus on jobs, retry, worker concurrency, result/failure lifecycle.

#### If RabbitMQ

Model exchanges/queues/routing/acks according to architecture.

#### If Kafka

Model:

- topics;
- partitions;
- keys;
- consumer groups;
- retention;
- event schema/versioning;
- replay implications;
- retry/recovery strategy.

### REALTIME ENGINEER

If required implement SSE or WebSockets with:

- authentication;
- reconnect behavior;
- disconnect handling;
- subscription lifecycle;
- backpressure/resource limits where relevant.

### STORAGE ENGINEER

If object storage is required:

- implement provider boundary;
- use preview-safe storage endpoint;
- validate upload authorization/content limits;
- avoid exposing storage credentials to frontend when unsafe.

### SEARCH ENGINEER

Add dedicated search only when approved architecture requires it.

Do not add Elasticsearch/OpenSearch for ordinary small CRUD search without justification.

### AI SYSTEMS ENGINEER

Only instantiate when the product genuinely requires AI features.

Decide/implement only approved architecture:

- model API;
- RAG;
- embeddings;
- vector storage;
- agent framework;
- tools/MCP;
- evaluation.

Do not automatically turn every AI feature into a multi-agent LangGraph system.

### ACCEPTANCE CRITERIA

The selected subsystem works end to end in live preview and `runtime.yaml` accurately reflects every added process/resource.

STOP.

---

# Phase 23 — Integration Playbook System

## Paste this prompt into the coding agent

### OBJECTIVE

Create reusable, tested integration playbooks so agents do not reinvent third-party service integrations from stale model memory.

### PLAYBOOK FORMAT

Each playbook must contain:

- name;
- version;
- status: VERIFIED | EXPERIMENTAL | CUSTOM;
- supported capabilities;
- required packages;
- environment variables;
- secret classification;
- installation steps;
- server-side patterns;
- client-side patterns;
- webhook patterns;
- auth/signature validation;
- security rules;
- preview/test strategy;
- common failures;
- verification commands.

### INITIAL HIGH-QUALITY SET

Implement a small set thoroughly, for example:

- Stripe;
- Razorpay;
- Supabase;
- Neon;
- Resend;
- S3-compatible storage;
- Google OAuth;
- GitHub OAuth.

Do not optimize for a huge catalog yet.

### INTEGRATION ENGINEER

When a task requires a third-party integration:

1. search verified playbooks;
2. use verified playbook if applicable;
3. request secrets through `secrets.schema.yaml`;
4. implement integration;
5. run playbook verification;
6. record playbook/version used.

### SECRETS

Never write live credentials to source.

Preview credentials are runtime-injected references.

### ACCEPTANCE BENCHMARK

Integrate one payment or email provider end to end in sample app including webhook/callback verification where applicable.

### ACCEPTANCE CRITERIA

Integration succeeds using playbook-guided implementation and no plaintext credential enters source/Git/logs.

STOP.

---

# Phase 24 — KPI and Analytics Intelligence

## Paste this prompt into the coding agent

### OBJECTIVE

Generate product-specific KPI and event models based on the product's actual business logic rather than decorative generic dashboards.

### ANALYZE

- business model;
- user journeys;
- activation;
- engagement;
- conversion;
- retention;
- revenue where relevant;
- workflow health;
- operational metrics where product-relevant.

### OUTPUT

Generate/update:

- `.deplai/analytics/kpis.yaml`;
- `.deplai/analytics/events.yaml`.

Each event should define:

- stable event name;
- triggering action;
- actor;
- properties;
- privacy/sensitivity classification;
- producer location where implemented.

### EXAMPLES

CRM:

- lead_created;
- deal_stage_changed;
- deal_closed;
- active_accounts;
- conversion rate.

Subscription SaaS:

- trial_started;
- subscription_started;
- churned;
- MRR;
- activation rate.

### IMPLEMENTATION

Where architecture calls for analytics, instrument relevant frontend/backend flows.

Dashboard KPIs must query real application data or analytics source.

Do not invent fake metrics to fill cards.

### ACCEPTANCE CRITERIA

Different product categories generate meaningfully different KPIs/events and displayed metrics are backed by real data.

STOP.

---

# Phase 25 — Dynamic Runtime Mutation

## Paste this prompt into the coding agent

### OBJECTIVE

Allow architecture changes during iterative development to modify the running full-stack preview without rebuilding the entire environment unnecessarily.

### EXAMPLE

Initial architecture:

```text
frontend + backend + Postgres
```

User request introduces async email.

Revised architecture:

```text
frontend + backend + Postgres + Redis + email-worker
```

### RUNTIME DIFF

Compare old/new runtime manifests and classify:

- service added;
- service removed;
- service command changed;
- route changed;
- resource added;
- resource removed;
- environment changed;
- secret dependency changed;
- healthcheck changed.

### APPLY STRATEGY

Where safe:

- provision only new resource;
- restart only dependent services;
- preserve unrelated DB/resource state;
- preserve user preview session where possible.

### REVISION SAFETY

Runtime mutation is tied to an explicit worktree/revision and checkpoint.

If mutation fails:

1. restore previous runtime manifest;
2. restore last-known-good preview revision;
3. keep previous healthy preview available where practical;
4. report exact failure.

### ACCEPTANCE TEST

Start healthy frontend/API/Postgres app.

Add Redis + worker through architecture/task changes.

Preview should gain the new resource/process without recreating the entire project workspace.

### ACCEPTANCE CRITERIA

The preview returns to healthy state, old unrelated data remains, and runtime/revision metadata is truthful.

STOP.

---

# Phase 26 — Browser QA and Playwright Intelligence

## Paste this prompt into the coding agent

### OBJECTIVE

Give QA agents objective evidence from the actual full-stack application using browser automation.

### BROWSER CAPABILITIES

Provide controlled tools for:

- navigate;
- click;
- type;
- select;
- upload;
- scroll;
- viewport change;
- accessibility snapshot;
- screenshot;
- console capture;
- network capture;
- trace capture;
- cookie/session inspection where safe.

### ISOLATION

Each QA job receives isolated browser context/session.

Browser must target the frozen preview URL/revision being tested.

### TRACE ARTIFACT

For failed flows capture:

- action timeline;
- screenshots where useful;
- DOM/accessibility snapshots where supported;
- console errors;
- failed network requests;
- relevant response status/body excerpt within safe limits.

### TEST DERIVATION

Generate flows from stable acceptance-criteria IDs.

Example:

```text
AC-ORG-INVITE-001
1. log in as org admin
2. open team page
3. invite email
4. assert pending invite
5. accept invite as invitee
6. assert membership and default role
```

### QA RESPONSIBILITY

Browser QA reports findings.

It does not silently modify application source.

### ACCEPTANCE CRITERIA

Seed a browser failure and verify report includes exact failing step, expected vs actual, and useful browser/network evidence.

STOP.

---

# Phase 27 — Visual QA

## Paste this prompt into the coding agent

### OBJECTIVE

Evaluate design quality independently of functional correctness.

### INPUTS

- design system;
- page specs;
- rendered preview;
- screenshots at required viewports.

### REVIEW DIMENSIONS

- information hierarchy;
- layout;
- spacing;
- typography;
- density;
- alignment;
- responsive behavior;
- overflow;
- contrast;
- accessibility visual issues;
- component consistency;
- loading states;
- empty states;
- error states;
- interaction polish;
- adherence to product-specific design direction.

### OUTPUT FINDING

Each issue includes:

- severity;
- route/page;
- viewport;
- evidence;
- violated design rule;
- expected behavior;
- likely owner.

### NO UNBOUNDED REDESIGN

Visual QA reports defects.

It should not independently redesign the entire product unless the task is explicitly a redesign review.

### ACCEPTANCE TESTS

Seed known defects such as:

- overflow;
- inconsistent spacing;
- low contrast;
- mobile layout break;
- generic duplicate card structure violating spec.

Reviewer should identify them reliably.

STOP.

---

# Phase 28 — Automated Test Engineer

## Paste this prompt into the coding agent

### OBJECTIVE

Generate and execute the appropriate deterministic test layers for the application's actual architecture.

### TEST SOURCES

Derive tests from:

- product acceptance criteria;
- architecture;
- API contract;
- DB contract;
- auth boundaries;
- queue/worker design;
- known security boundaries;
- regression history.

### TEST LAYERS

Use only relevant layers:

- unit;
- DB integration;
- API integration/contract;
- auth/RBAC;
- worker/queue;
- realtime;
- integration/webhook;
- browser E2E;
- regression.

### QUEUE/WORKER TESTS

When applicable cover:

- successful job;
- retry/backoff;
- duplicate/idempotency;
- worker crash/restart;
- poison job;
- dead-letter/recovery where architecture has one.

### REALTIME TESTS

Where applicable cover:

- authorized connection;
- reconnect;
- disconnect cleanup;
- permission rejection.

### REPORT

Produce structured test results tied back to acceptance-criteria IDs where possible.

### ACCEPTANCE CRITERIA

Application cannot pass merely because a single happy-path E2E succeeds.

Required architecture-specific tests execute and report deterministically.

STOP.

---

# Phase 29 — User-Application Security Engineer

## Paste this prompt into the coding agent

### OBJECTIVE

Evaluate the security of the USER'S generated/imported application before approval.

This phase does not redesign parent Deplai security.

### STATIC/DEPENDENCY CHECKS

Integrate appropriate scanners/processes for:

- SAST;
- dependency/SCA;
- secret scanning;
- SBOM;
- container/image checks when container definitions exist.

Use deterministic scanners for detection and let the agent interpret/remediate findings.

### ARCHITECTURAL SECURITY REVIEW

Check product-relevant issues such as:

- auth/session handling;
- RBAC;
- tenant isolation;
- IDOR;
- input validation;
- SQL/command injection risks;
- file upload handling;
- webhook signature verification;
- CORS;
- CSRF where applicable;
- SSRF;
- client-side secret exposure;
- unsafe integration credential handling;
- queue/event trust boundaries;
- insecure worker messages.

### DYNAMIC CHECKS

Where safe and supported, run application-security checks against the preview environment.

### FINDING FORMAT

- ID;
- severity;
- category;
- evidence;
- affected service/file/route;
- acceptance/security rule affected;
- recommended owner.

### AUTOMATIC FIX POLICY

Do not immediately rewrite broad areas of the app.

Findings are routed through repair workflow after classification/checkpoint.

### ACCEPTANCE TESTS

Use known-vulnerable fixtures and verify expected findings are detected.

STOP.

---

# Phase 30 — Independent Final Verifier

## Paste this prompt into the coding agent

### OBJECTIVE

Independently determine whether the application actually satisfies the user's requirements on the exact frozen revision intended for approval.

### INDEPENDENCE REQUIREMENTS

Use a new GLM-5.3 session with a dedicated verifier prompt.

Do NOT provide:

- builder chain-of-thought;
- builder self-evaluation;
- informal claims that features are complete.

### INPUT ONLY

Provide:

- original user request;
- product.yaml;
- stable acceptance-criteria IDs;
- approved architecture.yaml;
- frozen preview Git SHA/worktree;
- runtime manifest;
- test reports;
- security findings;
- browser/visual artifacts;
- live preview with read/browser/test capabilities.

### TOOL SURFACE

Verifier should primarily receive:

- read-only source inspection where needed;
- browser QA tools;
- test-result access;
- runtime/service status.

Do not give unrestricted write capability.

### VERIFY REQUIREMENT BY REQUIREMENT

Produce table/result such as:

```text
AC-AUTH-001     PASS
AC-RBAC-004     FAIL
AC-REPORT-002   PASS
AC-MOBILE-003   PASS
```

### ARCHITECTURE VERIFICATION

Detect architectural drift.

Example:

Architecture says async email worker, but backend sends email synchronously.

That is a failure even if UI appears to work.

### REVISION CHECK

Before verdict verify:

`preview_revision == verification_revision`

If not, verdict is invalid.

### RESULT STATES

- READY;
- NOT_READY;
- BLOCKED_BY_USER;
- INVALID_REVISION.

### ACCEPTANCE CRITERIA

Seed incomplete functionality and confirm verifier does not rubber-stamp it.

STOP.

---

# Phase 31 — Repair Router and Bounded Self-Healing

## Paste this prompt into the coding agent

### OBJECTIVE

Route verified failures to the correct specialist, repair them from a reversible checkpoint, and re-run only the necessary validation plus regression coverage.

### PREREQUISITE

Git checkpoint/worktree primitives from Phase 12 are mandatory.

No repair may begin without a known rollback point.

### CLASSIFICATION STRATEGY

Use deterministic signals first:

- failing test category;
- service producing error;
- HTTP status/route;
- DB error;
- worker/queue ID;
- visual QA category;
- security finding owner.

Use LLM classification only when deterministic routing is insufficient.

### ROUTING

Examples:

- VISUAL -> Frontend Engineer;
- FRONTEND_RUNTIME -> Frontend Engineer;
- API -> Backend Engineer;
- DATABASE -> Database Architect;
- AUTH -> Auth/Backend;
- QUEUE -> Queue/Worker Engineer;
- RUNTIME -> Runtime/Application Engineer;
- ARCHITECTURE -> System Architect;
- INTEGRATION -> Integration Engineer;
- SECURITY -> appropriate owner with Security Engineer guidance.

### REPAIR TASK

Provide only:

- failure evidence;
- affected acceptance IDs;
- current known-good/base revision;
- allowed file paths;
- relevant context;
- minimal-change requirement.

### RETEST

After repair:

1. run the directly failing check;
2. run related regression tests;
3. restore/restart preview if needed;
4. verify revision consistency;
5. re-run verifier for affected criteria.

### BOUNDS

Configure maximum repair attempts per finding/task.

After threshold:

- mark BLOCKED;
- preserve last-known-good state;
- surface evidence to user.

### ACCEPTANCE TESTS

Seed one defect each in:

- frontend;
- API;
- DB;
- worker;
- auth.

Confirm correct owner routing and rollback behavior on failed repair.

STOP.

---

# Phase 32 — Existing Repository Change Engine

## Paste this prompt into the coding agent

### OBJECTIVE

Make imported repositories a first-class product workflow rather than a greenfield builder with `git clone` attached.

### CURRENT VS DESIRED MODEL

Inputs:

- `repository.yaml` = CURRENT STATE;
- user request = DESIRED CHANGE;
- architecture policy = PRESERVE_EXISTING.

Generate an `ImpactPlan` before editing.

### IMPACT ANALYSIS

Identify exactly which concerns are affected:

- frontend;
- API;
- backend business logic;
- database;
- auth;
- integrations;
- workers/queues;
- runtime;
- tests;
- design system.

### CHANGE RULES

Preserve by default:

- existing framework;
- directory conventions;
- business logic outside impact area;
- current package choices;
- migration history;
- design system;
- service topology.

Avoid:

- unrelated dependency upgrades;
- global refactors;
- framework migrations;
- replacing working integrations;
- rewriting unrelated modules.

### ARCHITECTURE CONFLICT

If change truly requires architecture modification:

- generate `ArchitectureChangeRequired`;
- explain why;
- propose minimal option(s);
- require explicit approval for major migration.

### IMPLEMENTATION

Before modification:

- create checkpoint;
- create task branch/worktree.

After implementation report:

- files changed;
- dependencies added/removed;
- migrations;
- runtime changes;
- tests run;
- regressions checked.

### ACCEPTANCE BENCHMARK

Import realistic full-stack app and request a cross-stack feature such as organization RBAC.

Original features must still work and new feature must work in the same live preview.

STOP.

---

# Phase 33 — MCP Client/Gateway Foundation

## Paste this prompt into the coding agent

### OBJECTIVE

Give builder agents controlled access to external MCP capabilities without attaching arbitrary servers or hundreds of tool schemas to every session.

### ROLE OF MCP

MCP is a tool/resource source for the builder, not the product orchestrator.

### IMPLEMENT MCP CLIENT LAYER

Support:

- server configuration;
- capability/tool discovery;
- resource discovery where relevant;
- auth configuration;
- timeouts;
- error normalization;
- schema caching;
- tool filtering;
- result size limits;
- audit events.

### INITIAL HIGH-VALUE MCP SOURCES

Where supported/configured, prioritize:

- current documentation/context service such as Context7;
- GitHub;
- Supabase;
- optional Figma/design context;
- user-configured custom MCP later.

### SECURITY

Classify MCP tools:

- READ_ONLY;
- WRITE;
- DESTRUCTIVE;
- EXTERNAL;
- SECRET_RELATED.

Agent manifests must explicitly allow the relevant MCP capability.

Do not give unrestricted MCP access to all agents.

### CREDENTIALS

MCP credentials use the secret-reference system.

Do not expose raw credentials to GLM unless a provider absolutely requires model-visible data and the user explicitly permits it.

### ACCEPTANCE CRITERIA

A coding agent can use a configured documentation MCP through the product tool abstraction while unrelated MCP tools remain unavailable.

STOP.

---

# Phase 34 — Dynamic Tool Search and Activation

## Paste this prompt into the coding agent

### OBJECTIVE

Keep agent tool context small and activate specialized tools only when the current task requires them.

### DEFAULT TOOL SURFACE

A normal coding task should start with a minimal set such as:

- read/search;
- edit/patch;
- controlled shell;
- Git diff;
- runtime status;
- tool search.

### SPECIALIZED TOOL GROUPS

Examples:

- browser;
- DB inspection;
- GitHub;
- documentation;
- Supabase;
- Figma;
- provider-specific integration tools;
- queue/runtime introspection.

### TOOL SEARCH

Agent describes needed capability.

System searches approved registry and returns relevant candidates.

Agent activates a candidate subject to its manifest/permission policy.

### CONTEXT RULE

Inactive tool schemas should not be sent to the model unnecessarily.

### ACCEPTANCE TEST

Frontend task begins without documentation/GitHub/Supabase schemas.

Agent requests current framework documentation.

Documentation tool becomes available while unrelated tools remain inactive.

### METRIC

Record active-tool count and tool-schema context size for evaluation.

STOP.

---

# Phase 35 — Complete Greenfield Build Loop

## Paste this prompt into the coding agent

### OBJECTIVE

Connect the previously implemented capabilities into one coherent greenfield product flow.

Do not add new architecture concepts unless needed to connect existing phases.

### REQUIRED FLOW

```text
User Prompt
-> Product Analyst
-> System Architect
-> Architecture Critic
-> Task Graph
-> UX Director
-> Specialist Engineering
-> Runtime Manifest
-> Full-Stack Preview
-> Browser QA
-> Visual QA
-> Automated Tests
-> Security
-> Independent Verifier
-> Repair Router
-> User Review
```

### USER STEERING

Support interruptions such as:

- "Use Postgres instead.";
- "Don't change the login flow.";
- "The UI is too generic.";
- "Remove Redis; this app is small.";
- "Add an async report queue.".

Translate user steering into updates to:

- product constraints;
- architecture;
- task graph;
- affected task status.

Do not rebuild unaffected work unnecessarily.

### BUILD STATUS

Expose meaningful stages and tasks, not raw model chatter.

### BENCHMARK PROMPT

Build:

> A CRM for small accounting firms with organizations, team roles, clients, recurring tasks, dashboards and email reminders.

Expected:

- coherent architecture;
- polished multipage UI;
- auth/RBAC;
- API;
- DB;
- background email workflow if architecture justifies async handling;
- live preview;
- tests;
- independent verification.

### ACCEPTANCE CRITERIA

Project reaches a verified working preview from a single product request with bounded user clarification.

STOP.

---

# Phase 36 — Complex Async Full-Stack Benchmark

## Paste this prompt into the coding agent

### OBJECTIVE

Prove architecture intelligence and live preview can build a project that genuinely needs storage and asynchronous processing.

### BENCHMARK PROMPT

> Build a reporting platform where users upload large CSV files and receive generated reports asynchronously.

### EXPECTED REASONING

Architect should likely determine a need for some combination of:

- frontend;
- API;
- DB;
- object storage;
- queue;
- worker;
- progress/status model.

Exact technologies remain Architect's decision.

### REQUIRED LIVE WORKFLOW

1. user authenticates if product requires it;
2. user uploads CSV;
3. file is stored;
4. backend creates processing job;
5. job enters queue;
6. worker processes it;
7. job/progress state is persisted;
8. report artifact is created;
9. frontend reflects completion;
10. user downloads report.

### FAILURE/ROBUSTNESS CASES

Verify:

- invalid CSV;
- worker restart;
- failed job;
- retry;
- duplicate submission/idempotency;
- missing file;
- queue unavailable/recovered;
- preview reset.

### ACCEPTANCE CRITERIA

The entire workflow runs inside live preview and the architecture is justified rather than hard-coded.

This is a major release gate.

STOP.

---

# Phase 37 — Imported Complex Repository Benchmark

## Paste this prompt into the coding agent

### OBJECTIVE

Prove imported repositories are as capable as greenfield builds.

### TEST REPOSITORY CHARACTERISTICS

Use a realistic full-stack repository containing several of:

- frontend;
- backend;
- Postgres;
- Redis;
- worker;
- queue;
- auth;
- Docker;
- tests.

### FLOW

1. import exact Git revision;
2. deterministic profile;
3. semantic reconstruction;
4. runtime inference;
5. full-stack preview;
6. run existing tests;
7. user requests cross-stack feature;
8. impact analysis;
9. task graph;
10. checkpoint/worktrees;
11. implement only affected areas;
12. hot-update preview;
13. regression tests;
14. verifier.

### REQUIREMENTS

Do not:

- replace framework;
- normalize repo into greenfield template;
- destroy existing functionality;
- upgrade unrelated dependencies.

### ACCEPTANCE CRITERIA

- original app works before change;
- requested feature works after change;
- original app still works;
- architecture remains preserved unless explicit approved change exists;
- previewed/verified revision is exact.

Keep this benchmark permanently in regression suite.

STOP.

---

# Phase 38 — Application Containerization and Runtime Packaging

## Paste this prompt into the coding agent

### OBJECTIVE

Prepare the USER'S application for eventual deployment handoff without changing the fast development-preview loop into image rebuilds.

### WHEN TO GENERATE

Generate packaging when the application architecture/user requirements call for it.

Potential outputs:

- `Dockerfile.web`;
- `Dockerfile.api`;
- `Dockerfile.worker`;
- `docker-compose.yml` or equivalent local composition;
- migration/startup scripts;
- worker entrypoints;
- health checks;
- `.env.example` without secrets.

### GENERATION STRATEGY

Prefer validated templates/composition over completely unconstrained Dockerfile invention where a known framework template applies.

Allow specialist changes only where project requirements differ.

### VALIDATION

Build images using an isolated image-build process.

Verify:

- build succeeds;
- correct startup command;
- healthcheck succeeds;
- expected ports;
- required runtime dependencies represented;
- no secret baked into image;
- sensible non-root execution where practical;
- `.dockerignore`/build context is safe.

### SECURITY

Generate SBOM where supported.

Run image vulnerability/configuration checks according to product security phase.

### PREVIEW RULE

The main iterative preview continues using dev servers/hot reload.

Do not rebuild immutable production-style images after every source edit.

### ACCEPTANCE CRITERIA

The packaged application can start independently and reproduce the verified application topology closely enough for downstream deployment consumption.

STOP.

---

# Phase 39 — Export and GitHub Experience

## Paste this prompt into the coding agent

### OBJECTIVE

Ensure users retain complete ownership of source and can move between Deplai Build and ordinary Git development.

### GREENFIELD SUPPORT

- initialize Git if required;
- connect GitHub account/repository through approved integration;
- create new repository;
- push current verified branch/revision;
- create feature branch;
- optionally create PR.

### IMPORTED REPOSITORY SUPPORT

- preserve original remote information safely;
- pull/fetch updates deliberately;
- push verified change branch;
- never force-push without explicit authorized action;
- avoid rewriting main history.

### EXPORT

Provide source archive containing appropriate:

- source;
- `.deplai` artifacts safe/useful for export;
- environment template;
- migrations;
- tests;
- runtime manifest;
- README/run instructions.

Never export stored secret values.

### DIVERGENCE

If upstream changed during a BuildSession:

- detect divergence;
- do not silently overwrite;
- present conflict/update strategy.

### ACCEPTANCE TESTS

- greenfield app pushes to new repository;
- imported app pushes verified feature branch;
- no secrets in commit/export;
- upstream divergence is detected.

STOP.

---

# Phase 40 — BuildReadinessManifest and READY_TO_DEPLOY Boundary

## Paste this prompt into the coding agent

### OBJECTIVE

Create the exact, versioned output contract consumed by Deplai's deployment capability later.

Do NOT implement production deployment here.

### READY_TO_DEPLOY CONDITIONS

All mandatory conditions must pass:

- product acceptance criteria verified;
- exact preview revision frozen;
- required services/resources healthy during verification;
- mandatory tests passed;
- no blocking security findings;
- architecture/runtime contracts valid;
- DB migrations validated;
- required packaging validated when applicable;
- required runtime secrets declared;
- preview isolation/security evidence valid;
- Git revision known;
- verifier result READY.

### MANIFEST

Create versioned `BuildReadinessManifest` containing references/metadata for:

- project/build/session ID;
- manifest schema version;
- source Git SHA;
- verified Git SHA;
- previewed Git SHA;
- architecture artifact/version;
- runtime artifact/version;
- services;
- resources;
- workers;
- queues/topics;
- schedulers;
- routes;
- database migrations;
- required runtime/deployment secret IDs/types;
- health checks;
- container definitions/images/digests if generated;
- SBOM reference where applicable;
- test report reference;
- security report reference;
- verification report reference;
- environment requirements.

### HARD REVISION INVARIANT

Reject readiness if:

```text
previewed_revision != verified_revision
```

or if handoff revision differs from verified revision.

### SECRET OWNERSHIP AT HANDOFF

Manifest contains secret requirements/references, never plaintext values.

Clearly distinguish:

- preview-only generated secrets;
- user-provided secrets reusable by deployment if policy allows;
- deployment-only secrets still required.

### UI

Display:

```text
APPLICATION READY

✓ Requirements verified
✓ Full-stack preview verified
✓ Tests
✓ Security gate
✓ Runtime contract
✓ Revision integrity

[ Deploy ]
```

The Deploy action may emit a handoff request/event using `BuildReadinessManifest`.

It must not implement deployment internals.

### ACCEPTANCE CRITERIA

Product reaches `READY_TO_DEPLOY` only when all readiness gates pass and the handoff contract is complete/versioned.

STOP.

---

# Phase 41 — Full Evaluation and Hardening Suite

## Paste this prompt into the coding agent

### OBJECTIVE

Turn Deplai Build from a successful demo into a measurable engineering product with repeatable quality gates.

### PERMANENT BENCHMARKS

Maintain at least:

#### A — Marketing website

Tests avoidance of overengineering and design quality.

#### B — CRUD SaaS

Tests normal frontend/API/DB/auth generation.

#### C — CRM with organizations/RBAC

Tests tenant/auth complexity.

#### D — Async CSV reporting

Tests queue/worker/storage architecture and preview.

#### E — Realtime app

Tests SSE/WebSocket architecture and preview.

#### F — Imported Next/full-stack application

Tests repository preservation.

#### G — Imported mixed frontend/backend/worker application

Tests runtime reconstruction and feature modification.

#### H — Kafka-justified system

Tests ability to choose Kafka correctly.

#### I — Kafka-rejected system

Tests ability to avoid Kafka despite enterprise wording.

#### J — Secret-heavy integration

Tests secrets never leak to source/logs/model tools.

#### K — Malicious repository fixture

Tests sandbox/network/filesystem boundary.

### METRICS

Track:

- requirement/spec accuracy;
- architecture correctness;
- unnecessary infrastructure count;
- repository-analysis accuracy;
- preview startup success;
- median preview startup time;
- exact-revision mismatch rate;
- build/task success rate;
- browser acceptance pass rate;
- visual QA score;
- regression rate;
- average repair iterations;
- security finding rate;
- secret-leak incidents;
- token usage;
- active tool count/context size;
- model/tool cost;
- human interventions;
- import-preservation rate;
- orphan-resource rate.

### FAILURE CORPUS

Preserve sanitized failed builds/scenarios as regression fixtures where privacy/licensing permits.

### RELEASE GATES

Changes to:

- prompts;
- model/provider;
- reasoning profile;
- tools;
- skills;
- repository profiler;
- architect;
- preview runtime;
- verifier;
- repair router

must run relevant benchmark subsets before promotion.

### ACCEPTANCE CRITERIA

Automated evaluation produces a comparable report against a stored baseline and blocks regressions according to configured thresholds.

STOP.

---

# 5. Release/Milestone Grouping

The individual phases above should be executed one at a time, but they can be planned under the following product milestones.

## Milestone A — Safe Product Foundation

Phases:

- 0
- 0.5
- 1
- 1.5

Proof:

- product boundary is explicit;
- BuildSession/state/tenancy exist;
- contracts validate;
- secrets are references, not source values.

## Milestone B — Understand Existing Software

Phases:

- 2
- 3
- 4
- 5

Proof:

Import a repository and generate a credible current-state architecture + runnable manifest without modifying or executing it unsafely.

## Milestone C — Full-Stack Preview Foundation

Phases:

- 5.5
- 6
- 6.5
- 9 (thin initial UX may be implemented alongside)

Proof:

A real frontend/API/Postgres application runs in an isolated preview with auth cookies, hot reload, revision truth, quotas, TTL/GC, and correct failure reporting.

**Do not proceed aggressively to generation until this milestone is reliable.**

## Milestone D — Rich Preview Runtime

Phases:

- 7
- 8

Proof:

Full-stack preview can support Redis, workers, storage, schedules, and optional complex event infrastructure when the runtime requires it.

## Milestone E — Agent Engineering Harness

Phases:

- 10
- 11
- 12

Proof:

GLM-5.3/Pi-backed coding agent can safely inspect/edit/test a project inside hard permissions with reversible Git worktrees and durable context/handoffs.

## Milestone F — Product and Architecture Intelligence

Phases:

- 13
- 14
- 15
- 15.5
- 16

Proof:

A vague product prompt becomes a justified architecture and executable task DAG. The architect rejects unnecessary Kafka/Redis/microservices and preserves imported architectures.

## Milestone G — Full-Stack Generation

Phases:

- 17
- 18
- 19
- 20
- 21
- 22
- 23
- 24

Proof:

The system can build a polished, real application with the appropriate DB/API/auth/optional workers/integrations/analytics rather than only generating frontend code.

## Milestone H — Runtime Adaptation and QA

Phases:

- 25
- 26
- 27
- 28
- 29

Proof:

The architecture can evolve during a session, the preview adapts, and browser/visual/test/security systems produce objective evidence.

## Milestone I — Independent Verification and Self-Healing

Phases:

- 30
- 31

Proof:

A fresh verifier detects failures and bounded repair loops route work to the correct specialist from reversible checkpoints.

## Milestone J — Existing Repository Differentiator

Phases:

- 32
- 37

Proof:

Import a non-trivial existing app, reconstruct it, run the whole stack, add a cross-stack feature, preserve existing architecture, and pass regressions.

## Milestone K — Tools and External Context

Phases:

- 33
- 34

Proof:

Agents can dynamically activate documentation/GitHub/Supabase/etc. tools via MCP without flooding every model context.

## Milestone L — End-to-End Product Gates

Phases:

- 35
- 36
- 38
- 39
- 40
- 41

Proof:

Greenfield and imported flows reliably reach `READY_TO_DEPLOY` with a versioned handoff manifest.

---

# 6. Non-Negotiable Product Gates

The product should not be considered ready merely because many phases are coded.

The following gates matter more than feature count.

## Gate 1 — Existing Repo -> Whole-Stack Preview

Import a real full-stack repository.

The system must:

1. inspect it safely;
2. reconstruct current architecture;
3. infer how it runs;
4. provision required preview resources;
5. start all required processes;
6. expose one usable preview experience;
7. preserve exact revision identity.

No source changes are needed for this gate.

If this is unreliable, pause work on higher-level agent sophistication.

## Gate 2 — Greenfield Prompt -> Real Full-Stack App

Prompt should produce:

- deliberate product spec;
- justified architecture;
- quality UX;
- frontend;
- backend/API;
- DB;
- auth if required;
- full-stack preview;
- tests;
- independent verification.

## Gate 3 — Queue/Worker Architecture -> Real Preview

Use the async CSV report benchmark.

The preview must genuinely execute:

```text
Browser -> API -> Storage -> Queue -> Worker -> DB -> Browser
```

No mocked worker or fake job-completion state.

## Gate 4 — Imported Repo Modification

Import non-trivial codebase and add a cross-stack feature without breaking existing architecture or unrelated behavior.

## Gate 5 — Architecture Restraint

The architect must be demonstrably good at saying **no** to unnecessary technology.

Required regression cases:

- no Kafka for contact form;
- no Redis for tiny static site;
- no microservices for ordinary CRUD SaaS;
- no vector DB for simple LLM call;
- no separate backend where framework server features are sufficient.

## Gate 6 — Security Boundary

Malicious preview fixtures cannot:

- read host secrets;
- hit cloud metadata;
- reach sibling previews;
- exhaust the host without limits;
- persist after hard destroy.

## Gate 7 — Revision Truth

Verifier never tests one revision while handoff/deploy uses another.

---

# 7. Recommended Initial Supported Technology Matrix

Freedom of architecture does not mean every technology must be supported on day one.

The architect may reason freely, but generation/preview capability must honestly report supported/unsupported technology.

## Initial Strong Support

### Frontend

- Next.js;
- React/Vite;
- TypeScript.

### Backend

- Next.js server/API capabilities;
- Node/Express or NestJS where repository requires it;
- FastAPI.

### Databases

- PostgreSQL;
- MongoDB.

### Cache / Queue

- Redis;
- BullMQ;
- Celery.

### Storage

- S3-compatible API for preview and application code.

### Realtime

- WebSockets;
- SSE.

### Tests

- Vitest/Jest where appropriate;
- Pytest;
- Playwright.

### Packaging

- Dockerfile/Compose where required.

## Secondary Support After Preview Reliability

- RabbitMQ;
- Kafka;
- OpenSearch;
- pgvector;
- dedicated vector stores;
- additional frontend/backend frameworks based on demand.

### Important behavior

If the architect selects a technology the current builder cannot reliably generate/preview, the system must say:

`ARCHITECTURE_CAPABILITY_UNSUPPORTED`

and propose supported alternatives or request explicit user direction.

It must not pretend support exists.

---

# 8. Agent Role Contracts

## 8.1 Product Analyst

Owns:

- user/product interpretation;
- requirements;
- acceptance criteria;
- user journeys;
- feature priority.

Does not own code or technical architecture.

## 8.2 Repository Analyst

Owns:

- current-state imported-app understanding;
- evidence/confidence;
- architecture reconstruction.

Read-only.

## 8.3 System Architect

Owns:

- target architecture;
- technology choice;
- optional component justification;
- architecture change proposals.

Does not directly implement all components.

## 8.4 Architecture Critic

Owns independent architecture challenge.

No builder transcript.

## 8.5 UX Director

Owns design architecture and page specifications.

Does not own backend.

## 8.6 Frontend Engineer

Owns presentation/frontend code and UI integration.

Does not own DB/backend architecture.

## 8.7 Database Architect

Owns schema/migrations/indexes/data constraints.

## 8.8 API Architect

Owns API contract.

## 8.9 Backend Engineer

Owns server-side business logic and API implementation.

## 8.10 Auth/RBAC Engineer

Owns auth/session/tenant/permission correctness when product requires it.

## 8.11 Queue/Worker Engineer

Owns async job/event implementation, retry/idempotency/workers.

## 8.12 Realtime Engineer

Owns SSE/WebSocket implementation when needed.

## 8.13 Storage/Search/AI/Integration specialists

Instantiated only when architecture requires them.

## 8.14 Test Engineer

Owns test generation/execution, not implementation fixes.

## 8.15 Browser QA

Owns functional browser evidence.

## 8.16 Visual QA

Owns design-quality findings.

## 8.17 Security Engineer

Owns application security findings and security-specific guidance.

## 8.18 Independent Verifier

Owns final acceptance verdict.

Read/browser/test first; no unrestricted edits.

## 8.19 Repair Router

Owns finding classification and creation of minimal repair tasks.

---

# 9. Tool and Skill Principles

## 9.1 Minimal default toolset

Do not load every tool into every GLM request.

Typical default coding-agent tools:

- read;
- search;
- patch/edit;
- controlled shell;
- Git diff;
- runtime/log status;
- tool search.

## 9.2 Dynamic capability activation

Examples:

- needs current Next.js docs -> activate documentation/Context7;
- needs repository operation -> activate GitHub capability;
- needs browser -> activate Playwright/browser tools;
- needs Supabase -> activate scoped Supabase tools.

## 9.3 Skills are instructions, not blind authority

A skill teaches patterns and pitfalls but cannot override:

- project architecture;
- permissions;
- runtime safety;
- user constraints.

## 9.4 Tool results are evidence

Prefer:

- compiler output;
- failing test;
- HTTP response;
- browser trace;
- DB error;
- queue metrics

over model speculation.

---

# 10. Preview Runtime Invariants

These are permanent invariants after Phase 6.

1. Preview uses an explicit Git/worktree revision.
2. User code is sandboxed.
3. Preview does not inherit host environment.
4. Host metadata/internal networks are inaccessible.
5. Raw secrets are injected only into authorized runtime services.
6. Required services have health semantics beyond process-alive.
7. Browser traffic enters through preview gateway.
8. Cookies/WebSockets/SSE work through the same preview experience.
9. Resource limits always apply.
10. Idle previews are reclaimed.
11. Orphan resources are garbage-collected.
12. A degraded required service makes preview degraded/not-ready.
13. Full production image rebuild is not required for ordinary hot-edit preview.
14. User data in preview is distinct from eventual production data.
15. Verification freezes the exact preview revision.

---

# 11. Greenfield Final Acceptance Scenario

The first full-stack-web version is not considered complete until this flow reliably works.

## User prompt

> Build a SaaS platform for property managers to manage buildings, tenants, maintenance requests, staff, organization roles and analytics.

## Expected builder behavior

### Product understanding

Identify:

- property manager/admin;
- staff/maintenance roles;
- buildings;
- units;
- tenants;
- maintenance workflows;
- dashboards;
- RBAC;
- notifications if justified;
- analytics/KPIs.

### Architecture

Choose sensible architecture without unnecessary distributed complexity.

### UX

Create professional multipage application with strong information hierarchy, responsive behavior, detailed tables/forms/states, and non-generic visual system.

### Implementation

Build real:

- frontend;
- backend/API;
- database;
- auth/RBAC;
- required integrations/workers only if justified.

### Preview

User can:

- create account;
- create organization;
- add property/building;
- add tenant;
- create maintenance request;
- change roles;
- see dashboard data update.

### QA

Run browser workflows, visual QA, tests, security checks.

### Verification

Independent verifier checks all acceptance criteria on frozen revision.

### End state

`READY_TO_DEPLOY`

---

# 12. Imported Repository Final Acceptance Scenario

The import path is equally non-negotiable.

## Input

A non-trivial existing repository containing a frontend, API, DB, auth and at least one additional runtime concern such as Redis/worker.

## Required behavior

1. Import exact Git revision.
2. Perform no unsafe execution during ingestion.
3. Deterministically profile repository.
4. Semantically reconstruct architecture with evidence.
5. Infer runtime manifest.
6. Start complete live preview.
7. Run baseline tests.
8. User requests new cross-stack feature.
9. Produce impact plan.
10. Preserve current architecture by default.
11. Create checkpoint/worktrees.
12. Implement only required changes.
13. Update running preview.
14. Run regressions.
15. Independently verify feature.
16. Reach `READY_TO_DEPLOY`.

## Failure condition

The product fails this acceptance scenario if it rewrites the application into a preferred template merely to simplify implementation.

---

# 13. READY_TO_DEPLOY Definition

`READY_TO_DEPLOY` is a hard product state, not a button label.

Required truth:

```text
product acceptance = pass
architecture verification = pass
full-stack preview = healthy on frozen revision
mandatory tests = pass
security blockers = none
runtime manifest = valid
migration validation = pass
required packaging = valid if applicable
required secret contract = complete
previewed SHA = verified SHA = handoff SHA
BuildReadinessManifest = valid
```

Only then may the product surface the Deploy handoff.

---

# 14. Explicit Non-Goals Until the Initial Product Is Proven

Do not derail the project with the following before the major gates work:

- native mobile generation;
- every possible framework;
- huge integration marketplace;
- autonomous production deployment redesign;
- complex collaborative editing;
- large-scale plugin marketplace;
- arbitrary Kubernetes generation for every app;
- unnecessary microservice decomposition;
- infrastructure buzzword accumulation.

The winning sequence is:

```text
UNDERSTAND
-> ARCHITECT
-> BUILD
-> RUN THE WHOLE STACK
-> OBSERVE
-> TEST
-> REPAIR
-> VERIFY
-> USER APPROVES
-> READY_TO_DEPLOY
```

---

# 15. Recommended Execution Discipline for Coding Agents

For actual implementation work:

1. Start a fresh coding-agent context for each phase or tightly related sub-phase.
2. Paste the global rules plus exactly one phase prompt.
3. Give the agent the repository and current prerequisite artifacts.
4. Do not tell it to "continue with the next phase."
5. Require the PHASE RESULT format.
6. Review tests and acceptance criteria.
7. Commit the phase.
8. Run the applicable benchmark gate.
9. Only then start the next phase.

If a phase returns PARTIAL, fix that phase before starting downstream work that depends on it.

This discipline is intentional. The product is too interconnected to hand one coding model a 40-phase prompt and expect truthful completion.

---

# 16. Final Build Order Summary

```text
0     Product boundary
0.5   Threat model + BuildSession + tenancy + sandbox contract
1     Canonical application contracts
1.5   Secrets vault/injection
2     Safe repository ingestion
3     Deterministic repository profiler
4     Semantic repository analyst
5     Runtime manifest inference
5.5   Sandbox/proxy/filesystem/egress/quota proof
6     Full-stack preview V1
6.5   Cost/quota/kill-switch/observability gate
7     Redis/workers/scheduler/storage preview
8     RabbitMQ/Kafka/search/vector preview
9     Preview product UX
10    Agent runtime + hard permissions
11    Skills/context/compaction/handoffs
12    Git checkpoints/worktrees/revision truth
13    Product Analyst
14    System Architect
15    Architecture Critic
15.5  Continuous evaluation gate
16    Task graph + dynamic specialist team
17    Product workspace + agent activity UX
18    UX Director/design intelligence
19    Frontend Engineer
20    Database Architect
21    API/Backend/Auth/RBAC
22    Queue/Worker/Realtime/Storage/Search/AI specialists
23    Integration playbooks
24    KPI/analytics intelligence
25    Dynamic runtime mutation
26    Browser QA
27    Visual QA
28    Automated Test Engineer
29    User-application Security Engineer
30    Independent Verifier
31    Repair Router + bounded self-healing
32    Existing-repository Change Engine
33    MCP client/gateway
34    Dynamic tool search/activation
35    Complete greenfield build loop
36    Complex async benchmark
37    Imported complex repository benchmark
38    Application containerization/packaging
39    Export/GitHub experience
40    BuildReadinessManifest + READY_TO_DEPLOY boundary
41    Full evaluation and hardening suite
```

---

# 17. Final Product North Star

The final product should make these two experiences feel equally native.

## New product

```text
"Build me a SaaS for X"
        |
        v
understand product
        |
        v
architect appropriate system
        |
        v
assemble only needed specialists
        |
        v
build frontend/API/DB/optional workers/etc.
        |
        v
run the ENTIRE system in live preview
        |
        v
user uses it and requests changes
        |
        v
agents observe/test/repair
        |
        v
independent verification
        |
        v
READY_TO_DEPLOY
```

## Existing product

```text
Import repository
        |
        v
understand existing system
        |
        v
reconstruct runtime
        |
        v
run ENTIRE existing system in live preview
        |
        v
"Add this feature"
        |
        v
impact analysis without rewriting architecture
        |
        v
specialists modify only what is necessary
        |
        v
preview updates
        |
        v
regressions + independent verification
        |
        v
READY_TO_DEPLOY
```

If Deplai Build reliably delivers those two loops, it is no longer merely a prompt-to-code generator. It becomes a software-building environment that can understand, architect, execute, observe, modify, and verify complete full-stack systems before handing an approved revision to deployment.
