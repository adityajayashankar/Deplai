# Data model

Canonical schema: `Connector/database.sql` (Compose init: `/docker-entrypoint-initdb.d/001-schema.sql`). Incremental migrations for existing databases:

| File | Adds |
| --- | --- |
| `Connector/migrations/20260826_ai_platform.sql` | AI catalog, vault, usage, costs, audit |
| `Connector/migrations/20260826_credit_provisioning.sql` | Plans, ledgers, packs |
| `Connector/migrations/20260826_razorpay_gst_invoices.sql` | Checkout intents, GST invoices |
| `Connector/migrations/20260827_profile.sql` | `user_profiles`, API tokens |
| `Connector/migrations/20260827_workspace_sessions.sql` | Sessions + logs |

AI tables are also `ensureAiPlatformSchema()` at runtime. Prefer applying SQL migrations on long-lived DBs rather than relying only on ensure helpers.

Fresh Compose MySQL volumes load `database.sql` only. Rebuilding images or
recreating containers does **not** migrate an existing volume. Keep the volume
and apply the relevant incremental migrations before exercising new routes.

An older local database missing `organization_memberships` cannot perform
project authorization or resolve scan/remediation billing scope. Apply the
workspace-session, DAST, and deploy-execution table migrations listed in
`Connector/migrations/` before `20260901_organizations_v1.sql`. The organization
migration adds tenancy columns and backfills personal organizations and active
owner memberships without removing legacy ownership. Verify both owner access
and non-member rejection after migration. Follow the individual migration
prerequisites for billing schema changes; do not reset data to repair a missing
table. Container liveness alone does not verify schema compatibility.

## Identity and source

| Table | Notes |
| --- | --- |
| `users` | UUID PK, unique email |
| `github_installations` | App install; optional `user_id` |
| `github_repositories` | Per installation; clone metadata, `user_hidden` |
| `projects` | `project_type` github \| local; `repository_id` or `local_path` |
| `chat_sessions` / `chat_messages` | Agent chat; API-enforced 50 sessions / 200 messages |
| `user_settings` | JSON blob |

## Billing

`billing_plans`, `billing_subscriptions` (Stripe **and** Razorpay columns; Stripe unused), `enterprise_contracts`, `credit_packs`, `credit_ledgers`, `credit_transactions`, `billing_webhook_events`, `billing_profiles`, `billing_razorpay_plans`, `billing_checkout_intents`, `billing_invoice_sequences`, `billing_invoices`, `promo_codes`, `promo_redemptions`.

Ledger uniqueness: `(user_id, cycle_start)`.

## AI platform

`ai_providers`, `ai_models`, `ai_provider_credentials` (`secret_encrypted`, `secret_masked`), `ai_routing_policies`, `ai_organization_policies`, `ai_usage`, `ai_costs`, `ai_request_logs`, `ai_provider_health`, `ai_model_health`, `ai_audit_events`.

## Profile and sessions

`user_profiles` (referral unique, auto-topup USD ints), `user_api_tokens` (hash + encrypted material), `workspace_sessions`, `workspace_session_logs`.

## What is not in MySQL

- Live scan/remediation/pipeline context (Agentic RAM)
- Terraform `_RUNS` (`iac_pipeline.py`)
- Cloned repos / ZIP trees (Docker volumes `github_repos`, `local_projects`)
- Scanner outputs (`security_reports`, `codebase_deplai`, `grype_db_cache`, `llm_output`)
- Customization tenants (`customization_state`)

Neo4j appears only in older architecture notes. Application code uses **MySQL**.

Related: [Billing](billing.md) · [Sessions](sessions-profile-settings.md)
