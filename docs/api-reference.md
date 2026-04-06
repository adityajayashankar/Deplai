# DeplAI API Reference

## Table of Contents
- Authentication and Transport
- Agentic Layer API
- Connector API (User-facing facade)
- WebSocket Message Contracts

## Authentication and Transport
### Connector API authentication
Connector protected routes require a valid iron-session cookie:
- Unauthorized response: HTTP 401 with JSON error payload.

### Agentic Layer authentication
Most Agentic HTTP routes are protected by X-API-Key:
- Header: X-API-Key: <DEPLAI_SERVICE_KEY>
- Unauthorized response: HTTP 401 detail Invalid or missing API key

### WebSocket authentication
Agentic websocket routes require token query parameter:
- token format: base64url(payload).hex_hmac_signature
- payload claims: sub (user id), project_id, exp (unix seconds)
- ttl: 300 seconds

## Agentic Layer API
Base URL: AGENTIC_LAYER_URL (default http://localhost:8000)

### Health
#### GET /health
Purpose:
- Service health with dependency checks.

Response:
- status: healthy | degraded | down
- checks: array of objects with name, state, detail

Primary checks implemented:
- docker_engine
- neo4j

### Scan APIs
#### POST /api/scan/validate
Auth:
- X-API-Key required

Request body:
```json
{
  "project_id": "proj_123",
  "project_name": "my-app",
  "project_type": "local",
  "user_id": "user_1",
  "scan_type": "all",
  "github_token": "optional-for-github",
  "repository_url": "optional-for-github"
}
```

Validation:
- project_id must match regex [a-zA-Z0-9_-]{1,80}
- scan_type allowed: sast, sca, all

Response:
- success: true
- message: Scan validation request received successfully
- data: echoed request model

Errors:
- 401 invalid or missing API key

#### GET /api/scan/status/{project_id}
Auth:
- X-API-Key required

Response:
- running if project currently active in-memory
- otherwise found | not_found | not_initiated based on parsed volume files

#### GET /api/scan/results/{project_id}
Auth:
- X-API-Key required

Response:
```json
{
  "success": true,
  "data": {
    "supply_chain": [
      {
        "name": "package",
        "type": "npm",
        "version": "1.2.3",
        "purl": "pkg:npm/...",
        "severity": "High",
        "epss_score": 0.1,
        "fix_version": "1.2.4",
        "cve_id": "CVE-..."
      }
    ],
    "code_security": [
      {
        "cwe_id": "CWE-79",
        "title": "...",
        "severity": "high",
        "count": 2,
        "occurrences": [
          {
            "filename": "src/file.ts",
            "line_number": 42,
            "code_extract": "...",
            "documentation_url": "..."
          }
        ]
      }
    ]
  }
}
```

Errors:
- 404 if reports not found

#### DELETE /api/scan/results/{project_id}
Auth:
- X-API-Key required

Behavior:
- Deletes project-specific scan report files from security_reports volume.

Response:
- success true and confirmation message

### Cleanup API
#### POST /api/cleanup
Auth:
- X-API-Key required

Behavior:
- Global destructive volume cleanup.
- Allowed only when ALLOW_GLOBAL_CLEANUP=true.

Responses:
- 403 when disabled
- 200 success true when cleanup completed

### Remediation API
#### POST /api/remediate/validate
Auth:
- X-API-Key required

Request model highlights:
- project_type: local | github
- remediation_scope: major | all
- llm_provider/api_key/model accepted but normalized to Claude-compatible values in backend

Response:
- success true
- message Remediation request accepted

### Repository Analysis and Architecture Review APIs
#### POST /api/repository-analysis/run
Auth:
- X-API-Key required

Request:
```json
{
  "project_id": "...",
  "project_name": "...",
  "project_type": "local",
  "user_id": "...",
  "repo_full_name": "owner/repo",
  "workspace": "deploy-project"
}
```

Response:
- success
- workspace
- context_json (RepositoryContextDocument)
- context_md
- runtime_paths

#### POST /api/architecture/review/start
Auth:
- X-API-Key required

Request:
- project identifiers + workspace + optional environment

Response:
- success
- review with:
  - context_json
  - questions[]
  - defaults
  - conflicts
  - low_confidence_items

#### POST /api/architecture/review/complete
Auth:
- X-API-Key required

Request:
- project identifiers + workspace + answers map

Response:
- answers_json
- deployment_profile
- architecture_view
- approval_payload
- runtime_paths

#### POST /api/architecture/generate
Auth:
- X-API-Key required

Request:
```json
{
  "prompt": "Natural language architecture prompt",
  "provider": "aws",
  "llm_provider": "optional",
  "llm_api_key": "optional",
  "llm_model": "optional"
}
```

Response:
- success
- architecture_json validated against ArchitectureDocument contract

Failure:
- success false + contract validation error details when generated JSON fails parsing/contract checks

### Cost API
#### POST /api/cost/estimate
Auth:
- X-API-Key required

Request:
- architecture_json (ArchitectureDocument)
- provider (aws|azure|gcp)
- optional aws_access_key_id/aws_secret_access_key

Response:
- success
- provider
- total_monthly_usd
- currency
- breakdown[]
- note
- errors[]

### Stage 7 API
#### POST /api/stage7/approval
Auth:
- X-API-Key required

Request:
```json
{
  "infra_plan": {},
  "budget_cap_usd": 100,
  "pipeline_run_id": "",
  "environment": "dev"
}
```

Response:
- success
- approval_payload object

### Terraform APIs
#### POST /api/terraform/generate
Auth:
- X-API-Key required

Request:
- architecture_json (dict)
- provider, project_name, workspace
- aws_region and optional aws credentials
- optional qa_summary and website_index_html

Response success:
- run_id/workspace/provider_version/state_bucket/lock_table
- manifest/dag_order/warnings
- files[]
- readme
- source

Response failure:
- success false + error + optional details/source

#### POST /api/terraform/apply
Auth:
- X-API-Key required

Request:
- project_id or project_name
- provider
- optional run_id/workspace/state_bucket/lock_table
- files[] when not reusing run reference
- aws_access_key_id/aws_secret_access_key/aws_region
- enforce_free_tier_ec2

Response success:
- outputs
- cloudfront_url
- details

Response failure:
- success false
- error
- details

#### POST /api/terraform/apply/status
Auth:
- X-API-Key required

Request:
- project_id or project_name

Response:
- status: idle | running | completed | error
- optional result payload

#### POST /api/terraform/apply/stop
Auth:
- X-API-Key required

Request:
- project_id or project_name

Behavior:
- Sets cancel_requested and attempts to kill active terraform container.

Response:
- success + message, or success false + error

### AWS Runtime APIs
#### POST /api/aws/runtime-details
Auth:
- X-API-Key required

Request:
- project_name
- aws_access_key_id
- aws_secret_access_key
- aws_region
- optional instance_id

Response:
- success
- details with:
  - instance object (id, IPs, dns, state, type, vpc/subnet, arn, launch_time)
  - resource_counts (ec2, vpcs, subnets, nat, route tables, SGs, key pairs, s3, cloudfront)

#### POST /api/aws/instance-action
Auth:
- X-API-Key required

Request:
- project_name
- aws credentials
- aws_region
- instance_id
- action: start | stop | reboot

Response:
- refreshed instance details after action

#### POST /api/aws/destroy-runtime
Auth:
- X-API-Key required

Request:
- project_name
- aws credentials
- aws_region

Behavior:
- Best-effort cleanup for Project-tagged resources:
  - EC2 terminate
  - key pair delete
  - EBS delete
  - S3 bucket object purge + delete
  - CloudFront disable/delete
  - security group delete

Response:
- success with details including deleted ids and per-step errors array

## Connector API (User-facing facade)
Base URL: Connector Next.js app (default http://localhost:3000)

All routes below require authenticated session unless noted.

### Auth routes
- GET /api/auth/login
- GET /api/auth/callback
- POST /api/auth/logout
- GET /api/auth/session

Behavior summary:
- OAuth state with timing-safe compare, state expiry check, user provisioning in users table.
- Logout can trigger backend cleanup when CLEANUP_SCAN_VOLUMES_ON_LOGOUT=true.

### Scan and remediation facade routes
- POST /api/scan/validate -> Agentic POST /api/scan/validate
- GET /api/scan/status?project_id=... -> Agentic GET /api/scan/status/{project_id}
- GET /api/scan/results?project_id=... -> Agentic GET /api/scan/results/{project_id}
- GET /api/scan/ws-token?project_id=... -> signs ws token for Agentic sockets
- POST /api/remediate/start -> Agentic POST /api/remediate/validate
- POST /api/pipeline/remediation-pr -> lists open remediation PR by project-specific branch prefix

### Planning and architecture facade routes
- POST /api/repository-analysis/run -> Agentic /api/repository-analysis/run
- POST /api/architecture/review/start -> Agentic /api/architecture/review/start
- POST /api/architecture/review/complete -> Agentic /api/architecture/review/complete
- POST /api/architecture
  - AWS without explicit LLM override: deterministic architecture template in Connector
  - otherwise proxies to Agentic /api/architecture/generate
- POST /api/cost -> Agentic /api/cost/estimate
- POST /api/pipeline/stage7 -> Agentic /api/stage7/approval

### IaC and deploy routes
- POST /api/pipeline/iac
  - AWS path builds local six-file Terraform bundle and website asset packaging
  - Azure/GCP path builds local IaC bundle templates
- POST /api/pipeline/deploy
  - runtime_apply=true -> Agentic /api/terraform/apply
  - otherwise GitOps repo creation + file push + workflow variable setup
- POST /api/pipeline/deploy/status -> Agentic /api/terraform/apply/status
- POST /api/pipeline/deploy/stop -> Agentic /api/terraform/apply/stop
- POST /api/pipeline/deploy/destroy -> Agentic /api/aws/destroy-runtime
- POST /api/pipeline/runtime-details -> Agentic /api/aws/runtime-details (with graceful fallback payload)
- POST /api/pipeline/runtime-instance -> Agentic /api/aws/instance-action
- POST /api/pipeline/deploy/verify -> probes CloudFront and EC2 endpoints over HTTP
- POST /api/pipeline/keypair/ppk -> converts PEM to PPK via puttygen if available

### Integration and project management routes
- GET/DELETE /api/installations
- POST /api/sync
- POST /api/webhooks/github (no session cookie required; HMAC signature verification)
- GET /api/projects and related /api/projects/* routes
- GET /api/repositories and related /api/repositories/* routes
- GET/PATCH /api/settings
- POST /api/settings/cleanup -> Agentic /api/cleanup
- /api/customization/[...path] -> proxies to customization backend

## WebSocket Message Contracts
### Client command payload
```json
{ "action": "start" }
```
Supported actions by flow:
- Scan/remediation: start
- Remediation additional actions: continue_round, push_current, approve_push

### Server message payload
```json
{
  "type": "message",
  "data": {
    "index": 1,
    "total": 12,
    "type": "info",
    "content": "...",
    "timestamp": "2026-04-06T00:00:00Z"
  }
}
```

Status payload:
```json
{ "type": "status", "status": "running" }
```

Status enum values:
- running
- waiting_decision
- waiting_approval
- completed
- error
