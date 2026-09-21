# Build secrets — Phase 1.5

## Interfaces and trust boundary

`secrets.ts` defines a transactional SecretStore abstraction. Trusted wiring obtains
three separate interfaces:

- `metadataReader`: getMetadata and listRequiredSecrets; suitable for agent tools.
- `editor`: createSecret, updateSecret and deleteSecret plus metadata operations.
  Create declares a credential slot with immutable consumers. User input can only
  fill existing slots; the browser cannot change consumers, scope or classification.
- `runtimeResolver`: resolveForRuntime; accepts a trusted preview/service grant and
  returns only that service's environment bindings after a successful audit commit.

No list-all-values, reveal endpoint or agent plaintext tool exists. The resolver
must never be registered as an agent tool. Future integration adapters must resolve
credentials inside the trusted adapter and return sanitized tool results, not secrets.

`secret-store.ts` binds the interfaces to scoped MySQL transactions and the existing
AI-platform AES-256-GCM encryption backend. It requires an explicit configured
`AI_CREDENTIAL_ENCRYPTION_KEY` of at least 32 characters; Build never uses the backend's
development/session-secret fallback. Losing or changing that key without re-encryption
makes stored values unreadable. Key rotation/re-encryption is an operator procedure,
not a browser action.

Metadata is stored in `build_secret_metadata`; encrypted values are stored separately
in `build_secret_values`. The encrypted envelope binds value to full owner/org/project/
BuildSession scope and reference, so moving ciphertext between records fails integrity
checks. The resource scope has a composite foreign key to BuildSessions.

## Dedicated user entry

Open DeplAI Agent → Build secrets (`/dashboard/agents/secrets`). A future scoped build
flow supplies `session_id`, `project_id` and `organization_id` as navigation parameters.
Without an existing session, the page explains the prerequisite and accepts no values.

The page renders declared required slots with a password input. Values are sent in
JSON request bodies, never URLs, localStorage, source files or chat. The input clears
on submission; no reveal action is offered. Responses contain metadata only.

`/api/build/secrets` supports GET metadata, PUT replacement value and DELETE. It
requires a browser session, derives owner ID server-side, checks session ownership
and project permissions, and validates origin on mutations. JSON bodies are bounded
while streaming; errors are generic and responses use no-store. There is no public
create-slot or plaintext-resolution route.

Creation/deletion additionally require their respective secret permissions; existing
BuildSession agent-read and secret metadata/update permissions remain enforced.
All slot declarations must come from the trusted controller after artifact and tenant
validation. No new BuildSession creation UI is introduced by this phase.

## Source and runtime representation

Source uses environment names, e.g. `process.env.APP_SESSION_KEY`. Artifact metadata
can carry an opaque reference such as `secret://session/<generated-id>`. Runtime
secret_references accept these URIs; metadata consumers and runtime references must
agree. Existing ID-only fixtures remain valid when no vault reference has been assigned.
Neither metadata nor artifact exports include ciphertext or raw values.

At launch, the trusted controller must derive exact environment bindings from the
approved runtime revision, verify preview ownership/liveness and service identity,
then invoke the runtime resolver. Only listed consumers receive a value. Internal
system/deployment-only secrets are rejected for preview injection. Reserved loader/
shell environment keys are rejected. Resolved bindings are explicit and contain no
inherited host environment. They must be passed directly to the isolated service,
never printed in logs or written to an env file in a source checkout.

Production runtime resolution is intentionally **not exported or enabled**: the real
preview capability issuer and sandbox arrive in later phases. The core resolver is
implemented and tested using an authorized fixed test subprocess. This does not
constitute live preview execution or sandbox isolation proof.

## Generated preview credentials

GENERATED_PREVIEW values use 32 random bytes and session scope, require a preview ID,
cannot be supplied/replaced by a user and cannot be marked required for deployment.
The MySQL adapter verifies that preview ID is registered to the same session. The
resolver rejects another preview ID. JWT keys, session keys and temporary database
passwords can use this path. Production credentials must be separately created.
The future runtime controller must revoke generated records on preview cleanup and
deny stale/expired preview grants; no preview is provisioned by this phase.

## Audit and validation

Create/update/delete/injection write reference, session, consumer (on injection),
category and timestamp only. Audit failure aborts the transaction and prevents
resolution. Plaintext and ciphertext are absent from audit records and API responses.

`npm run migrate:build` applies the existing session migration followed by
`20260920_build_secrets.sql`, using the same named lock. No production migration was
run. `npm run test:build` covers metadata opacity, encrypted storage, artifact exports,
consumer denial, preview scope, ciphertext swapping, audit failure and controlled
process injection. The opt-in MySQL test includes both migrations; live SQL and browser
acceptance remain pending in this environment.
