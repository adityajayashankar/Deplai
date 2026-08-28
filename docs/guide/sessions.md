# Sessions

**Sessions** lists past and in-flight runs: which service, which project, status, current stage, and logs.

## What gets a session

| Service | When |
| --- | --- |
| Security Agent | Scan and remediation |
| UI/UX customizer | Customization runs |
| Deploy | Terraform generate and apply |
| Code Reviewer | Reserved; not a live agent yet |

Statuses you will see: queued, running, completed, failed, needs review.

## Find a run

1. Open **Sessions**.
2. Filter by service or status, or search title/repo.
3. Copy the session id if you need to send it to `support@deplai.tech`.

## Reopen a run

Open a row.

- Security Agent shows the **Pipeline** rail as a record of where the run stopped. It does not resume the live scan by itself.
- Deploy shows Queued → Generate → Apply → Done.
- UI/UX shows Queued → Running → Review → Done.
- **Logs** keep updating while the run is queued or running.

Live work still happens on Security Agent, Deploy, or UI/UX customizer. Sessions is the history after you leave those pages.

Related: [Security Agent](agents/security-agent.md) · [Deploy](agents/deploy.md)
