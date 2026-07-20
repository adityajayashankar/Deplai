# Production Docker deployment

This bundle packages the production Connector UI/API, Agentic Layer, Terraform
Agent, remediation pipeline, Diagram/Cost agent, customization backend, MySQL,
Neo4j, Qdrant, and a Caddy HTTP proxy. The standalone design
experiments elsewhere in the repository are not application runtime services
and are intentionally not started.

## 1. Prepare the Linux host

Use a supported Linux server with Docker Engine and the Docker Compose plugin.
For an initial multi-user deployment, start with at least 8 vCPU, 32 GB RAM,
and 200 GB SSD. Allow inbound TCP ports 22 and 80 only; restrict SSH to a
VPN, bastion, or known administrator IP addresses.

Set `APP_DOMAIN` to the EC2 public IPv4 address before the first start. This
deployment serves plain HTTP only; it does not obtain TLS certificates and it
does not publish port 443.

## 2. Configure secrets

```bash
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
openssl rand -hex 32
stat -c '%g' /var/run/docker.sock
```

Put distinct generated values into `DEPLAI_SERVICE_KEY`, `WS_TOKEN_SECRET`,
`SESSION_SECRET`, and `ADMIN_ACCESS_KEY`. Set `DOCKER_GID` to the value printed
by `stat`. Encode the GitHub App PEM as one line with `base64 -w0` and place it
in `GITHUB_PRIVATE_KEY`.

Set the GitHub OAuth callback to:

```text
http://<APP_DOMAIN>/api/auth/callback
```

Set `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_AGENTIC_WS_URL`, and `CORS_ORIGINS` to
the same HTTP public IP. These `NEXT_PUBLIC_*` values are compiled into the
Connector browser bundle, so rebuild the Connector image when they change.

## 3. Validate and start

```bash
docker compose --env-file deploy/.env -f docker-compose.production.yml config --quiet
docker compose --env-file deploy/.env -f docker-compose.production.yml up -d --build
docker compose --env-file deploy/.env -f docker-compose.production.yml ps
docker compose --env-file deploy/.env -f docker-compose.production.yml logs -f caddy connector agentic-layer
```

Only Caddy publishes host port 80. MySQL, Neo4j, Qdrant, the customization
backend, Connector, and the Agentic Layer have no host port mappings.

Verify:

```bash
curl -fsS http://<APP_DOMAIN>/api/health
curl -fsS http://<APP_DOMAIN>/agentic/ready
```

The MySQL initialization script runs only when `mysql_data` is empty. Do not
delete that volume during upgrades. Apply future schema changes through an
explicit migration before rolling out new application code.

## 4. Operate safely

Create encrypted off-server backups of `mysql_data`, `neo4j_data`,
`qdrant_data`, `agentic_runtime`, `github_repos`, `local_projects`, and
`customization_state`. Test restoring a MySQL backup regularly. Monitor disk
usage: cloned repositories, scanner databases, Docker images, and Terraform
workspaces can grow quickly.

To update an approved release:

```bash
git pull --ff-only
docker compose --env-file deploy/.env -f docker-compose.production.yml up -d --build --remove-orphans
```

## Scanner trust boundary

The present Agentic implementation creates Syft, Grype, Bearer, Git, Alpine,
and Terraform worker containers through `/var/run/docker.sock`. Docker-socket
access is effectively host-administrator access. This stack keeps the Agentic
API off the public network, but it does **not** make arbitrary untrusted source
code safe to execute on the same host.

Use this single-server design for trusted teams and repositories. Before
opening it to arbitrary public repositories, move scanner/remediation workers
to dedicated isolated VMs or a sandbox runtime such as gVisor/Kata, with no
host Docker socket exposure.
