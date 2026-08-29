# Security pipeline

UI: `/dashboard/security-analysis/[projectId]`. Stage rail (`SECURITY_PIPELINE_STAGES`):

| Id | Label |
| --- | --- |
| `scan` | Scan |
| `results` | Results |
| `remediate_setup` | Agent setup |
| `remediate_run` | Remediation |
| `approval` | Review |
| `pr_rescan` | GitHub & verify |

Scan dialog (`Connector/src/components/scan-card.tsx`): **SAST**, **SCA**, **Full Scan**. DAST is configured in Security Agent with an authorized public URL.

## `scan_type` (Agentic `models.py`)

Literal: `sast` | `sca` | `all` (default `all`).

| UI | Agentic | Tools |
| --- | --- | --- |
| SAST | `sast` | Bearer → code findings |
| SCA | `sca` | Syft (SBOM) then Grype → supply chain |
| Full Scan | `all` | SAST + SCA **in parallel**, plus **secret scanning**, **IaC**, **containers**, **Kubernetes**, **CI/CD**, and **API spec** checks when matching files exist. **DAST** runs only when `dast_target_url` is a public authorized URL. |

Secrets/IaC/container/Kubernetes/CI/CD/API/DAST failures on Full Scan **do not abort** SAST/SCA (`environment.py` returns success-with-error for those branches). SAST/SCA failure can still fail the selected branch.

Modules emitted on the WebSocket: `sast`, `sca`, `sbom`, `secrets`, `iac`, `containers`, `kubernetes`, `cicd`, `api`, `dast` with statuses `QUEUED` | `RUNNING` | `COMPLETED` | `FAILED` | `SKIPPED`.

Client docs describe the user-facing modules. Scanner image names live in this handbook.

## Finding model

Normalized in `Connector/src/features/security/normalize.ts`. Severity: `critical` | `high` | `medium` | `low`. “Major” in UI = critical + high. SAST grouped as `code_security`; SCA as `supply_chain`.

PDF export: `GET /api/scan/results/pdf`.

## Live scan transport

1. Connector `POST` scan start (ownership + clone/ZIP).
2. `GET /api/scan/ws-token` — HMAC bound to user + project (`WS_TOKEN_SECRET`).
3. Browser resolves WebSocket base (`src/lib/agentic-websocket.ts`):
   - **Production** (public hostname): same-origin `wss://<APP_DOMAIN>/agentic`
   - **Local** (no Caddy): direct Agentic, e.g. `ws://localhost:8000`
   - Connects to `{ws_base}/ws/scan/{project_id}?token=…` (remediate uses `/ws/remediate/…`)
4. **Caddy** (production only): browser hits `/agentic/ws/…`; `uri strip_prefix /agentic` forwards `/ws/…` to Agentic. Do **not** use `handle_path /agentic/ws/*` — that strips too much and breaks FastAPI routing.
5. Agentic ingest into volume `codebase_deplai`, run Docker scanners, write `security_reports`.

Remediation reuses the same base resolution and token mint; `ScanProvider` (`scan-context.tsx`) owns both scan and remediate sockets.

`project_id` allowlist: `^[a-zA-Z0-9_-]{1,80}$` so it cannot reach Docker exec as a shell metacharacter.

## After Results

Agent setup picks gateway model + access mode. Remediation and PR: [Remediation](remediation.md). ZIP projects can produce local diffs; **PRs require a GitHub project**.

Related: [Agentic Layer](agentic-layer.md) · [Known gaps](known-gaps.md)
