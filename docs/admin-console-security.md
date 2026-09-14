# Deplai Private Owner Admin Console

## Architecture

The admin console is a **separate Next.js application** in `admin-console/`. It is not mounted under the public Connector app and is not proxied by Caddy.

```text
Internet -> Caddy -> Connector (public app, port 3000)

Owner laptop -> SSM port forward -> EC2 127.0.0.1:3100 -> admin-console
```

Security boundaries:

1. Network isolation (localhost bind + SSM tunnel)
2. Reverse proxy hardening (public `/admin*` paths return 404)
3. Owner password + MFA authentication
4. Server-side sessions with CSRF protection
5. Step-up authentication for dangerous operations
6. Tamper-evident audit logging

## Local development

```bash
cd admin-console
cp .env.example .env.local
npm install
npm run migrate
npm run admin:bootstrap
npm run dev
```

Open `http://127.0.0.1:3100`.

## Bootstrapping OWNER

There is no HTTP registration endpoint. Bootstrap interactively:

```bash
cd admin-console
npm run migrate
npm run admin:bootstrap
```

The command requires a private interactive terminal, hides password input, and creates the owner, MFA credential and recovery codes in one transaction under a named lock. A repeated invocation exits successfully without changing an existing owner or printing new enrollment material. It never repairs or replaces an existing owner automatically. Store the initial TOTP enrollment and recovery codes offline; do not record the terminal session. The development reset command is disabled in production.

## Production deployment

The production compose file adds `admin-console` with:

- internal Docker network only
- host bind `127.0.0.1:3100:3100` for SSM forwarding
- fail-closed startup if admin secrets are missing

Required `deploy/.env` values:

```env
ADMIN_SESSION_SECRET=...
ADMIN_AUDIT_HMAC_SECRET=...
ADMIN_MFA_ENCRYPTION_KEY=...
```

For an existing production stack, deploy only admin-console from the repository root on EC2:

```bash
bash deploy/redeploy-admin-console.sh
```

The script builds the admin image, runs migrations in a one-off container without published ports, then recreates only admin-console and waits for health. MySQL must already be healthy and the platform schema (projects, organizations, billing_plans) installed. A migration failure stops deployment before recreation. No other service is restarted.

Equivalent commands, useful for diagnosing a failed migration:

```bash
docker compose --env-file deploy/.env -f docker-compose.production.yml build admin-console
docker compose --env-file deploy/.env -f docker-compose.production.yml run --rm --no-deps -T admin-console npm run migrate
docker compose --env-file deploy/.env -f docker-compose.production.yml up -d --no-deps --wait admin-console
```

Migration applies all three admin migrations to `DB_NAME`, including `admin_login_attempts`. It serializes concurrent migration commands with a MySQL named lock, replays additive `CREATE TABLE IF NOT EXISTS` statements and verifies all 11 tables. MySQL DDL is not transactional: partial completion is recovered by rerunning. Existing data is preserved. The migration identity needs CREATE/REFERENCES permissions; runtime startup only checks table access. Future non-idempotent migrations require a versioned migration design before adding them to this replay list.

`npm start` validates configuration and checks all admin tables before opening the listener. It does not run DDL. To check schema independently:

```bash
docker compose --env-file deploy/.env -f docker-compose.production.yml run --rm --no-deps -T admin-console npm run migrate -- --check
```

Initial owner enrollment is a separate, interactive operation after migration. Run through a private administrative terminal with session recording disabled for this enrollment:

```bash
docker compose --env-file deploy/.env -f docker-compose.production.yml run --rm --no-deps admin-console npm run admin:bootstrap
```

The production image includes the CLI source and TypeScript alias configuration. Production uses injected environment values and never falls back to Connector's local environment files.

Both the custom server and application configuration use the same bind policy: production defaults to loopback; `0.0.0.0` requires both `ADMIN_CONTAINER_MODE=true` and Docker's `/.dockerenv` marker. Other non-loopback addresses are rejected. `ADMIN_ALLOW_UNSAFE_BIND` grants no exception. Docker detection cannot inspect host publishing rules: Compose must retain `127.0.0.1:3100:3100`, avoid host networking, and Caddy must continue blocking public admin paths. Keep EC2 inbound port 3100 closed. The Dockerfile EXPOSE declaration does not publish a port.

After redeploy, verify privately on EC2:

```bash
docker compose --env-file deploy/.env -f docker-compose.production.yml ps admin-console
docker compose --env-file deploy/.env -f docker-compose.production.yml port admin-console 3100
curl --fail http://127.0.0.1:3100/api/health
```

The port command must show `127.0.0.1:3100`. Open the SSM tunnel below and sign in: a valid owner password must advance to MFA. Health/schema checks alone do not prove password or MFA authentication. If an owner already existed before this repair, use those existing credentials.

## Opening the console on EC2

From an AWS-authenticated owner machine:

```bash
aws ssm start-session \
  --target <instance-id> \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["3100"],"localPortNumber":["3100"]}'
```

Then open `http://127.0.0.1:3100`.

## Authentication

1. Password verified
2. Pending MFA state issued (no privileged session yet)
3. TOTP or recovery code verified
4. HttpOnly session cookie + CSRF cookie issued

Dangerous operations additionally require password step-up (`refund.create`, `api_key.revoke_all`, `user.revoke_sessions`, etc.).

## Secret handling

- User passwords are never displayed
- API keys and provider secrets are masked
- Audit logs redact sensitive fields
- Amounts are stored and processed as integer paise

## Threat model (summary)

| Threat | Control |
| --- | --- |
| Public discovery of admin UI | Separate app, no Caddy route, 404 on public `/admin*` |
| Stolen user session | Admin uses separate auth domain and cookies |
| Stolen owner password | MFA required; step-up for dangerous ops |
| CSRF | Double-submit CSRF token on mutating requests |
| Duplicate refunds | Named DB lock + server-side amount validation |
| Audit tampering | Chained HMAC event hashes |

## Remaining limitations

- WebAuthn enrollment UI is scaffolded at the data-model level; TOTP is the primary bootstrap MFA today.
- Owner recovery beyond bootstrap requires a deliberate offline recovery procedure.
- The public Connector still contains legacy email-based admin helpers; they are unrelated to this private console and should be retired separately.
