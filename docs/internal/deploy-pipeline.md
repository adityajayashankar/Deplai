# Deploy pipeline

UI: `/dashboard/deploy` (`DeploymentTrackApp`). Connector façade: `POST /api/pipeline/deploy` (`maxDuration` 3600s). Agentic: terraform + AWS routes.

## High-level flow

```text
Repo / ZIP (+ optional customization snapshot)
  → repository analysis
  → architecture review / generate
  → cost estimate (optional Stage 7)
  → Infrastructure Advisor (`/api/infra/advise`)
  → Terraform generate + plan
  → user reads plan
  → confirm_plan_summary: true
  → terraform apply in the user's AWS account
  → runtime details / instance actions / destroy / app secrets
```

Azure and GCP appear as `provider` on the TypeScript body; **implemented apply path is AWS**.

Analysis, planning, and Terraform generation do not collect AWS credentials, including the older Pipeline IaC screen. Credentials are collected for cloud planning/apply after preparation. Restoring a saved credential/deploy stage requires its analysis, approved decision, and current project Terraform run; missing preparation returns the user to the appropriate earlier stage. Reopening a running deployment resumes monitoring.

The Connector rejects the legacy AWS `runtime_apply=false` generate-and-apply shortcut with HTTP 409 and `requires_generation: true`. AWS callers must use the reviewed Terraform bundle/run and the existing runtime apply confirmation flow.

## Plan confirmation (hard gate)

Planning uses a free-text conversation grounded in detected language, frameworks, datastores and processes. GLM answers user questions, asks a relevant follow-up and maps stated preferences into validated requirement choices. The transcript and answers survive browser refresh and in-place retry. Once requirements are ready, the user explicitly generates the service plan and reviews it before continuing. Legacy callers without a conversation retain the typed question interface. Requirements calls use a 1,024-token output limit. JSON is parsed and validated locally: do not send `response_format: {type: "json_object"}`, which the gateway rejects before inference (its native contract accepts strict `json_schema` only).

The review start/complete API now calls GLM `z-ai/glm-5.3-flash` through the Connector gateway for repository-specific question wording and a bounded service recommendation. Question IDs/options and explicit user answers remain authoritative; unsupported recommendations fail the step. The service explanation is shown with the typed component plan, from which the diagram, cost and Terraform are derived. Gateway routing for these two stages is GLM-only, uses current OpenRouter catalog metadata, and retains organization policy and wallet metering. Each call reserves at most 4,000 output tokens; provider failures do not switch models. User answers remain in the session for retry. The API uses `asyncio.to_thread` so authenticated inference context crosses into the planning worker.

EC2 is the default application runtime, including repositories with a Dockerfile. Static sites retain the S3/CloudFront option and explicitly selected ECS remains supported. The existing enterprise renderer already uses pinned Terraform Registry modules for EC2, ALB and VPC, with validated repository-specific inputs; it is not an arbitrary model-written Terraform path. The packaged application runs through `deployment_packager.py` and `ec2_app_renderer.py` bootstrap/build/start recipes, with bootstrap status and endpoint verification after apply. Console access and runtime management remain available in Outputs. This is automated EC2 execution, not browser automation of the AWS console.

Observed `awaiting_plan_confirmation` state overrides stale API-wait/accepted flags in the browser. Both status polling and live status events expose **Confirm plan & deploy**. The explicit confirm handler clears the gate before awaiting session creation. Infrastructure completion without application verification is labelled accordingly.

Verified deployment outputs link to `/dashboard/deploy/security?projectId=...`. This separate post-deployment screen offers only the existing project-scoped DAST and AWS posture flows. It does not start a scan on page load. DAST asset verification/grants and AWS credential checks remain required; SAST, SCA, SBOM and pre-deploy modules are not scheduled by this entry.

Local tests cover planning contracts, plan-gate recovery, bootstrap status and the deterministic runtime graph. They do not prove a live AWS apply/build, provider inference, DNS or endpoint result.

`terraform_apply.py` returns `status: awaiting_plan_confirmation` until Connector sends `confirm_plan_summary: true`. The UI copy is “Plan confirmation acknowledged. Calling `/api/pipeline/deploy` with `confirm_plan_summary=true`…”.

Do not add a silent apply path. Budget override (`budget_override`) is a separate user acknowledgement for estimated monthly USD vs `budget_limit_usd`.

## Connector deploy body (selected fields)

From `Connector/src/app/api/pipeline/deploy/route.ts`:

- Identity: `project_id`, `workspace_session_id`
- IaC: `service_type`, `run_id`, `workspace`, `state_bucket`, `lock_table`, generated `files`
- AWS: `aws_access_key_id`, `aws_secret_access_key`, `aws_session_token`, `aws_region`
- Gates: `confirm_plan_summary`, `enforce_free_tier_ec2`, `estimated_monthly_usd`, `budget_limit_usd`, `budget_override`
- Customization: `customization_snapshot_id`, `tenant_id`, `iac_source`
- Secrets: `required_secret_keys`, `secrets_manager_prefix`, `environment` — UI `AppSecretsPanel` + Agentic `/api/aws/app-secrets/*`

Credentials in the body are **request-scoped**. They must not be logged.

## Agentic AWS helpers

| Path | Role |
| --- | --- |
| `/api/aws/runtime-details` | Instance / output lookup after apply |
| `/api/aws/instance-action` | Start/stop/reboot-style actions |
| `/api/aws/destroy-runtime` | Tear down |
| `/api/aws/app-secrets/list\|upsert\|delete` | Secrets Manager (or equivalent) for app env |

EC2 allowlist: `DEPLAI_FREE_TIER_EC2_TYPES` (default `t3.micro,t2.micro`). `DEPLAI_ALLOW_EC2_DISABLE_FALLBACK` controls whether the planner may drop fallback types.

## Session

Deploy writes `workspace_sessions` with `service=deploy` via `resolveOrCreateSession` / `tryAppendSessionLogs`. Live Terraform logs stream on `/ws/pipeline/{project_id}` using the same browser WebSocket base as scans (`resolveBrowserAgenticWsBase` in `DeploymentTrackApp` + `agentic-websocket.ts`). Production URL shape: `wss://<APP_DOMAIN>/agentic/ws/pipeline/{project_id}?token=…`.

Related: [Terraform Agent](terraform-agent.md) · [Sessions](sessions-profile-settings.md)
