# PHASE RESULT

Status: PASS — local Phase 2 ingestion gate. Earlier live SQL/browser gates remain pending.

## IMPLEMENTED

- Git URL/ref and ZIP source abstractions with private immutable file snapshots.
- GitHub commit/tree/blob adapter, exact commit pinning and blob hash verification.
- Session/project/repository authorization and read-only GitHub installation tokens.
- Approved session revision matching for Git commit SHA or ZIP archive SHA-256.
- Source/VCS/timestamp/root/ref metadata and PRESERVE_EXISTING policy.
- Deterministic repository map without file contents.
- Bounded ZIP decompression with checksum/size checks; traversal, symlink, special
  file, credential-file, duplicate-path and case-collision rejection.
- Private new workspaces with checked parents and exclusive file writes.
- No package installs, shell commands, Git hooks or repository scripts run.

## FILES CHANGED

- `Connector/src/lib/deplai-build/ingestion.ts`
- `Connector/src/lib/deplai-build/github-ingestion.ts`
- `Connector/src/lib/deplai-build/import-service.ts`
- `Connector/src/lib/deplai-build/import-store.ts`
- `Connector/src/lib/deplai-build/ingestion.test.ts`
- `Connector/src/lib/github.ts`
- `docs/deplai-build/INGESTION.md`
- `docs/deplai-build/PRODUCT_CONTRACT.md`
- `docs/deplai-build/PHASE_2_RESULT.md`

Earlier phase working-tree changes and user master plan preserved.

## TESTS EXECUTED

From Connector:

- `npx tsx --test src/lib/deplai-build/ingestion.test.ts`: 9 PASS.
- `npm run test:build`: 38 PASS, 1 opt-in MySQL test SKIPPED, 0 failures.
- `npx eslint src/lib/deplai-build/*ingestion*.ts src/lib/deplai-build/import-*.ts`: PASS.
- `npx tsc --noEmit --incremental false`: PASS including the final read-only-token method.

Repository `git diff --check`: PASS.

## ACCEPTANCE CRITERIA

- Exact source revision recorded: PASS for Git fixture; ZIP uses explicit archive/content
  digests and null Git commit, not an invented commit SHA.
- Accepted source bytes unchanged: PASS, including CRLF and package lifecycle text.
- No repository-defined code runs: PASS by implementation and fixture behavior;
  ingestion has no process-execution dependency.
- Unsafe archive fixtures rejected: PASS.
- Normal repository/ref, monorepo, malformed URL, invalid ZIP, traversal, symlink and
  5,000-file mapping fixtures: PASS.

## SECURITY / ISOLATION EVIDENCE

Private real-directory parents, fresh UUID roots and exclusive writes; no arbitrary
user-selected storage root. Session ownership checked before network access and before
materialization. No public import endpoint or user-code runtime is enabled.

## SECRET HANDLING EVIDENCE

Credential-bearing files cause whole-import rejection; no silent byte modification.
Provider errors are generic. Maps contain filenames only; raw contents are private.
Embedded secrets in arbitrary source are not universally detected: future readers
must enforce their own content/secret boundary before passing source to agents.

## QUOTA / RESOURCE EVIDENCE

32 MiB archives; 8 MiB files; 128 MiB expanded repositories; 20,000 entries;
bounded path depth; streamed GitHub response caps, per-request and total deadlines.
No model use, preview provisioning or deployment occurred.

## REVISION EVIDENCE

Base SHA `39473456557bc67117f992e45300eb4e03651d8f`, plus uncommitted changes.
Tests use synthetic Git revisions; no real repository was imported from GitHub.

## KNOWN LIMITATIONS

- GitHub HTTPS is the initial Git provider. SSH, other Git hosts, submodules, Git LFS
  expansion and archive types other than ZIP are explicitly unsupported.
- Production filesystem ACLs, live GitHub installation access and end-to-end import
  were not exercised. Workspace parents must be service-owned and inaccessible to tenants.
- File failures may leave a private incomplete directory without completion manifest.
  Public workflow integration needs lifecycle/garbage collection and durable handle registration.
- Empty archive directories are not materialized; accepted file paths and bytes are preserved.
- Earlier live MySQL/browser gates are still unresolved; imports have no public UI/API yet.

## REGRESSIONS CHECKED

Existing Build state, quota, ownership, secrets and artifact tests pass.

## NEXT PHASE PREREQUISITES

Phase 3 deterministic profiling may read these private byte-preserved sources only
through bounded authorized readers. It must not run package commands or expose secret
content. Keep the source revision/digest and PRESERVE_EXISTING policy attached to evidence.
