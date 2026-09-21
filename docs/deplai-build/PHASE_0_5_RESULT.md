# PHASE RESULT

Status: PARTIAL — implementation and unit checks complete; live MySQL gate pending.

## IMPLEMENTED

- MySQL BuildSession with all required identity, revision, lifecycle, timestamps,
  preview/worktree, secret scope, quota reference and failure fields.
- Additive migration and named-lock migration runner; no production migration run.
- Owner/organization/project/session-scoped resources with a composite foreign key.
- Project permission checks on each operation; cross-owner reads/writes rejected.
- Transactional state/event updates, expected-version checks and row locking.
- Safe enumerated failure codes; terminal states cannot restart implicitly.
- Preview/deployment readiness denied until trusted evidence adapters are implemented.
- Sandbox provider interface for trusted local Docker, production-target gVisor and
  future Firecracker. All provisioning disabled.
- Validated CPU/memory/disk/PID/time/agent/browser/model/tool/repair quotas, denied
  host/private/metadata/sibling networking and explicit application environment.
- Threat model and repeatable disposable MySQL integration test.

## FILES CHANGED

- `Connector/package.json`
- `Connector/migrations/20260920_build_sessions.sql`
- `Connector/scripts/apply-build-migration.ts`
- `Connector/src/lib/deplai-build/contracts.ts`
- `Connector/src/lib/deplai-build/lifecycle.ts`
- `Connector/src/lib/deplai-build/sandbox.ts`
- `Connector/src/lib/deplai-build/repository.ts`
- `Connector/src/lib/deplai-build/store.ts`
- `Connector/src/lib/deplai-build/build.test.ts`
- `Connector/src/lib/deplai-build/mysql.test.ts`
- `docs/deplai-build/PRODUCT_CONTRACT.md`
- `docs/deplai-build/THREAT_MODEL.md`
- `docs/deplai-build/PHASE_0_5_RESULT.md`

Existing Phase 0 working-tree changes and the supplied master plan were preserved.

## TESTS EXECUTED

From Connector:

- `npx tsx --test src/lib/deplai-build/*.test.ts src/lib/organizations/*.test.ts`:
  35 passed before adding the opt-in MySQL test (11 Build + 24 organization tests).
- `npm run test:build`: 11 passed, 1 MySQL integration test skipped, 0 failures.
- `npx tsc --noEmit --incremental false`: PASS.
- `npx eslint src/lib/deplai-build/*.ts scripts/apply-build-migration.ts`: PASS.

Repository `git diff --check`: PASS.
`docker version --format '{{.Server.Version}}'`: Docker Desktop Linux daemon pipe unavailable.
No native mysqld/mariadbd executable found on PATH.

## ACCEPTANCE CRITERIA

- Durable BuildSession: implementation complete; live SQL persistence/restart gate PENDING.
- Deterministic transition guards: PASS in unit tests; readiness gates fail closed.
- Session/resource ownership: PASS in unit tests; SQL composite FK gate PENDING.
- Sandbox provider interface: PASS; deliberately non-executing.
- gVisor production target: PASS in contract; actual runtime unavailable in this phase.
- No host-environment inheritance: PASS in unit tests.
- No user application code executed: PASS.

## SECURITY / ISOLATION EVIDENCE

Negative owner/organization/session tests pass. Production local Docker and unsafe
network policy are rejected. All providers refuse execution. Policy validation is
not runtime isolation proof; penetration/stress/egress proof remains Phase 5.5.

## SECRET HANDLING EVIDENCE

No host env is copied. Application env is explicit and allowlisted. The secret scope
is metadata only, with no secret values. Failure storage accepts enumerated codes.

## QUOTA / RESOURCE EVIDENCE

Validated immutable per-session quota snapshot; invalid/zero/nonfinite/excessive
limits rejected. No runtime resource allocated, no token consumption or paid call.
Provider enforcement and atomic quota reservations belong to later runtime phases.

## REVISION EVIDENCE

Base: `39473456557bc67117f992e45300eb4e03651d8f`; uncommitted working-tree changes.
No preview/verified/handoff application revision exists.

## KNOWN LIMITATIONS

- Live migration/replay, transaction concurrency, database restart durability and FK
  rejection need the opt-in MySQL test. Unit adapters do not prove MySQL behavior.
- UI entry actions remain unavailable; no Build API, worker, secrets vault or preview.
- No production changes made. Account/project deletion needs explicit Build retention
  integration before public creation is enabled; FKs currently prevent silent deletion.

## REGRESSIONS CHECKED

Existing organization permissions/isolation/invitations/audit tests and full Connector
type checking pass. Existing phase 0 navigation was not changed by this phase.

## NEXT PHASE PREREQUISITES

Start a disposable MySQL server and run `npm run test:build` with `BUILD_TEST_MYSQL=1`
and the test-only connection variables documented in THREAT_MODEL.md. Complete this
gate before Phase 1 canonical contracts. Do not enable user code execution.
