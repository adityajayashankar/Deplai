# Deterministic repository profiler — Phase 3

`profileRepository(files)` in `Connector/src/lib/deplai-build/profiler.ts` consumes
authorized, private Phase 2 file records and returns structured evidence. It is a
pure read-only function with no filesystem traversal, subprocess, network or LLM call.
Callers must retain session/tenant authorization from ingestion before supplying bytes.
No public source-reading endpoint or autonomous orchestration is introduced here.

## Output contract

The output includes `schema_version: 1`, an ingestion-compatible `content_sha256`,
`detections` by category, and explicit `skipped` diagnostics. Before attaching results
to an import, match this digest to the completed import's content digest. It fingerprints
sorted paths, executable intent and byte hashes, not an asserted Git commit.

Each detection has value, confidence, source_path and field/pattern responsible.
Unsupported/absent evidence yields UNKNOWN with confidence 0 and null source path;
it never silently becomes an architecture choice. Multiple frameworks/package managers
can coexist with separate evidence. Results and diagnostics are ordered deterministically
and contain no timestamps or random identifiers.

Categories cover languages, frameworks, package managers, monorepo systems, build
tools, test frameworks, ORMs, migrations, DB clients, queues, workers, realtime,
storage SDKs, Docker, CI, entrypoints, probable commands/ports and environment keys.

## Detection rules

- File extensions give language evidence, not proof the language executes.
- package.json dependency sections match a curated library registry. Workspaces,
  packageManager and allowlisted script names produce distinct findings.
- Lock/workspace/config filenames identify npm/pnpm/Yarn/Bun, Poetry/pip/Pipenv/uv,
  Turbo/Nx, Prisma/Drizzle/Alembic, Maven/Gradle/Cargo and Go modules.
- Python requirements/TOML/Pipfile tokens are pattern evidence, with lower confidence
  for TOML/Pipfile than requirements. They are not full semantic TOML interpretation.
- JVM and Rust rules identify selected framework/client declarations. Unknown
  libraries remain unknown instead of being guessed.
- Dockerfile/Compose/workflow names provide configuration evidence. EXPOSE and
  probable Compose mappings provide candidate ports, not verified listening ports.
- Conventional filenames and package main provide probable entrypoints.
- Script hints are reconstructed as package-manager run invocations; arbitrary
  script bodies, inline credentials and lifecycle commands are never returned.
  Explicit packageManager wins; otherwise nearest unambiguous lockfile is used.
  With no such evidence, npm hints have reduced confidence.
- Environment lookups in JS/Python, template declarations and Compose interpolation
  return key names only, never defaults or assignment values.

## Limits and safety

Phase 2 path/file/credential-name bounds are applied before scanning. Content scans
skip binary files and files over 256 KiB, while keeping filename evidence. At most
20,000 distinct evidence records are emitted; omissions are explicit diagnostics.
No file is rewritten. Tests check unchanged source bytes and that credential values
and arbitrary script bodies do not enter output.

Patterns may observe comments or inactive configuration; confidence scores are
heuristics, not calibrated probabilities. No dependency installation, test execution,
port probe, schema migration, readiness claim or architectural recommendation occurs.
This is not a secret scanner or runtime inference engine. Later semantic analysis
must cite and verify evidence without treating repository instructions as authority.

## Fixtures

`profiler.test.ts` covers all eight required applications: Next, React/Vite,
Express/Nest, FastAPI, Django, Next/FastAPI monorepo, Redis worker, Docker Compose.
Additional checks cover malformed/oversized manifests, JVM/Rust, credential opacity,
object-property filenames, lockfile command hints and content fingerprints. Each
required fixture is checked for identical output under reversed input ordering.
