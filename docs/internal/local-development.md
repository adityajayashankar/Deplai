# Local development

## Full stack (recommended)

From the repo root:

```bash
docker compose up --build
```

`compose.yaml` project name `deplai-local`. Services: `mysql`, `connector` (:3000), `agentic-layer` (:8000), `customization` (:8010).

MySQL is **not** published on the host; Connector reaches it as hostname `mysql`. Init schema: `Connector/database.sql`. Local DB user/password are Compose defaults (`deplai` / `deplai-local-password`) — change before any shared environment.

GitHub OAuth is dummy until you pass real `GITHUB_*` via `.env`. LLM/BYOK needs provider keys in the same file (Compose interpolates `${OPENAI_API_KEY:-}` etc.).

Agentic in this file runs as **root** only so Docker Desktop socket GID mapping is not required. Production Compose uses a non-root Agentic service.

## Agentic hot-reload only

```bash
docker compose -f docker-compose.dev.yml up --build
```

Publishes Agentic at **localhost:8001**. Mounts `./Connector/tmp/repos` and `./Connector/tmp/local-projects` read-only. Connector on the host should use `AGENTIC_LAYER_URL=http://localhost:8001`.

## Port mismatch (easy to get wrong)

| File | Agentic HTTP on host | WS default in template |
| --- | --- | --- |
| `compose.yaml` | **8000** | `ws://localhost:8000` |
| `docker-compose.dev.yml` | **8001** | still often `ws://localhost:8000` unless you change it |
| `.env.template` | `AGENTIC_LAYER_URL=http://localhost:8001` | `NEXT_PUBLIC_AGENTIC_WS_URL=ws://localhost:8000` |

Align HTTP and WS with whichever Compose file you actually started, or scans will “start” in Connector and never stream.

## Connector on the host (without Compose UI)

`cd Connector && npm install && npm run dev` — needs MySQL (`DB_*`), `.env` at repo root or Connector env, and a reachable Agentic.

Useful scripts (`Connector/package.json`): `docs:embed` (after editing `docs/guide/`), `test:docs`, `test:billing`, plus other `test:*` suites.

## Migrations on an existing volume

Compose does **not** re-run `database.sql` after the first init. Apply `Connector/migrations/*.sql` in date order (or recreate the `mysql_data` volume). There is `Connector/scripts/apply-razorpay-migration.ts` for the GST/Razorpay slice.

## Production-shaped local check

`docker-compose.production.yml` + `deploy/.env` + Caddy. Only 80/443 (and 443/udp) on the host. Do not publish Agentic or MySQL.

## What not to do

- Do not expose `DEPLAI_SERVICE_KEY` to the browser or `NEXT_PUBLIC_*`.
- Do not commit `.env`, `deploy/.env`, or real `GITHUB_PRIVATE_KEY`.
- Do not copy `docs/internal/` into `docs/guide/` or the dashboard embed.
- Do not run Agentic with a public Docker socket without network lock-down.

Related: [Overview](overview.md) · [Environment](environment.md)
