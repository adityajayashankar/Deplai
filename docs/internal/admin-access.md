# Owner-managed complimentary access

The private admin console user directory is searchable and paginated, including
accounts without subscriptions or organizations. Open a user, then choose an
organization under **Manage access**. An account without an organization must
create one in DeplAI before organization access or credits can be granted.

On the organization page select Free, Starter or Pro, enter an audit reason,
and use **Grant selected tier without payment**. Owner password step-up is
required. Optionally set an expiry; revoke the grant to restore the underlying
subscription immediately. Grants affect every member of that organization.
Enterprise remains unavailable.

Grants live in `admin_plan_grants`, separate from provider subscriptions.
Connector's organization subscription resolver checks active, unexpired grants
before paid subscriptions. This does not cancel provider billing, create a
payment, or issue an invoice. Paid subscription records are unchanged.
Credits are separate: use the existing credit grant control to fund usage.
Complimentary grants do not trigger subscription credit reconciliation.

Grant changes and their before/after audit records commit in one transaction.
Organization row locks serialize grant changes. Existing controls also include
wallet freeze/unfreeze, credit debit, organization suspend/reactivate, API-key
revocation, project controls, refunds, and audit history. Workspace-session
revocation is not a GitHub sign-out control.

Rollout: run `npm run migrate` from `admin-console` to install the additive
`20260914_complimentary_access.sql` migration, then deploy admin-console and
Connector. No user receives a grant merely by installing the migration.
The Connector tolerates an absent grant table during rollout; other database
errors remain errors. Billing views continue to show underlying paid billing;
the organization admin page separately displays complimentary access.
