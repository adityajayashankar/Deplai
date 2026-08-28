# Agentic Layer

Path: `Agentic Layer/`. FastAPI app `main:app`. `compose.yaml` publishes **8000:8000**. `docker-compose.dev.yml` (Agentic-only hot-reload) publishes host **8001** → container **8000**. `.env.template` defaults `AGENTIC_LAYER_URL` to `http://localhost:8001`. Requires `DEPLAI_SERVICE_KEY` at startup; non-health HTTP requires matching `X-API-Key`.

## What it owns

- Scan ingest + Docker scanners + WebSocket `/ws/scan/{project_id}`
- Remediation validate/run + `/ws/remediate/{project_id}`
- Repository analysis, architecture review, architecture generate
- Cost estimate, Stage 7 approval, Infrastructure Advisor (`/api/infra/advise`)
- Terraform generate / consult / apply / status / stop
- AWS runtime details, instance actions, destroy, app-secrets
- Cleanup and `/health` `/ready`

Scan/remediation/pipeline **context is in-process**. Restart = lost live run (session rows in MySQL still exist if Connector wrote them).

## HTTP surface (`main.py`)

All of these except `/health` and `/ready` need the service key.

| Method | Path |
| --- | --- |
| POST | `/api/scan/validate` |
| GET | `/api/scan/results/{project_id}`, `/api/scan/status/{project_id}` |
| DELETE | `/api/scan/results/{project_id}` |
| POST | `/api/cleanup` |
| POST | `/api/remediate/validate` |
| POST | `/remediation/run`, `/status`, `/pr`, `/refresh`, `/navigate` |
| POST | `/api/repository-analysis/run` |
| POST | `/api/architecture/review/start`, `/complete`, `/generate` |
| POST | `/api/cost/estimate` |
| POST | `/api/stage7/approval` |
| POST | `/api/terraform/consult`, `/generate`, `/apply`, `/apply/status`, `/apply/stop` |
| POST | `/api/infra/advise` |
| POST | `/api/aws/runtime-details`, `/instance-action`, `/destroy-runtime` |
| POST | `/api/aws/app-secrets/list`, `/upsert`, `/delete` |

WebSockets: `/ws/scan/{project_id}`, `/ws/remediate/{project_id}`, `/ws/pipeline/{project_id}`.

## Source ingest

`environment.py` copies GitHub or local trees into Docker volume `codebase_deplai` under `{project_id}/`. GitHub clones on Connector are mounted read-only at `/repos`. ZIP trees at `/local-projects`.

Path mapping helpers also exist in `deployment_packager.py` (`Connector/tmp/repos` → `/repos`).

## Docker

The container mounts `/var/run/docker.sock`. Workers include:

| Image | Module |
| --- | --- |
| `bearer/bearer:latest-amd64` | SAST (`bearer.py`) |
| `anchore/syft`, Grype | SBOM + SCA (`sbom.py`) |
| `zricethezav/gitleaks:v8.21.2` | Secrets (`secrets_scan.py`) |
| `bridgecrew/checkov:3.2.334` | IaC, containers, Kubernetes, CI/CD, API specs (`iac_scan.py`) |
| `zaproxy/zap-stable:2.16.1` | DAST (`dast_scan.py`), pulled only when a public target URL is supplied |
| `hashicorp/terraform:1.9.0` | Plan/apply (`terraform_apply.py`) |

Timeouts: `SCANNER_TIMEOUT_SECONDS` (default 1800), `GRYPE_TIMEOUT_SECONDS` (900), plus per-tool overrides.

## LLM from Agentic

`ai_gateway.py` (`DeplaiAI`) posts to Connector `DEPLAI_AI_GATEWAY_URL` with the service key and user id. Remediation (`claude_remediator.py`) uses that first, then legacy Anthropic/Groq/OpenRouter paths if the gateway is down. `GROQ_API_KEY` enables a cheaper remediator path — do not document that as the default product story.

Related: [Security pipeline](security-pipeline.md) · [Deploy pipeline](deploy-pipeline.md) · [Remediation](remediation.md)
