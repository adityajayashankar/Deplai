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

## Plan confirmation (hard gate)

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

Deploy writes `workspace_sessions` with `service=deploy` via `resolveOrCreateSession` / `tryAppendSessionLogs`. Live Terraform logs also stream on `/ws/pipeline/{project_id}`.

Related: [Terraform Agent](terraform-agent.md) · [Sessions](sessions-profile-settings.md)
