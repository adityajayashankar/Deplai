# Canonical artifacts — schema version 1

Phase 1 defines data contracts, parsing, structural and cross-file validation,
and serialization. It does not create sessions, execute commands, import source,
inject secrets, start a preview or certify deployment readiness.

## API and ownership

Implementation: `Connector/src/lib/deplai-build/artifact-schemas.ts` and `artifacts.ts`.
The schema registry owns the eight primary filenames. Inferred TypeScript types
and `jsonSchemaFor(name)` expose the same structural schemas to future callers.
JSON Schema export does not express all refinements or cross-file rules: always
use `validateBundle` as the authoritative gate before consuming a bundle.

| Helper | Behavior |
| --- | --- |
| `parseArtifact(name, source)` | Parse one YAML/JSON document and validate its version, fields and local refinements. |
| `validateArtifact(name, data)` | Validate an already decoded artifact; no coercion or unknown fields. |
| `validateBundle(data)` | Validate all eight artifacts plus dependencies, references and revision consistency. |
| `parseBundle(files)` | Parse eight filename-keyed strings, then perform full validation. |
| `serializeBundle(bundle)` | Validate and return a virtual `.deplai/` file map. Does not write to disk. |
| `jsonSchemaFor(name)` | Export structural JSON Schema for tooling; not an execution/authorization grant. |

The caller must resolve the authenticated project/session and exact source revision
before using artifacts. A supplied `session.yaml` is descriptive untrusted data;
it cannot overwrite the durable BuildSession or satisfy the readiness gate.
No artifact is treated as an instruction to the platform or granted a capability.

## Layout and representation

Primary files are `product.yaml`, `repository.yaml`, `architecture.yaml`,
`runtime.yaml`, `preview.yaml`, `secrets.schema.yaml`, `session.yaml`, and
`task-graph.json`. Every one requires integer `schema_version: 1`.
Serialization also creates virtual `.gitkeep` entries under `design/`, `database/`,
`api/`, `analytics/`, `testing/`, `security/`, `verification/` and `build/`.
Those later-phase subdocuments have no invented schemas in this phase.

Product collections contain stable `{ id, description }` records; IDs are unique
across product collections. `acceptance_criteria` supplies the stable task references.
The full collections cover users, roles, features, journeys, pages, business rules,
domain entities, integrations, KPIs, assumptions and non-functional requirements.

Architecture explicitly records every optional component, including unselected ones.
Each decision has selected status, nullable technology, requirement IDs, reason,
alternatives with rejection reasons, implementation/preview complexity and cost notes.
Selected components require a technology and an existing product requirement.

Repository reconstruction records an immutable revision, PRESERVE_EXISTING policy,
component collections, relationships, and path-grounded confidence/evidence. Empty
collections represent no recorded observations; fixtures are not real analyzed apps.

Runtime uses arrays of services/resources with explicit IDs. All service/resource
classes from Phase 1 are supported. Service commands are **argv arrays**, never
interpolated shell strings. For example:

```yaml
install: [npm, ci]
dev: [npm, run, dev]
build: [npm, run, build]
production: [npm, start]
```

An unavailable command or service port is explicitly null. Health checks are typed
HTTP (path, port, timeout) or command (argv, timeout) records. Duplicate IDs, missing
dependencies, cycles and invalid ports are rejected. Ports can repeat across isolated
services; these are service-local ports, not host bindings.

Both runtime and preview routes use `{ path, target }`. Targets must be declared
public services with ports. Preview records HTTPS origin, revision/worktree, isolation,
deny-by-default network metadata, hot reload, WebSockets/SSE, cookie strategy, TTLs
and resource profile. TTL ordering and session profile/revision references are checked.
Neither the origin nor the network document proves safe DNS/egress: later runtime
validation must resolve and enforce these policies before any fetch or launch.

Secrets contain only the declared metadata fields. Raw `value`, `password`, `token`
or other undeclared fields are rejected. Runtime references must identify a defined
secret and be listed among its consumers; consumer declarations must agree in both
directions. Deployment-only secrets cannot be required for preview. A configured
flag is descriptive, not proof the vault contains a value. Arbitrary free-text fields
must still pass the later secret boundary; schemas cannot detect all secrets in prose.

Tasks require objective, specialist, DAG dependencies, read/write paths, skills/tools,
expected artifacts, product acceptance IDs, verification argv arrays and rollback
boundary. Paths are relative and reject traversal/absolute/drive forms. Actual
filesystem containment and symlink checks remain mandatory when tools are introduced.

## Parser limits and failure behavior

- 512 KiB maximum per serialized document, 50,000 decoded nodes, depth 40.
- At most 1,000 entries per collection; bounded strings, IDs and command arguments.
- Duplicate YAML/JSON keys, YAML aliases/cycles, unsafe mapping keys, custom tags,
  multiple YAML documents, unknown fields and unsupported versions are rejected.
- JSON files must use JSON syntax. YAML uses the JSON scalar schema.
- Errors identify artifact/field and failure class without echoing source snippets,
  unknown field names, values or raw parser exceptions.
- No LLM, provider access, environment inheritance or command execution is involved.

## Fixtures and acceptance

`artifact-fixtures.ts` provides five complete valid bundles: frontend-only,
Next.js/Postgres, React/FastAPI/Postgres, API/Postgres/Redis/worker, and RabbitMQ/worker.
It also provides invalid cycle, undefined-secret and unknown-preview-target bundles.
`artifacts.test.ts` exercises YAML/JSON round trips and negative parser/reference cases.
Run from Connector: `npx tsx --test src/lib/deplai-build/artifacts.test.ts`.

Phase 1 was explicitly requested while Phase 0.5's live MySQL test remained pending.
These contracts are independent of that database check. That prerequisite is not
waived for exposing the Build runtime or claiming end-to-end product readiness.
