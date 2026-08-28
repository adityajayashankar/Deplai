# Sessions, profile, and settings

## Workspace sessions

Tables: `workspace_sessions`, `workspace_session_logs` (`Connector/migrations/20260827_workspace_sessions.sql`, also in `database.sql`). Store: `Connector/src/lib/sessions/store.ts`.

| Field | Values |
| --- | --- |
| `service` | `security_agent` \| `uiux_customizer` \| `deploy` \| `code_reviewer` |
| `status` | `queued` \| `running` \| `completed` \| `failed` \| `needs_review` |
| log `level` | `debug` \| `info` \| `warn` \| `error` |

`code_reviewer` is reserved. Nav item is `placeholder: true` — no dashboard page.

API: `/api/sessions`, `/api/sessions/[id]`, `/api/sessions/[id]/logs`. UI: `/dashboard/sessions`, `/dashboard/sessions/[id]`.

Pipelines call `resolveOrCreateSession` + `tryAppendSessionLogs`. `external_id` ties a session to an Agentic/customization run. Agentic process restart does **not** delete these rows; live WebSocket context is still lost.

## Profile (canonical `/profile`)

`/dashboard/profile` redirects here. Tables: `user_profiles`, `user_api_tokens`.

| API | Role |
| --- | --- |
| `/api/profile` | Display name, contact, LinkedIn/GitHub URLs, referral |
| `/api/profile/routing` | `routing_mode`, `efficient_pool_json` |
| `/api/profile/api-token` | User API token (hashed + encrypted at rest) |
| `/api/profile/integrations` | Linked accounts |
| `/api/profile/delete` | Account deletion |

Auto top-up on the profile is USD thresholds (`auto_topup_threshold_usd`, `auto_topup_add_usd`). See [Billing](billing.md).

## Settings / export

`user_settings.data_json`. Routes: `/api/settings`, `/api/settings/export`. Dashboard settings also live under Home tabs and `/dashboard/settings`.

Contact copy currently includes founder inbox `adityajayashankar@deplai.tech`. Decide before repeating that in public docs.

## Auth-adjacent

| Route | Role |
| --- | --- |
| `/api/auth/login`, `/api/auth/callback`, `/api/auth/logout` | GitHub OAuth |
| `/auth/login`, `/signup`, `/forgot-password`, `/thank-you` | Auth pages (email/password UI exists; GitHub is the live identity path) |

Organizations nav: `placeholder: true` (`/dashboard/organization`).

Usage year wrap: `/dashboard/usage` (`UsageWrappedApp`, `/api/usage/wrapped`) — separate from AI Costs.

Related: [Connector](connector.md) · [Data model](data-model.md)
