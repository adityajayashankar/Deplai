# DeplAI production release and owner acceptance

Assessment date: 2026-09-14. **Release status: not signed off.**
This is a source/configuration review with selected local tests, not a live
production audit, penetration test, load test, or completed recovery drill.
Passing configuration checks or a health endpoint is not a release approval.

## Findings and work completed

| Area | Evidence / disposition |
| --- | --- |
| Configuration | Production Compose defaults billing flags to false. Preflight now rejects that configuration for public release. Set both flags explicitly to true and rebuild Connector. |
| Dependencies | SecurityRunStore requires MongoDB in production; preflight now requires its URI and the OpenRouter key used by GLM workflows. Credentials present does not prove connectivity, model availability, or pricing. |
| Private admin | Production container previously bound its internal loopback interface despite host port publishing. It now explicitly binds the container interface while host publication remains 127.0.0.1:3100. The custom server overwrites client forwarding headers with the socket peer. Verify actual SSM/SSH access after rebuilding. |
| User grants | New admin_plan_grants migration must be installed on the production database. Local installation does not migrate production. Test grant, expiry, revocation, and credit grants on a test organization. |
| CI | No .github/workflows directory was found in this checkout. External CI and branch protections are unverified. A release must have a clean build and checks bound to its exact commit. |
| Recovery | Runbook described backups but this review found no restore evidence or automated backup job in deploy/. Include MySQL, MongoDB, Terraform state, UIUX run stores, and artifacts. |
| Isolation | Agentic holds the host Docker socket and shares the deployment host with control-plane services. This is a privileged trust boundary requiring independent security review before untrusted public workloads. |
| Documentation | docs/internal/known-gaps.md and billing.md contain historical claims that disagree with current source. Do not use their provider, pricing, or durability descriptions as release evidence without reconciling them. |
| Billing policy | Current tests enforce zero charge for failed standard scans; the engineering guide says 0.5. Resolve the intended policy and align implementation, tests, and customer wording before release. |

Checked locally in this assessment: organization tests 24/24, billing 66/66,
AI platform 46/46, WebSocket 16/16, admin server boundary 2/2, offline
production preflight 3/3 (157 tests total).
Production Docker builds, external provider flows, browser acceptance, scanner
execution, AWS runtime health, and restoration were not proved by these tests.

## Release record: complete for every candidate

- Owner, date, exact Git commit and container image digests.
- Environment/domain and schema migration versions.
- Test/build reports and sanitized run IDs for the cases below.
- Backup location, backup age, last successful restore, measured recovery time.
- Previous working release digests and tested rollback instructions.
- Outstanding defects, disabled features, and explicit release decision.

Build from a clean checkout and locked dependencies on Linux, matching the
production architecture. Build every shipped image, including admin and UIUX.
Scan those exact images and dependencies; triage reachable critical/high issues.
Run the relevant Connector test scripts and type checks, admin security tests,
UIUX worker tests, Agentic scan/DAST/remediation tests, and Terraform/runtime
tests. Do not run production migrations or destructive tests as part of a
generic unit-test job. Configure branch protection to require these results.

## Human acceptance: use staging accounts and resources you control

| Check | What you must observe |
| --- | --- |
| New user | A new GitHub login can onboard and select an installed repository. Logout and revoked installation have clear recovery. |
| Tenant isolation | Create unrelated organizations A and B. With A's session, change project/run/artifact IDs to B's in browser requests. APIs reject reads and writes; no data or credentials appear. Repeat with viewer role and suspended membership. |
| Owner console | Public /admin and /api/admin return no console/data. Port 3100 is unreachable externally; SSH/SSM tunnel works. Owner login/MFA and password confirmation work. Grant Pro without payment, grant credits, verify effective access, expire/revoke, verify restoration and audit evidence. |
| Money | Complete a small authorized checkout, verify one invoice and one grant. Replay the same provider webhook; no duplicate credits. Exercise failed payment, cancelled checkout, refund, and retry. Compare provider dashboard, ledger, displayed balance, and invoice. Never infer success from the browser callback alone. |
| Spend limits | Use controlled low budgets; concurrent requests and retries cannot spend beyond reserved limits. Confirm actual OpenRouter model and charges. Free grants do not disable global metering. |
| Scan | Use fixtures with known findings and a clean fixture. Missing/malformed reports must fail, not appear clean. Verify findings and scanner versions; timeout one module and observe unrelated modules continue. |
| Remediation | Critical/high only. Inspect diffs; applicable security checks determine verified fixes. Manual rotations remain unresolved. Disconnect/reconnect; accepted patches survive. A failed PR can retry without paying for another scan. |
| UIUX | Inspect before/after diffs and run repository tests. Confirm only approved presentation changes. Apply and PR each work on separate test branches. Move the branch during review; stale changes must be rejected. |
| PR publication | GitHub shows the correct bot, repository, branch, files, and PR URL. Double-click/retry/disconnect does not duplicate publication or leave the UI falsely running. Test revoked write permission. |
| Deployment | Use an isolated AWS account/environment with a spending limit. Confirm reviewed Terraform plan, secret delivery, build, process startup, public endpoint, actual login/API call and database operation. Reboot EC2 and repeat. Terraform success alone is insufficient. |
| Runtime security | Post-deploy uses authorized runtime/cloud checks; no automatic repeat of SAST/SCA/SBOM. DAST cannot target an unowned/internal address or run active checks without approval. |
| Retention | Reopen run documentation through Sessions after browser and worker restarts. Verify TTL configuration retains required evidence for at least 31 days, including diffs, outcome and usage. A backup alone is not accessible session history. |
| Failure/recovery | On staging, restart workers during runs; simulate provider 429/timeout and database loss. Every run reaches an honest recoverable/terminal status; retries do not duplicate charges, PRs or applies. |
| Restore | Restore database and artifact backups into an isolated environment. Open a historical session and its diff, check wallets and grants, and verify Terraform state correspondence. Do not run restored jobs against live providers. |
| Capacity | Test agreed concurrent scans/remediations and large repos. Measure latency, queue time, memory, disk, and failure rate. Resource exhaustion must not take down auth or billing. |
| Rollback | Deploy the candidate to staging, then restore previous images with the current schema. Verify old code remains compatible or document a forward-fix recovery. Never delete volumes to roll back. |

For each row, record PASS/FAIL/NOT RUN plus evidence. NOT RUN is not PASS.
Use a second human reviewer for money, cross-tenant access, secret handling,
Docker isolation and cloud-operation boundaries. OWASP ASVS provides a
structured verification baseline: https://owasp.org/www-project-application-security-verification-standard/
Docker documents why daemon access is privileged:
https://docs.docker.com/engine/security/

## Keep it ready after launch

- **Continuously:** alert a named person on outages, stuck queues, failed jobs,
  abnormal spend, webhook failures, backup failures and disk pressure. Test
  that the notification actually arrives. Record request/run IDs without secrets.
- **Daily:** review failures, provider/ledger reconciliation, capacity, unexpected
  admin grants and backup freshness. Establish your response owner and escalation.
- **Every release:** repeat affected acceptance cases, build and scan exact images,
  back up before migration, canary the release, and verify rollback readiness.
- **Weekly:** review dependency/security updates and access changes; verify alert
  delivery and investigate repeated support failures.
- **Monthly:** restore into isolation, review least privilege and spend limits,
  exercise account/secret recovery, verify retention and delete expired artifacts.

Set measurable service goals before launch: tolerated downtime, maximum time to
recover (RTO), maximum acceptable data loss (RPO), and supported concurrency.
The current single-host deployment has a host-level single point of failure.
Either accept and communicate the measured recovery limits or separately design
redundancy; do not promise high availability from restart policies alone.

## Practical release rule

Do not open general public access while cross-tenant isolation, money integrity,
private admin access, secret handling, restore/rollback, or privileged execution
containment is failed or unverified. Keep incomplete features disabled. An
invite-only beta still needs these safety checks, but can have smaller measured
capacity and explicitly stated availability limits.
