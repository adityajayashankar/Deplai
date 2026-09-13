# Remediation pipeline

## Publication recovery

Publication UI reads the newest remediation run's PR event rather than a
project-wide PR lookup, and shows verification activity on the publication page.
Pending verification calls report elapsed time every 15 seconds without claiming
scanner progress. REST recovery returns the newest event window in sequence order.

The approval screen offers **Recover saved patches for review** after failure.
This calls the normal authenticated start route with `resume_publication=true`.
The worker resolves the existing run inside the same user/project/organization,
restores its recorded candidates and prepares a fresh isolated checkout. Recovery
does not run initial scanners or inference and does not settle remediation credits
again. Required patch verification still runs after the renewed approval; the
GitHub source-revision check remains mandatory.

Publication preflight assembles each file before asking for approval. A file whose
candidates conflict is excluded in its entirety, named in the review warning and
retained in the archive as unresolved. The reduced file list replaces the earlier
list. Approval therefore applies to the displayed subset, never a silently chosen
conflicting edit. All new findings for one file share a planning packet, subject
to the existing context-size controls. This includes source files, not just manifests.

Run-scoped `publication-base` and `publication-review` packet records retain source
identity and original candidates. Older runs can recover against the retained scan
snapshot when available; missing baseline or missing candidates fails explicitly.
Recovery is not proof of security verification and does not repair excluded files.

The product track uses deterministic grouping and source context, then a Planner and Implementor followed by local patch review. All product inference goes through the Connector gateway. Each packet permits two generation calls and one repair after actionable validation feedback. A pass processes up to 256 packets by default, bounded by the shared run token allowance; completed packet results are checkpointed for continuation.

`REMEDIATION_RUN_TOKEN_BUDGET` defaults to 2,000,000 aggregate worker-request tokens per run. It is separate from the model's 200K per-request context window. The worker reserves an estimate before each source/planner/implementor/correction request, reconciles reported usage, and retains reservations for failed or usage-less responses. Packet changes and user continuation do not reset the allowance. Mongo-backed reservations use an atomic conditional update; without Mongo the existing single-process journal is the budget authority and cannot survive a worker restart. Connector still owns provider retries, account quotas, inference policy and billing; this worker allowance is not a claim about unreported tokens used by upstream retries. Exhaustion stops further packets and retains accepted patches with remaining findings unresolved. OpenWiki generation remains disabled by default and is not newly enabled by a larger allowance.

## Model and cost policy

A gateway capacity error with an explicit `retryAfterSeconds` between one second
and one day saves the current packet's waiting state and retry timestamp. The
worker waits without inference calls, emits periodic waiting messages, and
retries that same packet after the advertised delay. Up to three capacity waits
are allowed per packet; authorization failures, unknown reset times, and run
budget exhaustion still stop dispatch. This automatic retry requires the worker
process to stay alive. Restarting it retains packet artifacts but does not
automatically restart execution. Provider/account cooldowns are never cleared to
force remediation through a quota limit.

The product orchestrator applies the same heuristic noise triage as its findings
summary, then passes only critical/high `source_patch` findings to the unified
workflow. Medium/low and manual-action findings never enter patch generation.
The packet builder uses this selection rather than re-expanding raw scanner
results. It groups up to eight findings per file and retains excess work as
additional packets. Triage indicates relevance; it is not proof of exploitability
or a substitute for security validation. Packet identities include a schema
version; failed packets remain retryable, and accepted packet results remain
cached within their run.

Security model calls have a 600-second provider deadline and a 660-second worker
HTTP deadline, so the gateway can finish or report its timeout before the worker
abandons the request. A stage retries a transport timeout once using its existing
plan/source observations and the same aggregate run allowance. It does not restart
the planner or treat transport failure as invalid JSON. This retry is separate
from revisions after actionable patch validation failures. A packet has a bounded
two-hour minimum workflow deadline to accommodate source exploration and repairs.

Remediation uses `openrouter/free` through Connector's platform OpenRouter credential. The normal UI does not select individual upstream models. BYOK, paid models, direct worker provider SDKs, and legacy provider fallbacks are disabled for this path.

The prompt builder permits up to 120,000 characters of task and initial source context. Planner and implementor can request indexed read-only source evidence, with at most 16 source tool actions shared across the packet. Those observations stay in process-local graph state across stages and the single actionable repair; they do not expand editable paths or enter unrestricted events. Each stage has a 12-step ceiling and fails explicitly if exploration ends without a final contract. Additional evidence is fitted at the gateway with the complete prompt. Context exhaustion requires splitting the packet, never silently dropping earlier reads.

The free router uses a context fit estimate (ASCII code at three characters per token, conservative UTF-8 bytes for non-ASCII), including tool arguments and reasoning, plus an output reservation. This estimate is not an exact upstream tokenizer. Account rate limits remain separately enforced. The older small per-request cap still applies to legacy individual low-quota routes.

The planner and implementor retain strict JSON contracts, but enforce them locally rather than sending `response_format: { type: "json_schema" }` upstream. OpenRouter free upstreams do not uniformly support that optional extension and may otherwise return HTTP 400. Each stage prompts for one JSON object, parses and validates exact required keys/types/path allowlists locally, and makes one bounded contract-repair retry before rejecting the patch. Search/replace blocks are applied deterministically and converted to unified diffs before safety review.

Both prompts include their complete output schema. Planner `targets[].findings` is an array of string identifiers, not copied finding objects. If it remains invalid after the contract retry, the graph stops that packet before the implementor or reviewer. The packet stays unresolved; accepted results from earlier packets remain available and independent later packets continue. Account capacity failures stop further dispatch while retaining completed results. A running image must contain these gates: editing host source does not update the production image.

Gateway scheduling owns free-model fallback, cooldowns, and shared account quota reservations. Upstream malformed-schema, authentication, model, and capability failures are normalized to retryable platform-unavailable outcomes, so remediation never exposes upstream 400/401 failures to the product flow. Prompts are packetized below the OpenRouter free request budget; streaming security requests are unavailable because they do not use the shared reservation path.

## Request path and operational invariants

`Connector/src/app/api/remediate/start/route.ts` accepts the user action, authenticates project ownership, and starts the workflow. Agentic calls Connector through `ai_gateway.py` with `DEPLAI_SERVICE_KEY` and the delegated user/org headers; the service key is internal service authentication, never an OpenRouter credential and never browser-visible. Connector's remediation gateway resolves only an active, zero-priced OpenRouter coding variant and sends the call using the platform OpenRouter credential.

For a host-run Connector with Docker workers, set worker `DEPLAI_AI_GATEWAY_URL`
and `CONNECTOR_URL` to `http://host.docker.internal:3000` (and UI/UX
`UIUX_CONNECTOR_URL` likewise). Use `http://connector:3000` only when the browser
uses that Docker Connector and its database. The two databases can have different
user and organization IDs; sharing a service key does not make their identities
interchangeable. Organization errors retain their authorization status/code at
the gateway. These errors stop further remediation packets, preserving earlier
patches, rather than repeating an invalid request against every file group.

Keep these invariants when changing any remediation entrypoint:

1. Do not accept an access-mode override, a provider key, a direct provider base URL, or a paid model for remediation.
2. Do not add a worker-side fallback after a Connector error. A platform route error must remain a normalized remediation error.
3. Validate model eligibility, request budget, and JSON output locally at the Connector/workflow boundary; do not rely on provider-specific `json_schema` support.
4. Preserve the bounded retry policy: one generation response and at most one contract-repair request per stage. Retryable quota/cooldown behavior is owned by the gateway scheduler.
5. Log opaque reason codes and request metadata only. Never log delegated credentials, the platform key, or unredacted source beyond the existing run/artifact controls.

The corresponding customer-facing policy is in `docs/guide/agents/security-agent.md`; it intentionally describes the user-visible eligibility and recovery behavior without exposing service credentials, route names, or quotas.

## Patch review and verification

The product track copies the exact scan source into an isolated remediation checkout. Patches remain proposed until validated. Absolute paths, traversal, Git metadata and control characters are rejected. Review provides per-file diffs and downloadable patches. Explicit approval is required for PR creation; the current branch SHA must still match the scan source.

Final approval triggers repository security checks. Failed, missing or inapplicable checks never verify a finding fixed. Dependency findings remain unverified even when absent from a manifest rescan: package-manager lockfile regeneration and behavior validation are still outstanding. Secret rotation and live cloud actions remain manual. ZIP projects receive patches rather than copying the isolated checkout over user source.

## OpenWiki

The optional worker is pinned to OpenWiki 0.5.0 and runs in a separate checkout. Its short-lived gateway capability is scoped to the user, run and model. Wiki requests share the remediation quota/budget policy and are capped at two inference requests. Cached context is keyed by tenant/repository/revision/generator and packet source evidence. Failure falls back visibly to direct source inspection.

`SECURITY_OPENWIKI_GENERATE` defaults to false. Automatic generation requires fixture evidence of lower total token usage without worse repairs; that comparison has not been completed. Generated documentation is excluded from remediation patches.

## Remaining acceptance work

- Package-manager lockfile regeneration, relevant application tests, and verification fixtures demonstrating vulnerability removal without scanner suppression.
- Full consolidation of legacy HTTP entrypoints and reliable remediation restart continuation.
- Complete unified finding ID propagation through legacy SAST/SCA ingestion and packet outcomes.
- Dedicated affected-check/full-scan controls and browser end-to-end acceptance, including stale-head PR rejection.
- Database-backed quota/cost concurrency, actual OpenRouter throttling behavior, Docker scanners, and OpenWiki comparison fixtures.

The local unit/type checks do not establish production readiness. Automatic SDLC triggers and OpenWiki generation remain disabled pending these checks.


## Explicit paid remediation override

The operator can set Connector `SECURITY_REMEDIATION_MODEL=z-ai/glm-5.3-flash`
and `SECURITY_REMEDIATION_MAX_USD` (positive, at most 2). Each newly authenticated
start registers the approved model and cap against the run, user and organization
in `security_paid_run_budgets_v2`. Existing runs are not upgraded. Browser model
preferences cannot enable paid execution. The gateway checks the registration
before selecting GLM; UI/UX retains its free route.

Paid requests reserve conservative input bytes plus framing and the bounded
output allowance under a locked row before dispatch. Reservations include retries;
timeouts and uncertain provider failures retain their reservation. Successful
responses settle using observed tokens at capped rates; unknown usage retains the
full estimate. Provider routing is limited to $0.15/M input and $0.50/M output,
with at most 4096 output tokens per request and a 512-token reasoning allowance. The run ledger conservatively adds reported reasoning tokens to output costs and reserves the extra allowance, even when a provider already includes reasoning in output usage. No other paid model fallback is used.
The paid route does not inherit the free-account local cooldown bucket. Upstream
limits still follow normal bounded retry handling. The worker token budget is an
additional ceiling, not permission to exceed the USD budget. Verify the database
cap with `npx tsx scripts/test-remediation-paid-budget.ts` (isolated fixture rows,
no inference). Reaching the cap stops dispatch and preserves unresolved findings.


## User activity view

The security run page presents existing sanitized events as a timestamped activity
view. Key events are the default; warnings/errors and all technical details remain
available. Packet and accepted-patch counts derive from observed supervisor events,
with replayed batch results counted once. A local acceptance never becomes a
verified-fixed claim. The age indicator measures time since the last received event;
it does not imply a worker heartbeat or a completion estimate. Auto-scroll can be
paused, and Copy log preserves original event text and timestamps. New starts log
the server-selected model, recorded spending cap and run ID. This frontend change
does not require interrupting active workers. Focused checks:
`npx tsx --test src/features/security/remediation-log.test.ts` from Connector.


## GitHub publication and completion

A PAT is optional. The authenticated start route requests a GitHub App installation
token with contents/write and pull_requests/write when no PAT override is supplied.
The final Approve & Create PR action remains the explicit publication authorization.
After an observed PR URL, the UI offers View pull request, Run verification scan,
and Done. It never merges automatically. A missing token or failed publication is
reported as failed, not as successful remediation persistence.

Final assembly and PR construction combine independently generated diffs against
the same source baseline, deduplicate exact edits, and reject conflicting line
changes. Later sequential-round diffs must apply exactly to the accumulated state.
No overlapping conflicting edit is silently selected. Focused tests live in
`remediation_pipeline/test_patch_assembly.py`. A failed earlier run can retain
incompatible candidates; a passing per-packet review is not proof the combined
patch set applies.
# Saved remediation Sessions

Every new remediation run receives its own workspace Session, linked by run ID,
user, organization and project. Session creation must succeed before the browser
can start execution. Sessions expose the durable Mongo journal and packet results
through an authenticated archive endpoint, with a downloadable JSON record.
The export includes all recorded events, not the recovery feed's 200-event window.
Existing sanitization limits still apply; credentials and raw prompts are excluded.

`REMEDIATION_MONGODB_RETENTION_DAYS` has a 30-day minimum. Terminal transitions
extend run, event, packet and token-budget retention from completion. MySQL Session
metadata has no automatic expiry. Mongo must be configured for durable archives;
unavailable or expired archives produce an explicit error, not an empty success.

Credits shown in the archive come from the authoritative remediation settlement
ledger entry. Missing settlement is reported as not recorded, never assumed zero.
These credits are distinct from OpenRouter dollar spend. Worker settlement also
updates Session completion without requiring a connected browser. Local patch
acceptance remains distinct from an applicable security rescan and verified fixes.

New HTTP remediation starts retire and join any same-user, same-organization active worker before installing a new context. WebSocket starts remain reconnect operations. Connected Stop & reset sends cancel; disconnected reset is recovered by the next authenticated HTTP start. Cancelled runs preserve their journal and patches.
