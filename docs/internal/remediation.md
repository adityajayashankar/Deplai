# Remediation pipeline

The product track uses deterministic grouping and source context, then a Planner and Implementor followed by local patch review. All product inference goes through the Connector gateway. Each packet permits two generation calls and one repair after actionable validation feedback. Execution slices contain at most eight packets; completed packet results are checkpointed for continuation.

## Model and cost policy

The picker uses the refreshed OpenRouter catalog and exposes only zero-priced `:free` coding variants with sufficient context/output limits and verified coding evaluations. Remediation is always `platform` access through Connector's platform OpenRouter credential: BYOK, paid-model opt-in, direct provider SDKs, and legacy provider fallbacks are disabled. `best_coding` is a gateway routing intent used only when a saved free-model selection has gone stale.

The planner and implementor retain strict JSON contracts, but enforce them locally rather than sending `response_format: { type: "json_schema" }` upstream. OpenRouter free upstreams do not uniformly support that optional extension and may otherwise return HTTP 400. Each stage prompts for one JSON object, parses and validates exact required keys/types/path allowlists locally, and makes one bounded contract-repair retry before rejecting the patch. Search/replace blocks are applied deterministically and converted to unified diffs before safety review.

Gateway scheduling owns free-model fallback, cooldowns, and shared account quota reservations. Upstream malformed-schema, authentication, model, and capability failures are normalized to retryable platform-unavailable outcomes, so remediation never exposes upstream 400/401 failures to the product flow. Prompts are packetized below the OpenRouter free request budget; streaming security requests are unavailable because they do not use the shared reservation path.

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
