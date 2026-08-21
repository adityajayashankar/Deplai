# DeplAI agent and workflow architecture

DeplAI uses the word *agent* for several different implementation patterns.
Some are LangGraph state machines, some are LLM-assisted workers surrounded by
deterministic contracts, and some are deterministic orchestration services. The
distinction matters: no workflow should be understood as an unconstrained model
with direct authority to mutate a cloud account.

This document maps the implemented workflows from source context to runtime.
The [technical architecture](technical-architecture.md) explains the service
and trust boundaries around them.

## Design principles

| Principle | Implementation evidence |
| --- | --- |
| Source before suggestion | Repository analysis produces a typed context of languages, dependencies, frameworks, data stores, build/runtime, CI, health, environment, and infrastructure signals. |
| Structured state | LangGraph workflows use explicit `TypedDict` state and named transitions; architecture and deployment flows use Pydantic contracts. |
| LLMs are bounded | LLM output is requested as JSON where practical, parsed into contracts, validated, and replaced by deterministic paths when unavailable or invalid. |
| Human approval is material | Users review remediation output, architecture/cost, and Terraform plan output; apply requires explicit confirmation. |
| Execution is observable | Scan, remediation, Terraform generation, and Terraform apply expose progress events, status, and recoverable results. |
| Execution is scoped | Connector ownership checks, project-bound WebSocket tokens, internal API keys, temporary Terraform volumes, and workspace locks constrain actions. |

## End-to-end decision flow

```text
GitHub repository or local ZIP
             |
             v
Repository analysis --------> structured RepositoryContextDocument
             |                            |
             |                            +--> architecture review questions
             |                                      |
             v                                      v
security scan --> remediation proposals       DeploymentProfileDocument
                                                   |
                          +------------------------+--------------------+
                          |                                             |
                          v                                             v
                 Infrastructure Advisor                         Stage 7 approval
                 tiers + budget gate                            diagram + cost + gate
                          |                                             |
                          +--------------------+------------------------+
                                               v
                                Terraform generation and validation
                                               |
                                               v
                            plan -> explicit confirmation -> apply -> runtime
```

These workflows can be entered independently through the API/UI, but their
contracts are designed so later stages can consume evidence and decisions from
earlier ones.

## 1. Repository analysis and architecture decision workflow

### Repository analyzer

The Agentic Layer’s repository-analysis service is a deterministic evidence
collector, not a free-form agent. It scans a project workspace with bounded file
size and excluded-directory rules. Its output is a `RepositoryContextDocument`
that records, among other things:

- languages, dependency manifests, frameworks, and framework configuration;
- data-store evidence from dependency, Docker Compose, environment, and source
  signals;
- build/start information, runtime/process details, and front-end entry points;
- CI, health/monitoring, documentation, infrastructure hints, conflicts, and
  low-confidence signals.

That document is persisted/returned with a human-readable summary and becomes
the factual input to review, advisor, and Terraform generation. It prevents
deployment planning from relying only on an unverified user prompt.

### Architecture review

`architecture_decision.service` turns repository evidence plus a short guided
questionnaire into a typed deployment profile. It derives compute strategy,
data layer, networking, runtime configuration, build pipeline, operations,
DNS/TLS, and compliance characteristics. It also derives an architecture view
and an infrastructure-plan shape for downstream cost and IaC work.

```text
RepositoryContextDocument + environment hint
            -> tailored review questions and defaults
user answers + repository context
            -> ArchitectureAnswersDocument
            -> DeploymentProfileDocument
            -> DerivedArchitectureView + infra plan
```

Natural-language architecture generation is a separate optional endpoint. It
asks a configured provider for an AWS, Azure, or GCP architecture JSON document,
validates the node/edge contract, and supports a provider fallback chain. It is
useful for diagram/cost input; it is not the source of authorization for apply.

## 2. Infrastructure Advisor graph

The AWS-focused Infrastructure Advisor is a LangGraph conversation that makes
the deployment profile understandable for a user who may not know cloud sizing.
It persists advisor state, transcript, and decision files within the project
workspace.

```text
START
  -> load_context
  -> understand_turn
       |-- ask ------> ask_beginner_questions -> compose_reply -> END
       |-- design ---> design_architecture -> estimate_cost -> budget_fit
       |                                  -> propose_tiers -> compose_reply -> END
       `-- finalize -> finalize_decision -> estimate_cost -> budget_fit
                                          -> propose_tiers -> compose_reply -> END
```

Node responsibilities:

| Node | Role |
| --- | --- |
| `load_context` | Merges persisted state with the current source context, architecture/profile facts, conversation, budget, requirements, and prior decision. |
| `understand_turn` | Classifies intent, parses a budget/tier choice, merges plain-language requirements, and chooses ask/design/finalize routing. |
| `ask_beginner_questions` | Requests only the unanswered inputs needed to make a useful choice. |
| `design_architecture` | Builds baseline, recommended, and resilient AWS tiers from detected signals and requirements; selects an affordable tier unless the user deliberately chooses otherwise. |
| `estimate_cost` / `budget_fit` | Computes a monthly estimate and returns a `PASS`, `WARN`, or `FAIL` budget assessment. |
| `propose_tiers` | Explains upgrade trade-offs and shifts to an affordable tier when appropriate. |
| `finalize_decision` | Marks a decision ready; it does not apply infrastructure. |
| `compose_reply` | Produces deterministic explanatory text or, for a free-form question, an optional LLM answer grounded in the current decision. |

The graph is advisory. A ready decision becomes input to later Terraform
generation; it is not a cloud mutation.

## 3. Stage 7 diagram, cost, and approval graph

`Diagram-Cost-Agent` is a compact LangGraph workflow invoked by the Agentic
Layer’s Stage 7 bridge:

```text
START -> diagram_builder -> cost_estimator -> budget_gate
      -> approval_packager -> END
```

It accepts the derived infrastructure plan, creates a structured AWS diagram,
estimates monthly cost from a static pricing table first, evaluates the budget
as `PASS`, `WARN`, or `FAIL`, and emits the Stage 7.5 approval payload. The
bridge invokes it as a bounded subprocess with a 60-second timeout. If the
runner is unavailable, fails, returns no output, or returns invalid JSON, the
bridge returns a deterministic fallback payload with a warning rather than
silently fabricating success.

## 4. Terraform generation and execution

### Active Terraform-generation path

The Agentic Layer’s `/api/terraform/generate` endpoint calls
`generate_terraform_bundle`. It publishes worker-stage events to the
project-bound pipeline WebSocket and returns files, a manifest, a dependency
DAG order, renderer provenance, warnings, and decision-drift information.

The main path operates as an orchestrated pipeline, not a single prompt:

```text
validated context + profile + approval/security/consultant inputs
  -> normalize and validate deployment-profile contract
  -> choose supported renderer and optional LLM configuration
  -> repository-context worker or deterministic context fallback
  -> architecture-to-profile worker or approved-profile fallback
  -> Terraform structure plan and component/file grouping
  -> per-group HCL generation or deterministic rescue renderer
  -> assemble files, validate structure/HCL expectations, produce manifest/DAG
  -> persist bundle and report provenance, warnings, and next actions
```

LLM-backed workers are used only when requested/configured. They return
structured JSON for stages such as repository context, profile refinement,
structure, file generation, and validation. The implementation records worker
events and selects deterministic fallbacks when a worker is not configured or
fails. The result explicitly reports its actual renderer/source so the user can
see whether output was dynamic, partially rescued, or fully deterministic.

The deterministic paths include a deployment-profile renderer and a
repository-aware EC2 application renderer. The latter can detect Prisma,
Docker Compose images, package dependencies, and `DATABASE_URL` signals to
decide whether an external database/RDS configuration is required. Generated
component files use the internal Terraform registry’s exact module pins,
contracts, allowlisted edit schema, and golden HCL snippets.

### Terraform execution engine

Apply is deliberately separate from generation:

```text
bundle (request files or saved run)
  -> validate required inputs / choose AWS credentials
  -> bootstrap or reuse remote state bucket and DynamoDB lock table
  -> acquire per-workspace lease
  -> terraform init + plan in pinned Terraform Docker image
  -> return awaiting_plan_confirmation unless explicitly confirmed
  -> apply, stream events, inspect state/output
  -> send sensitive outputs to AWS Secrets Manager
  -> persist run artifact/state and release workspace lease
```

Key execution protections:

- Terraform commands run in a temporary Docker volume using
  `hashicorp/terraform:1.9.0`, not in the Connector process.
- Per-command timeouts, progress events, cancellation, diagnostics extraction,
  and lock recovery are built in.
- A DynamoDB conditional lease prevents concurrent applies for one workspace;
  S3 stores snapshots for saved-run recovery when configured.
- Sensitive Terraform outputs are returned as Secrets Manager ARNs rather than
  plain output values.
- Project runtime operations are distinct API calls: inspect details, verify an
  endpoint, perform supported EC2 actions, manage app secrets, or best-effort
  destroy DeplAI-tagged resources.

### Standalone LangGraph Infrastructure Agent

The Terraform Agent package also contains a standalone LangGraph workflow. It
is implemented alongside, but is not the current Agentic endpoint’s main
generation route:

```text
START -> repo_parser -> infra_planner -> terraform_generator -> validator
                                                     | valid/exhausted
                                                     v
                                                final_output -> END
validator failure with retry_count < 3 -> refiner -> validator
```

Its state machine reads repository signals, infers infrastructure needs,
generates modular Terraform, and runs up to three refinement loops. Documenting
it separately avoids conflating the legacy graph with the newer
deployment-profile/multi-worker generator.

## 5. Security scan and remediation workflow

### Scan execution

The Agentic Layer runs project-scoped security work through WebSocket runners
with cancellation and status recovery. The container-based scanner surface
includes Bearer for code scanning and Syft/Grype tooling for software-composition
work. Results are available through REST even if the live socket disconnects.

### Remediation orchestration

The remediation pipeline is deterministic in its outer orchestration and can
use an LLM only for generating candidate fixes:

```text
scan findings
  -> VulnIngester
  -> GrouperPrioritizer (by file/severity)
  -> SnippetExtractor
  -> FixGenerator via quota-aware LLM router
  -> DiffValidator
  -> accepted local changes or GitHub PR handoff
```

For large repositories or a major-only scope, the orchestrator prioritizes
critical then high-severity groups, bounds group/finding counts, favors
patchable dependency files, batches work, and emits an explicit progress
explanation. Each generated diff is validated; diffs that cannot be applied
cleanly are dropped. The router supports configured providers with quota-aware
fallback and can use a supplied provider/model or a forced Claude path for
staged large-repository remediation.

## 6. Tenant customization graphs

Customization is deliberately two-stage: conversation discovers a structured
manifest, then an implementation graph acts on a scoped repository copy.

### Manifest conversation

```text
START -> conversation_handler -> termination_check
          | terminate -> end_node -> END
          ` otherwise -> manifest/question agent -> END
```

The state includes the message, partial manifest, questions, patch, and optional
in-memory BYOK configuration. The manifest becomes the requested customization
contract rather than passing raw chat directly to a modifier.

### Customization implementation

```text
front-end scanner
  -> [backend scanner]
  -> front-end planner -> front-end modifier
  -> [backend planner -> backend modifier]
  -> validator -> reporter -> END
```

The bracketed backend stages are omitted in front-end-only mode. The backend
also supports deterministic-first customization, diagnostic plans, quality
gates, snapshots, preview start/restart/stop, assets, repository reset, and a
Connector-controlled GitHub PR handoff. Every call reaches it through a
Connector route that first resolves the authenticated user’s project directory.

## 7. Connector chat-agent orchestrator

The dashboard chat implementation is a TypeScript coordination layer for a
small allowlisted tool registry. It is not a general shell or cloud tool agent.
Its per-turn sequence is:

```text
Memory Forensics Keeper
  -> Signal Warden
  -> [Tool Contract Sentinel]
  -> [Chain Choreographer for multi-tool intents]
  -> [Adversarial Verifier]
  -> Action-UI Binder
  -> [Recovery Marshall on tool error]
  -> Narrative Blacksmith
```

| Component | Function |
| --- | --- |
| Memory Forensics Keeper | Checks recent conversation context and removes stale project references. |
| Signal Warden | Classifies the request into one execution mode and decides whether a tool may be proposed. |
| Tool Contract Sentinel | Enforces required parameters and sanitizes the allowlisted tool payload. |
| Chain Choreographer | Produces a minimal ordered chain for multi-tool intent; the first step is the immediate action. |
| Adversarial Verifier | Challenges a proposed action and can reject it before execution. |
| Action-UI Binder | Maps deterministic tool outcomes to UI events, cards, routes, and buttons. |
| Recovery Marshall | Classifies an error and recommends bounded retry behavior. |
| Narrative Blacksmith | Returns a concise user-facing explanation, optionally using an injected LLM caller. |

The registered actions are intentionally narrow: run a scan, navigate to scan
results, start remediation, plan deployment, create a GitHub repository, ask
for a GitHub PAT, or generate code. High-risk tools are represented in the
registry and pass through the verifier; execution remains in the normal
Connector/API authorization path.

## Cross-cutting safeguards and fallbacks

| Risk | Control |
| --- | --- |
| Stale or ungrounded recommendation | Structured repository context, typed profile/architecture contracts, and deterministic source detection. |
| Malformed LLM output | JSON parsing, Pydantic/contracts, validation reports, curated files, and deterministic fallback/rescue paths. |
| Unsafe broad tool execution | Narrow chat tool registry, contract validation, adversarial check, and existing Connector authorization. |
| Secret exposure | Internal service key stays server-side; project-bound WebSocket tokens; sensitive Terraform outputs go to Secrets Manager. |
| Concurrent Terraform runs | DynamoDB workspace lease plus run-specific state and artifact handling. |
| Interrupted long-running work | WebSocket progress + REST status, cancellation/stop paths, timeouts, and saved-run snapshot support. |
| Destructive change without review | Remediation review/PR handoff, architecture and budget review, plan confirmation before apply, and explicit destroy endpoint. |
| LLM/provider outage | Provider fallback where configured; deterministic behavior for supported paths; warnings and provenance in results. |

## What an agent can and cannot decide

Agents can analyze source signals, turn structured inputs into suggestions,
generate bounded candidate artifacts, evaluate a budget, and prepare execution
work. They cannot replace the platform’s ownership checks, turn an unsupported
cloud shape into a supported deployment, reveal internal service keys, or apply
infrastructure without the API’s explicit confirmation and AWS credentials.
