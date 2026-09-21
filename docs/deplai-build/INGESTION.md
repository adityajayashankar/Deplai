# Safe repository ingestion — Phase 2

`ingestion.ts` implements bounded Git blob reads, ZIP decoding, names-only repository
mapping and private snapshot materialization. `import-service.ts` requires session
and source authorization dependencies. `import-store.ts` binds those dependencies
to current BuildSession, project permissions, GitHub repository access and GitHub
installation credentials. No public import endpoint or model tool is added yet.

## Sources and exact revisions

Git input is a credential-free GitHub HTTPS URL and explicit branch/ref. Other hosts,
SSH/file transports and credential URLs fail explicitly. `github-ingestion.ts` reads
GitHub commit/tree/blob APIs; redirects and truncated trees are rejected. It never
invokes Git checkout, hooks, filters, submodules or LFS downloads. Blob content is
verified against its Git SHA-1 object ID and declared size. The commit/tree IDs are
resolved once and subsequent reads use immutable object IDs, not the moving branch.
The production adapter also checks the commit matches the approved BuildSession.
Git LFS pointer files stay byte-identical pointers, not downloaded objects.

ZIP input is supported; other archive formats are rejected. ZIPs have no authoritative
Git commit: metadata explicitly records null commit and `vcs: none`, with the original
archive SHA-256 and deterministic content SHA-256. Its BuildSession source revision
must equal the archive SHA-256. Never present a ZIP digest as a Git commit.

Every completed import writes `import.json` alongside `source/`, not into source.
It records source type, original URL/ref where applicable, resolved commit, relative
root, timestamp, VCS, hashes, owner/org/project/session scope and PRESERVE_EXISTING.
Accepted file bytes, root folder names and executable intent are preserved; no
newline rewriting or repository flattening occurs.

## Limits and rejected input

- 32 MiB archive upload; 20,000 entries; 8 MiB per file; 128 MiB expanded total;
  32 path levels and 512-character relative paths.
- ZIP decompression uses an output cap, validates expanded size and CRC, and rejects
  encrypted/unsupported entries. Git responses are streamed with byte and time bounds.
- Traversal, absolute/drive paths, backslashes, control characters, Windows reserved
  names, Git internals, case/Unicode collisions and file/directory collisions fail.
- Symlinks, devices and other special ZIP files, Git symlinks and submodules fail.
- Credential-bearing files such as `.env`, private keys, `.aws`, `.ssh`, `.npmrc` and
  `.netrc` reject the entire import. The operator must provide a sanitized source
  revision; ingestion does not silently delete files and claim byte identity.
- `.env.example`, `.env.template` and `.env.sample` names may appear in the map.
  The map exposes names only, never template values or other source excerpts.

This does not detect all embedded secrets in arbitrary source or template values.
Private source remains untrusted; later source-reading/model tools must apply their
content/secret checks before disclosure. Raw HTTP/provider errors are not surfaced.

## Workspace and execution boundary

Configure an absolute `BUILD_IMPORT_ROOT` owned by the Connector service. Pre-create
it privately; do not place it under web/public roots, shared tenant-writable trees,
or agent/sandbox mounts. The materializer rejects symlink parents, creates a fresh
unpredictable directory with private permissions and writes exclusively. It relies
on the service-owned parent preventing concurrent hostile filesystem mutation; it
does not claim race-safe materialization in an attacker-controlled parent.

No repository-defined command is executed: no npm/pip install, make, Docker build,
hooks or package lifecycle scripts. No model or cloud call is made. Install scripts
in manifests remain uninterpreted bytes. Ingestion does not modify existing sources.

Only a successfully written import manifest marks completion. A filesystem write
failure may leave a private incomplete directory; do not expose it or mark the import
successful. Lifecycle garbage collection and durable resource-handle registration
must be wired before exposing import workflows publicly. No destructive cleanup of
existing user workspaces is attempted here.

## Deterministic map and verification

Sorted path sets cover directories, manifests, package manager files, configuration,
Docker files, environment templates, CI, migrations, tests and likely code roots.
This is filename classification, not the semantic profiler in Phase 3.

`ingestion.test.ts` tests normal pinned Git/ref reads, byte-identical private files,
monorepos, malformed sources, unsafe archives/links, credential files, collisions,
expansion limits, a 5,000-file tree, authorization before transport, and fake GitHub
responses including truncation. These are deterministic fixture tests; live GitHub
permissions and production filesystem ownership have not been exercised.
