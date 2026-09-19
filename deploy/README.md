# Production Docker deployment

For admin-console schema/bind repairs on an existing stack, run `bash deploy/redeploy-admin-console.sh` from the repository root. It builds, migrates and recreates only admin-console. Initial owner enrollment is separate; see [admin production operations](../docs/admin-console-security.md#production-deployment).

This bundle packages the production Connector UI/API, Agentic Layer (including
the Terraform Agent, remediation pipeline, and Diagram/Cost agent),
customization backend, MySQL, Qdrant, and a Caddy TLS proxy. The
standalone design experiments elsewhere in the repository are not application
runtime services and are intentionally not started.

## CI/CD deployment

The repository pipeline is `.github/workflows/ci-cd.yml`. Pull requests run the
Connector, admin, Agentic, customization, UI/UX, Terraform, and production
Compose checks. A version tag (`v*`) or a manually dispatched workflow can run
the production deployment after those checks pass. Production is a protected
GitHub Environment, so configure required reviewers before using it.

The deployment job uses GitHub Actions OIDC and AWS Systems Manager; it does not
store an EC2 SSH key or production `.env` in GitHub. Configure these repository
or `production` environment variables:

| Variable | Value |
| --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | IAM role trusted for the GitHub OIDC subject `repo:OWNER/REPO:environment:production` |
| `AWS_REGION` | Host region; the current production instance is in `eu-north-1` |
| `DEPLOY_INSTANCE_ID` | The EC2 instance ID running the production Compose stack |
| `DEPLOY_APP_DIR` | Existing checkout on the host; current production uses `/opt/deplai/Deplai` |
| `APP_DOMAIN` | Public HTTPS hostname used for the workflow deployment link |

The AWS role needs permission to call `ssm:SendCommand`,
`ssm:GetCommandInvocation`, and `ssm:ListCommandInvocations` for the selected
instance. The EC2 instance profile needs `AmazonSSMManagedInstanceCore`. The
host must already contain a clean checkout, `deploy/.env`, Docker Compose, an
origin credential with read-only access to this repository, and the required
named volumes. Prefer an SSH deploy key or an instance-managed Git credential;
do not put a GitHub token in the workflow command. `deploy/remote-deploy.sh` fetches the exact commit,
runs the existing preflight, builds the five shipped application services, waits
for Compose health checks, and verifies scan storage. It never prints the
production environment.

The first version deploys from source on the existing single EC2 host. It is
intentionally separate from customer Terraform applies: those still require a
reviewed plan and explicit `confirm_plan_summary=true`. A later hardening step
can publish immutable images to ECR and make the host pull image digests rather
than rebuilding locally.

After configuring the environment and host, push a branch or open a pull request
to run validation. Deploy a reviewed release with `git tag v0.0.5 && git push
origin v0.0.5`, or use **Run workflow** for the selected commit. A tag or manual
run pauses at the protected `production` environment until its required
reviewers approve it.

Use **one x86_64 EC2 host** and `docker-compose.production.yml`. Do not use
`compose.yaml` (local development). Do not add RDS, ALB, ECS, or a second
application EC2 for DeplAI itself. Customer AWS accounts stay in the product
UI; they are not this host.

## Scan storage error after deployment

Run this from the production checkout to check the running Agentic container's
actual MongoDB configuration and network, without rebuilding or restarting:

```bash
bash deploy/check-scan-storage.sh
```

The check identifies Atlas versus other endpoints and prints only a safe failure
category. It pings MongoDB and initializes the same required indexes as scan
startup; it does not create scan runs or delete data. `OK` confirms connectivity
and index initialization, not a complete scan or restart-recovery test.

- `MISSING_URI`: recreate Agentic with the current Compose file (private Mongo default), or configure an external `MONGODB_URI`.
- `AUTHENTICATION`: correct database credentials, URI escaping and `authSource`.
- `AUTHORIZATION`: give the service the required database read/write and index permissions.
- `INDEX_CONFLICT`: inspect existing indexes and duplicate events with an operator;
  do not delete history or drop indexes blindly.
- `UNREACHABLE` / `CONFIGURATION`: check the production server's network access,
  DNS, MongoDB availability and TLS configuration. Do not disable TLS validation.

After correcting `deploy/.env`, recreate Agentic during an idle maintenance
window (active workers are interrupted), then rerun the check:

```bash
docker compose --env-file deploy/.env -f docker-compose.production.yml up -d security-mongo
docker compose --env-file deploy/.env -f docker-compose.production.yml up -d --no-deps --build --force-recreate agentic-layer connector
bash deploy/check-scan-storage.sh
```

Changing the file alone or using `docker compose restart` does not replace the
container environment. Keep the existing database and its history. A configured
external URI remains authoritative; repair its credentials/network rather than
clearing it to hide a failure. Switching to the private database requires an
explicit history migration decision.

Before replacing an older Agentic container, preserve existing deployment packages:

```bash
docker compose --env-file deploy/.env -f docker-compose.production.yml exec -T agentic-layer python -c 'from pathlib import Path; import shutil; source=Path("/workspace/Agentic Layer/.deplai_runtime/deployment_packages"); target=Path("/workspace/runtime/deployment_packages"); shutil.copytree(source, target, dirs_exist_ok=True) if source.is_dir() else None'
```

New packages use the persistent runtime volume. If the old container and archive
are already gone, regenerate infrastructure and review the new plan before applying.
No archive should be reconstructed from an unreviewed newer repository revision.

A credential-bearing MongoDB URI was removed from a tracked plan. Rotate that
database credential, update the private production environment if it uses it,
and coordinate removal from Git history and existing clones. Source removal alone
does not revoke a credential. Never paste the old or new URI into logs or tickets.

## AWS resources to create

Create these in the AWS account that **hosts DeplAI** (for `deplai.in`,
`ap-south-1` is the usual choice). All of them are optional except the EC2
instance, security group, disk, and DNS.

| Resource | Choice | Why |
| --- | --- | --- |
| Region | `ap-south-1` (Mumbai) unless the domain should live elsewhere | Lowest latency for `deplai.in` |
| AMI | Ubuntu Server 24.04 LTS, **64-bit (x86)** | Worker images and the Agentic Dockerfile are amd64. Do not use Graviton (`m7g`, `t4g`, ARM). |
| Instance type | **`m6i.2xlarge` or `m7i.2xlarge`** (8 vCPU, 32 GB RAM) | MySQL + Qdrant + Connector + Agentic + scan workers need RAM. Smaller types OOM during image build or ZAP/Prowler. |
| Root volume | **200 GB gp3**, encrypted | Repos, scanner DBs, Docker images, and Terraform workspaces grow quickly. 30 GB AMIs fill up. |
| Elastic IP | Allocate and associate | Keeps the public IPv4 stable if the instance stops. Point DNS at this address. |
| Security group | Inbound **80/tcp and 443/tcp** from `0.0.0.0/0`. Inbound **22/tcp** only from your admin IP, or omit SSH and use SSM. Egress all. | Caddy needs 80 (HTTP-01) and 443. Nothing else should be public. |
| IAM instance profile | `AmazonSSMManagedInstanceCore` | Session Manager without opening SSH to the world. |
| DNS | A record for `APP_DOMAIN` → Elastic IP | Must resolve **before** the first `compose up`. Caddy obtains Let's Encrypt certificates on start. |
| Key pair | Only if you use SSH instead of SSM | Store the `.pem` off the instance. |

Do **not** create for this platform host: RDS, ElastiCache, ALB/NLB, ECS/EKS,
NAT Gateway, or a public NACL change beyond the security group above. MySQL
runs in Compose on the instance.

Leave `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in `deploy/.env` empty
unless this box itself should call AWS. Customers attach their own AWS keys
in the DeplAI UI for Terraform apply.

## 1. Prepare the Linux host

Allow inbound TCP ports 80 and 443 from the internet. Restrict SSH. Point the
DNS A record for `APP_DOMAIN` at the Elastic IP before the first start.

## 2. Commands to run on the EC2 instance

SSH or SSM into the instance, then run the blocks in order as `ubuntu` (or
another sudoer). Replace the clone URL if the repo is private.

### 2.1 Install Docker Engine and Compose

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git unzip
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker ubuntu
```

Log out and back in so the `docker` group applies, then:

```bash
docker version
docker compose version
```

### 2.2 Swap and disk (recommended)

```bash
sudo fallocate -l 8G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
df -h /
```

### 2.3 Get the repository onto the instance

```bash
sudo mkdir -p /opt/deplai
sudo chown "$USER:$USER" /opt/deplai
cd /opt/deplai
git clone <YOUR_DEPLAI_GIT_URL> .
```

If the repo is private, use a deploy key or `git clone https://<token>@github.com/...`.
Alternatively copy the tree from your laptop:

```bash
# from your laptop, not from EC2
rsync -az --exclude node_modules --exclude .git --exclude .next ./ ubuntu@<EIP>:/opt/deplai/
```

### 2.4 Configure secrets

```bash
cd /opt/deplai
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
```

Generate four distinct secrets and one encryption key:

```bash
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
```

Put those values into `DEPLAI_SERVICE_KEY`, `WS_TOKEN_SECRET`, `SESSION_SECRET`,
`ADMIN_ACCESS_KEY`, and `AI_CREDENTIAL_ENCRYPTION_KEY`. Keep
`AI_CREDENTIAL_ENCRYPTION_KEY` stable after go-live; rotating it invalidates
stored BYOK secrets.

Set `ADMIN_EMAILS` to the operator Gmail (comma-separated if more than one).
Set `DOCKER_GID` from:

```bash
stat -c '%g' /var/run/docker.sock
```

Set `APP_DOMAIN`, `NEXT_PUBLIC_APP_URL=https://<APP_DOMAIN>`,
`NEXT_PUBLIC_AGENTIC_WS_URL=wss://<APP_DOMAIN>/agentic`, and
`CORS_ORIGINS=https://<APP_DOMAIN>` to the same hostname.

Point both the apex and `www.<APP_DOMAIN>` DNS records at the Elastic IP.
Caddy issues certificates for both and redirects `www` to the apex domain so
browser WebSockets stay on the canonical hostname.

Encode the GitHub App PEM as one line:

```bash
base64 -w0 github-app-private-key.pem
```

Place that string in `GITHUB_PRIVATE_KEY`. Set OAuth and App IDs, the webhook
secret, `NEXT_PUBLIC_GITHUB_APP_SLUG`, and at least one model provider key
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY`, `GEMINI_API_KEY`,
or `GROQ_API_KEY`).

GitHub OAuth callback:

```text
https://<APP_DOMAIN>/api/auth/callback
```

GitHub App webhook:

```text
https://<APP_DOMAIN>/api/webhooks/github
```

`NEXT_PUBLIC_*` values are compiled into the Connector browser bundle. Rebuild
the Connector image when the domain or GitHub App slug changes.

For public production release set `BILLING_ENFORCEMENT=true` and
`NEXT_PUBLIC_BILLING_ENFORCEMENT=true`, then rebuild Connector. Validate Razorpay
before accepting payments. Use audited admin complimentary grants and credits
for free access instead of globally disabling enforcement.

Production scans use private persistent `security-mongo` when `MONGODB_URI` is empty.
An explicitly configured external URI must be reachable; there is no silent fallback.
GLM workflows require the
platform `OPENROUTER_API_KEY`. Configuration preflight does not prove either
external service is healthy.

### 2.5 Pre-pull scanner/apply worker images

These run as **sibling containers on the host Docker engine** (Agentic uses
`/var/run/docker.sock`). Pre-pull so the first scan or apply does not wait on
Docker Hub:

```bash
cd /opt/deplai
chmod +x deploy/preflight.sh deploy/pull-worker-images.sh
./deploy/pull-worker-images.sh
```

Images: `alpine`, `alpine/git`, `bearer/bearer:latest-amd64`, `anchore/syft`,
`anchore/grype`, `zricethezav/gitleaks:v8.21.2`, `bridgecrew/checkov:3.2.334`,
`hashicorp/terraform:1.9.0`, `zaproxy/zap-stable:2.16.1`,
`prowlercloud/prowler:5.8.0`.

### 2.6 Validate and start the platform

Build one service at a time on a 32 GB box so the Agentic image (CPU PyTorch)
does not compete with the Connector Next.js build:

```bash
cd /opt/deplai
./deploy/preflight.sh
export COMPOSE_PARALLEL_LIMIT=1
docker compose --env-file deploy/.env -f docker-compose.production.yml build customization
docker compose --env-file deploy/.env -f docker-compose.production.yml build connector
docker compose --env-file deploy/.env -f docker-compose.production.yml build agentic-layer
docker compose --env-file deploy/.env -f docker-compose.production.yml up -d
docker compose --env-file deploy/.env -f docker-compose.production.yml ps
```

Only Caddy publishes host ports 80 and 443. MySQL, Qdrant, the
customization backend, Connector, and the Agentic Layer have no host port
mappings.

Verify:

```bash
docker compose --env-file deploy/.env -f docker-compose.production.yml logs -f caddy connector agentic-layer
curl -fsS https://<APP_DOMAIN>/api/health
```

The MySQL initialization script runs only when `mysql_data` is empty. Do not
delete that volume during upgrades. Application code also creates missing DAST
tables on first use. Apply other future schema changes through an explicit
migration before rolling out new application code.

## 3. What each Compose service is

| Compose service | Image | Role |
| --- | --- | --- |
| `caddy` | `caddy:2.8.4-alpine` | Public TLS on 80/443. Proxies HTTPS to Connector and `/agentic/ws*` to Agentic. |
| `mysql` | `mysql:8.4` | Connector database. Initialized from `Connector/database.sql`. |
| `connector` | Built from `Connector/Dockerfile` | Next.js UI + API. |
| `agentic-layer` | Built from `Agentic Layer/Dockerfile` | Scans, DAST, remediation, Terraform plan/apply. Packages Terraform Agent + Diagram/Cost + remediation. |
| `customization` | Built from `Customization Agent/tenant_builder_app/backend/Dockerfile` | Tenant customization API. |
| `qdrant` | `qdrant/qdrant:v1.13.6` | Vector store. |

## 4. Operate safely

Create database-consistent encrypted off-server MySQL backups (not a live copy
of its data directory), MongoDB backups, and backups of `agentic_runtime`,
`iac_workspaces`, `uiux_connector_state`, `uiux_worker_state`, `github_repos`,
`local_projects`, and `customization_state`. Include any configured remote
Terraform state and artifact stores. Retain run documentation for at least
31 days; database TTL settings and backup retention must agree. Keep credential
encryption keys recoverable separately under restricted access. Test restoring
to an isolated environment regularly. Qdrant is currently an unused placeholder.
Monitor disk
usage: cloned repositories, scanner databases, Docker images, and Terraform
workspaces can grow quickly.

Use [production readiness and owner acceptance](production-readiness.md) for
release evidence and recurring operating checks.

To update an approved release:

```bash
cd /opt/deplai
git pull --ff-only
./deploy/preflight.sh
export COMPOSE_PARALLEL_LIMIT=1
docker compose --env-file deploy/.env -f docker-compose.production.yml up -d --build --remove-orphans
```

## Scanner trust boundary

The present Agentic implementation creates Syft, Grype, Bearer, Git, Alpine,
Checkov, Gitleaks, Terraform, ZAP, and Prowler worker containers through
`/var/run/docker.sock`. Docker-socket access is effectively host-administrator
access. This stack keeps the Agentic API off the public network, but it does
**not** make arbitrary untrusted source code safe to execute on the same host.

Use this single-server design for trusted teams and repositories. Before
opening it to arbitrary public repositories, move scanner/remediation workers
to dedicated isolated VMs or a sandbox runtime such as gVisor/Kata, with no
host Docker socket exposure.
