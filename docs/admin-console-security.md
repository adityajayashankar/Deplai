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

The command creates exactly one `OWNER` account, prints a TOTP secret, and one-time recovery codes. Store them offline.

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

Deploy with the existing production stack:

```bash
docker compose -f docker-compose.production.yml --env-file deploy/.env up -d --build
```

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
