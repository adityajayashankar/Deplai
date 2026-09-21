# Build threat model and host boundary — Phase 0.5

## Assets and trust

Protect user source, scoped artifacts, application secrets, tenant data, host
credentials, internal services, budgets and revision integrity. Browser input,
repository instructions, generated code, package installers and model output are
untrusted. Only Connector resolves identity and organization/project permission.

BuildSession belongs to an owner, organization and existing project. Legacy projects
without organization scope are rejected. Each access rechecks the owning user's
current project permission (`agent.read`, `agent.run`, or `agent.cancel`). Ownership
is deliberately stricter than shared organization membership in this phase.
Do not pass user IDs from an untrusted request body to the internal store.

## Threats and required controls

| Threat | Boundary / mitigation | Evidence now; future proof |
| --- | --- | --- |
| Malicious imported/generated code, package lifecycle scripts, arbitrary shell | No execution adapter; later isolated gVisor worker with typed commands, no host mounts/socket, non-root/read-only runtime | All providers refuse provisioning; Phase 5.5 must attack-test isolation |
| Traversal, symlinks, archive bombs, malicious uploads | No ingestion here; bounded extraction, file count/size/containment checks before any import | Identifier validation now; Phase 2 extraction fixtures |
| Secret theft / inherited host identity | Empty environment by default; only explicitly supplied APP_ variables; no process.env copying | Unit tests; Phase 1.5 vault and injection, Phase 5.5 metadata/credential probes |
| SSRF, DNS rebinding, cloud metadata, internal networks | Deny host, private ranges, metadata and sibling previews; public egress deny or controlled proxy | Policy validation only; future IPv4/IPv6, redirect, DNS and proxy enforcement proof required |
| Cross-user/organization/project/session access | Existing project authorization, owner equality, scoped SQL, composite resource FK | Negative unit tests and opt-in MySQL FK test |
| Stale/concurrent transitions, partial event persistence | Row locks, expected version, transactionally written state and ordered event | Unit rollback test; opt-in concurrent MySQL test |
| Forged healthy/ready claims | LLMs have no state API. PREVIEW_READY and READY_TO_DEPLOY always refused until trusted evidence adapters exist | Transition tests; future exact-revision acceptance verification |
| CPU/memory/PID exhaustion, fork bombs, disk exhaustion | Bounded validated quota snapshot; later kernel/provider limits and out-of-sandbox watchdog | Validation now, stress/kill/GC proof in Phase 5.5 and 6.5 |
| Model/tool/browser/repair runaway | Agent/browser/token/tool/repair caps in profile; later atomic reservations and kill switches | No calls exist yet; enforcement/economics gate Phase 6.5 |
| Dependency supply-chain behavior | Package install stays inside isolated runtime with controlled egress, pinned artifacts and review | No installs of user packages now; future package execution tests |
| Credential leakage in failure text | Only enumerated failure codes enter session/events; no free-text exception storage | Failure validation tests |

## Providers

`SandboxProvider` is a non-executing contract. `local-docker` is restricted to explicit
trusted development, `gvisor` is the production target, and `firecracker` is reserved
and unavailable. These identifiers do not prove installed isolation. No provider
creates containers, invokes shell, reads host env or exposes a Docker socket.

Resource ownership registry covers workspaces, worktrees, previews, databases,
caches, workers, secret scopes, logs, artifacts and browser sessions. IDs are generated
server-side. Resources have no external handles yet. Production provisioning must
attach handles and lifecycle/cleanup evidence to this scope before execution is added.
Private same-session DB/queue networking needs an explicit scoped service policy in
the runtime phase; the current contract grants no private-network exception.

## Lifecycle and storage

MySQL stores BuildSessions, immutable quota snapshots, resource scope and ordered
state events. Failed event writes roll back state updates. Failed/cancelled/ready
sessions cannot transition again; retries must create a new session. Waiting state
can return only to analysis/planning/building, forcing fresh downstream checks.
Ready states fail closed until the future verifier exists. No API or LLM tool can
set state. Future controllers must invalidate preview/verification evidence whenever
the source changes and reconcile resources before confirming cancellation.

Foreign keys use RESTRICT to avoid quietly deleting Build evidence with existing
user/project deletion. Before exposing BuildSession creation in the UI, integrate
retention and explicit cleanup with account/project deletion workflows.

## Migration and verification

From Connector: `npm run migrate:build`. It uses configured Connector database
settings, serializes with a MySQL named lock and applies additive CREATE TABLEs.
DDL is not transactional in MySQL; rerun after a partial failure. No existing
tables are altered. This phase does not run the migration against production.

`npm run test:build` runs unit checks. To test SQL and restart/concurrency semantics,
use a disposable MySQL server with a database-creation test account, set
`BUILD_TEST_MYSQL=1` and optionally `BUILD_TEST_DB_HOST`, `BUILD_TEST_DB_PORT`,
`BUILD_TEST_DB_USER`, `BUILD_TEST_DB_PASSWORD`, then run the same command. The test
creates and drops only its generated `build_test_<random>` database and never loads
application env files. It checks migration replay, creation, resource FK enforcement,
fresh repository reads, racing transitions and rollback on event failure.
