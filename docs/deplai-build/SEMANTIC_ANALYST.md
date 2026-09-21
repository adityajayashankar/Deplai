# Semantic repository analyst (Phase 4)

`Connector/src/lib/deplai-build/analyst.ts` turns revision-bound Phase 2 source
bytes and Phase 3 profiler evidence into a validated `.deplai/repository.yaml`
artifact. It returns the artifact path and YAML; it never writes to imported source.

The optional `analysis` field extends the existing repository contract without
invalidating earlier artifacts. It contains purpose, domain modules, services,
frontend, backend, APIs, databases, authentication, roles, queues, workers, jobs,
realtime, storage, integrations, test strategy and runtime relationships. Findings
and relationships carry evidence paths, confidence and uncertainty. Confidence is
a model assessment, not a calibrated probability. Empty sections are unknown,
not evidence that a capability is absent. Detailed runtime relationships live in
`analysis.relationships`; older top-level fields retain their Phase 1 shape.

## Inputs and bounds

- Exact Git SHA or ZIP digest plus the imported content fingerprint.
- Explicit selection of 1–12 unique relevant paths; no automatic whole-repo upload.
- Maximum 8 KB per selected file, 48 KB of source, 80 KB serialized request context.
- Profile detections limited to selected evidence paths, 20 per category.
- Repository map limited to 40 paths per category, with partial coverage disclosed.
- Environment template content excluded; common credential forms redacted.
- Maximum 8,192 requested output tokens and 100 KB response bytes.

Repository limits are checked before source bytes are copied. Source code is
untrusted evidence, not instructions. The model receives no tools, secret resolver,
filesystem access or execution capability. Secret filtering is heuristic, not a
universal guarantee for arbitrary source; callers must select approved context.

## Gateway and authorization integration

`createAnalystService` is an internal server adapter. Compose it with Connector's
`executeChat` and a trusted `authorizeRun` implementation. That implementation must
verify session ownership, active organization/project access, imported revision and
content fingerprint, and explicit paid-run authorization before dispatch. It must
be server-owned; accepting a browser boolean as authorization is not sufficient.
Authorization runs before work, again before inference and before returning output.

No public execution endpoint is introduced in this phase. The existing Build shell
remains gated. Durable run orchestration, consent issuance and scoped artifact
persistence are integration prerequisites; this internal module does not implement
them or claim a completed end-to-end agent workflow.

The requested provider model ID must identify GLM-5.3 and match exactly one existing
eligible catalog entry. The gateway filters this workflow to that model, preserving
catalog pricing, provider policy, credentials and billing checks. It does not invent
model availability/prices or use another model when configuration is missing.
Other products' model policies are unchanged.

Malformed JSON, schema mismatches, unknown citations, duplicate finding IDs,
unresolved relationship endpoints, missing uncertainty for low-confidence findings,
missing coverage unknowns, model substitution, tool calls, fallback and truncated
responses fail without producing an artifact. Provider exception details are not
returned. Citation membership proves the path was supplied, not that every semantic
claim is true; human review remains required.

## Validation boundary

Mocked Next.js/FastAPI and Celery/Redis reports exercise YAML generation and review
structure. Tests also cover source preservation, stale fingerprints, bounded
selection, secret filtering, authorization and invalid responses. They do not prove
live GLM-5.3 interpretation quality, current provider availability or pricing,
production authorization composition, paid settlement or durable artifact storage.
Phase 5 runtime inference has not been implemented.
