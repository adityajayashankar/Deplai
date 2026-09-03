# API and automation

DeplAI's current HTTP surface primarily supports the first-party dashboard and internal service coordination. Treat routes as product APIs, not yet as a versioned public SDK contract unless a route explicitly says otherwise.

## Authentication models

| Caller | Authentication | Intended use |
| --- | --- | --- |
| Browser | Encrypted GitHub-backed session cookie | Dashboard and interactive workflows |
| User automation | Personal `dpl_live_` API token on supported authenticated routes | User-scoped automation without a browser |
| Connector to execution service | Internal service key | Private server-to-server calls only |
| Live workflow socket | Short-lived user/project-bound token | Scan, remediation, and pipeline event streams |
| Webhook provider | Provider signature | GitHub and payment event delivery |

A user API token does not grant admin rights and does not bypass project or organization permissions. Never expose an internal service key to a browser or client script.

## Route families

The dashboard uses route families for auth/session, projects and repositories, sessions, profile/settings, organizations, AI platform, security scans and remediation, DAST, customization, architecture/cost, Terraform/deployment pipeline, runtime operations, billing/invoices, and signed webhooks.

The organization routes under `/api/v1/organizations` are explicitly versioned. Most other routes are application endpoints and can evolve with the product UI.

## Common request pattern

```bash
curl -H "Authorization: Bearer $DEPLAI_API_KEY" \
  https://your-deplai-host.example/api/sessions
```

Use an environment variable or secret manager for the token. Do not paste a live token into source, shell history, documentation, logs, or support messages.

## Response and failure expectations

JSON errors generally return an `error` message with an HTTP status. Some subsystems also return a stable reason or code. Do not parse human-readable text when a code exists.

| Status | Typical meaning |
| --- | --- |
| `400` | Invalid input, missing prerequisite, or unsupported transition |
| `401` | No valid user session/token or invalid internal authentication |
| `403` | Authenticated but not authorized for the project, organization, or action |
| `404` | Resource not found within the authorized scope |
| `409` | Conflict such as an incompatible active operation or state transition |
| `429` | Rate or quota boundary |
| `5xx` | Connector, database, execution service, or external dependency failure |

## Long-running work

Do not hold one ordinary HTTP request open as the only record of long-running work. DeplAI uses a combination of creation/start routes, WebSocket or event endpoints, status routes, and durable session/deployment records.

An automation client should:

1. create or start the scoped run;
2. store the returned identifiers;
3. consume events when available;
4. poll the supported status route with bounded backoff;
5. stop at `needs_review` or an equivalent approval state;
6. verify the final artifact or health result rather than trusting transport success.

## Idempotency and retries

Assume mutation routes are not universally idempotent. Before retrying repository creation, payment verification, Terraform apply, deployment, rollback, or destroy, inspect the resource and external system for partial completion.

GET requests and explicit status reads are the safest diagnostic operations. Use subsystem-provided retry/resume endpoints only for the states they accept.

## Webhooks

GitHub and payment webhooks validate provider signatures before processing. Webhook secrets are server configuration. A successful delivery does not guarantee that downstream business processing completed; inspect provider delivery logs and the corresponding DeplAI record.

## API stability and future SDKs

There is no documented stable public SDK in the current product. Build automation against the narrowest route set you control, pin the deployed DeplAI version, test upgrades, and expect first-party application routes to change.

A future public API should add explicit versioning, machine-readable schemas, stable error codes, idempotency contracts, pagination conventions, webhook event schemas, and generated clients. That is direction, not a current guarantee.

Related: [Security and data](security-and-data.md) | [Sessions](sessions.md) | [Troubleshooting](troubleshooting.md)
