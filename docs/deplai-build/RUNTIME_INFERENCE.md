# Runtime manifest inference (Phase 5)

`inferRuntime` reads imported bytes and the deterministic profile, verifies the
content fingerprint, and returns `.deplai/runtime.yaml`. Source revision and
worktree identity are mandatory for inferred manifests. No commands execute and
no imported files are modified.

Supported evidence includes package.json scripts, local/ancestor package-manager
lockfiles, requirements.txt, conventional FastAPI entrypoints, literal Node listen
ports and health routes, dependency clients, environment-template keys and source
environment references. Next/Vite default ports are explicitly conventional hints.
The deterministic graph orders resource candidates, installs, migrations and
services. Unknown relationships are review blockers rather than invented edges.

The artifact records command argument arrays and classifications: SAFE_METADATA,
REQUIRES_SANDBOX, REQUIRES_NETWORK, REQUIRES_SECRET and UNSAFE. Repository script
bodies and environment values are never included. Classification is a risk hint,
not a security allowlist; even an ordinary package install can execute untrusted
lifecycle scripts. `launch_authorized` remains false.

Environment metadata distinguishes generated preview values, user-provided secrets,
internal service URLs and optional settings. This phase does not generate secrets
or copy template values. Resource clients imply candidates, not working databases;
secret references and actual bindings require review before preview execution.

Missing health checks are null, not fabricated `/health` endpoints. Workspace root
installs, unsupported manifests/frameworks, unknown ports and cross-service routing
remain explicit blockers. Runtime inference examines at most 64 process manifests,
256 source candidates per owning directory and 256 KiB per source file, within the
existing ingestion bounds. Omitted evidence is reported.

The Phase 1 shape remains readable. New inference metadata requires revision and
worktree IDs; bundle validation cross-checks them against preview metadata.
Graph validation rejects unknown targets, duplicate IDs and inconsistent ordering.

`bindPreviewWorktree` is a trusted controller method with owner/project/organization
authorization, a registered worktree ownership check, version lock and transactional
event write. It updates both the worktree ID and exact preview SHA and clears stale
preview identity. Callers must resolve that SHA from the actual worktree; there is
no public API accepting arbitrary client revision assertions.
