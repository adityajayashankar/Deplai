# Architecture planning V2

Deplai keeps one deployment-planning pipeline:

`repository_analysis` → `architecture_decision` → approved `DeploymentProfileDocument` → Stage 7 approval/cost → Terraform.

V2 extends the existing JSON contracts; it does not introduce a second Terraform or deployment path. Pydantic models use `extra="allow"` so V1 saved sessions still load, while new profiles carry `profile_version: "2.0"`.

## Planning flow

1. `repository_analysis/service.py` runs deterministic dependency, infrastructure, datastore, health, and workload detectors.
2. `architecture_decision/planner.py` converts evidence into typed decisions with explicit authority.
3. `architecture_decision/service.py` asks only unresolved business intent and relevant technical conflicts.
4. Completion resolves decisions, derives the canonical profile, creates Lean/Recommended/HA candidates, and runs the deterministic critic.
5. The existing Stage 7 bridge prices and gates the selected deterministic infrastructure plan.
6. Only the approved profile/architecture reaches Terraform generation.

## Decision authority and evidence

Every architecture decision uses one of:

- `auto`: deterministic repository evidence or mandatory platform policy safely resolves the choice.
- `recommend_confirm`: Deplai can recommend a choice, but it materially affects cost, availability, operations, or lock-in.
- `user_required`: only business intent can answer the decision.

`ArchitectureEvidence` records `source`, `signal`, a non-secret `value`, and numeric confidence. Supported sources are repository, security, AWS, user, policy, runtime, and cost. Secret values must never be evidence; use environment-variable names or secret metadata only.

To add a decision, create it in `build_initial_decisions`, give it stable `decision_id` and `reason_codes`, attach evidence, and add any answer mapping to `resolve_decisions`. Add dependency IDs to support future invalidation.

## Workload detection

`WorkloadProfile` normalizes web services, workers, schedulers, queues, durable storage, object storage, search, authentication, third parties, webhooks, protocols, migration behavior, session storage, and runtime characteristics.

To add a repository detector, extend `_workload_scanner` with exact package names or strong source/config patterns. Prefer package/config evidence over prose. Never scan dependency lockfiles or secret-bearing `.env` files for values. Add a focused fixture test to `test_autonomous_architecture_planner.py`.

## Adaptive questions

The guided flow normally asks lifecycle, budget, expected usage, recovery tolerance, data-loss tolerance when stateful data exists, optimization preference, and optional domain. Dynamic questions appear only for detected conflicts such as durable local uploads. Question models carry priority, reason, recommendation, cost/risk impact, skip policy, and affected decision ID.

Autopilot, Guided, and Expert are profile modes, not separate backend pipelines. Expert overrides must be validated by the same critic and policy rules before approval.

## AWS discovery

`POST /api/architecture/aws-discovery` accepts one-time AWS credentials and returns metadata only. The service does not persist or echo credentials and never reads secret values. Permission failures produce a partial result with structured permission gaps so a least-privilege discovery role remains useful.

Existing resources are suggestions with `recommend_confirm` authority. They do not become Terraform-owned until explicit selection and ownership/import validation. Names alone are never sufficient for automatic reuse.

## Critic and guardrails

The critic currently checks budget overruns, low-budget NAT use, in-memory session scaling, missing durable storage, omitted workers, and GPU/Fargate mismatches. Secure defaults are automatic: private stateful services, encryption at rest/in transit, S3 public-access blocking, Secrets Manager delivery, SSM administration, and no unrestricted SSH.

New AWS components require four coordinated changes: typed profile representation, architecture/infra-plan mapping, deterministic cost support, and Terraform renderer support. Do not expose a planner option until all four are available.
