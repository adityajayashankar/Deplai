# Security pipeline

The product flow is Scan → unified findings → free platform remediation-model selection → patch review → verification and approved PR. Security remediation is Connector platform OpenRouter only: BYOK, paid-model selection, direct provider calls, and worker-side fallback routes are intentionally excluded. Implementation is in progress; automatic checks remain disabled until staging acceptance.

## Execution and evidence

`Agentic Layer/sdlc_pipeline.py` registers scanner images, report formats, dependencies and phases. Source runs Gitleaks/Bearer; build runs Syft followed by Grype and Checkov Dockerfiles; predeploy runs Checkov IaC/Kubernetes/CI/CD/OpenAPI; runtime runs authorized ZAP; operations runs Prowler when AWS credentials are supplied. An image digest schedules separate image SBOM/Grype reports.

Independent adapters run with bounded concurrency within sequential phases. Tool failure does not abort unrelated phases. Syft failure blocks its source Grype dependency. Missing prerequisites produce explicit skipped coverage. Report validation is required for completion; zero checked targets are not applicable. Unknown checked-target counts remain unknown.

`scanner_runtime.py` records actual container identity, image identity, timestamps and exit codes. Sanitized scanner output and separately labeled worker heartbeats reach the UI. Live module updates preserve earlier execution evidence.

## Persistence and source identity

HTTP `POST /api/scan/start` schedules scanning independently of browser connections. `run_id` and event sequence numbers are persisted through the existing Mongo integration. Project leases prevent simultaneous mutation of the legacy project checkout. REST returns the same job state; reconnect replays events. Expired worker leases report interruption rather than successful completion.

Production requires `MONGODB_URI` (`SECURITY_DURABLE_REQUIRED=true`, also enforced for `APP_ENV=production`). Reports and source snapshots are archived by run. Requested Git SHAs are checked out explicitly and embedded clone credentials are removed even on checkout failure. Generated artifact staging rejects symlink destinations.

Full scan execution still uses a project checkout protected by a lease; fully isolated per-run execution and automatic worker restart continuation are outstanding. Interrupted work must currently be restarted. Cross-worker live subscription behavior and Mongo recovery require integration tests.

## Advisory SDLC integration

GitHub push/PR/workflow/deployment events and the deployment pipeline enqueue deduplicated checks. The dispatcher publishes neutral GitHub check results. Publication errors are stored explicitly. These checks do not change deployment decisions or branch protection.

`SECURITY_SDLC_AUTOMATIC` defaults to false. Configure it consistently on Connector and Agentic only after staging verification. Deployment project mapping, runtime authorization, generated artifacts, image digest delivery and cloud credential retrieval require end-to-end acceptance. OpenWiki generation is separately disabled by default.

## Remediation handoff

After finding selection, Connector enforces a platform-owned eligible free coding model and starts the Agentic workflow with service authentication. The workflow keeps strict response contracts locally: it validates a single JSON object and patch-path constraints, then permits one bounded contract-repair attempt. It must normalize upstream authentication, capability, malformed-output, and quota failures into product remediation failures rather than exposing raw upstream 400/401 responses or attempting a provider bypass. See [Remediation](remediation.md) for the full invariant list.

## Verification boundary

Focused local tests cover report schemas, task startup/replay, truthful failure states, redaction, remediation workflow bounds and model eligibility. Docker is currently unavailable locally, so actual scanner fixtures, Mongo restart/concurrency tests, provider account quota tests and the browser-to-approved-PR scenario have not passed acceptance yet.

Related: [Remediation](remediation.md).
