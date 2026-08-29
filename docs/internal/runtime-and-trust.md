# Runtime, Compose, and trust

Companion to [Overview](overview.md). How processes are actually started and what they can touch.

## Compose files

| File | When to use | Public ports |
| --- | --- | --- |
| `compose.yaml` | Default local full stack (`deplai-local`) | Connector 3000, Agentic 8000, customization 8010. MySQL internal |
| `docker-compose.dev.yml` | Agentic hot-reload against host Connector | Agentic **8001→8000** |
| `docker-compose.production.yml` | Deploy (`--env-file deploy/.env`) | **Caddy 80/443/443udp only** |

## Volumes (`compose.yaml`)

| Volume | Mount | Contents |
| --- | --- | --- |
| `mysql_data` | MySQL datadir | Durable schema + rows |
| `github_repos` | Connector `/app/tmp/repos`; Agentic `/repos:ro`; customization same | GitHub clones |
| `local_projects` | Connector `/app/tmp/local-projects`; Agentic `/local-projects:ro` | ZIP extracts |
| `agentic_runtime` | `/workspace/runtime` | Agentic scratch |
| `iac_workspaces` | `/workspace/iac-workspaces` | Terraform workspaces (`IAC_WORKSPACE_ROOT`) |
| `codebase_deplai` | Agentic `/var/lib/deplai/codebase` | Copied trees for scanners |
| `security_reports` | `/var/lib/deplai/security-reports` | Scan JSON/HTML |
| `llm_output` | `/var/lib/deplai/llm-output` | Named `LLM_Output` |
| `grype_db_cache` | Grype DB | Vulnerability DB cache |
| `customization_state` | tenants dir | UI/UX tenant copies |
| `customization_logs` | logs dir | Customization logs |

Agentic also bind-mounts `./Agentic Layer` for `--reload`. Production images do not rely on that bind.

## Trust checklist

1. Browser holds only `deplai_session`. No service key, no AWS keys, no Docker.
2. Connector verifies GitHub/ZIP **ownership** before clone path or `project_id` is sent upstream.
3. Agentic authenticates Connector with `X-API-Key`. Public ingress only forwards `/agentic/ws/*`. WebSockets need a short-lived HMAC (`WS_TOKEN_SECRET`) bound to user + project.
4. AI calls from Agentic/customization send `x-deplai-user-id` so BYOK cannot be confused across users.
5. Terraform apply requires explicit `confirm_plan_summary`.
6. Remediation GitHub write uses a **write-scoped installation token** only after Review (or a user-pasted PAT that is not vaulted).
7. Docker socket on Agentic: any RCE in Agentic is host-level. Network isolation is the production control.

## Production Caddy

`deploy/Caddyfile` terminates TLS. Connector is the public origin. Agentic is reached from Connector over the Docker network (`AGENTIC_LAYER_URL=http://agentic-layer:8000`). `DEPLAI_AI_GATEWAY_URL=http://connector:3000` so Agentic meters through Connector, not a public URL.

### Browser WebSockets (`/agentic/ws/*`)

Only scan, remediate, and pipeline live logs are exposed publicly. Flow:

```text
Browser:  wss://<APP_DOMAIN>/agentic/ws/scan/{project_id}?token=…
Caddy:    uri strip_prefix /agentic
Agentic:  /ws/scan/{project_id}
```

Caddy must strip **`/agentic` only** (`handle_path /agentic/*` or `uri strip_prefix /agentic`). Using `handle_path /agentic/ws/*` strips `/agentic/ws` and forwards `/scan/{id}` — FastAPI will not match. After Caddyfile edits: `docker compose --env-file deploy/.env -f docker-compose.production.yml up -d --force-recreate caddy`.

Connector-side helpers: `Connector/src/lib/agentic-websocket.ts`. Ops check: authenticated `GET /api/scan/ws-health`.

Related: [Local development](local-development.md) · [Environment](environment.md)
