# Organizations

**Organizations** let teams share projects, deployments, security evidence, cloud accounts, and billing context under one workspace boundary. Open **Dashboard → Organizations** (`/dashboard/organization`).

An organization is separate from your GitHub identity. You can belong to multiple organizations and switch the active one from the organization picker. Personal work on your own account still uses **Your Profile** and **Billing**; organization admins govern shared resources and policies.

## Who should use organizations

| Audience | Typical use |
| --- | --- |
| **Owners / Admins** | Create the org, invite members, assign roles, connect cloud accounts, set security gates, review audit logs. |
| **DevOps** | Run deployments, manage environments, connect AWS accounts, operate instances. |
| **Developers** | Connect repos, run agents, scan and remediate on assigned projects. |
| **Security** | Enforce scan requirements, review findings, approve production deployments, manage exceptions. |
| **Billing Admin** | View plan status, open **Billing**, download invoices. Does not need deploy access. |
| **Viewer** | Read-only access to non-sensitive resources assigned to them. |

## Organization sections

| Tab | What it covers |
| --- | --- |
| **Overview** | Member, team, project, deployment, and scan counts; recent activity. |
| **Members & invites** | Invite by email, resend or revoke invitations, change roles, suspend members. |
| **Teams** | Group members for project access and notifications. |
| **Roles & permissions** | Built-in roles (Owner, Admin, DevOps, Developer, Security, Billing Admin, Viewer) and custom roles. |
| **Projects** | Organization-scoped projects and repository connections. |
| **Security policy** | Deployment gates: require SAST/SCA/DAST, block critical findings or exposed secrets, production approval count. |
| **Cloud & AI** | Approved cloud accounts and AI provider configuration for the org. |
| **Billing & usage** | Plan summary with links to **Billing** and **Invoices**. |
| **Audit log** | Actor, action, resource, and result for governance events. |
| **Organization settings** | Name, slug, and lifecycle controls (owner-only for destructive actions). |

## Roles at a glance

Built-in roles follow least privilege. Custom roles can mix permissions for your process.

| Role | Summary |
| --- | --- |
| **Owner** | Full control, including transfer and deletion. |
| **Admin** | Broad management without owner-only destructive controls. |
| **DevOps** | Deployments, environments, cloud accounts, secrets metadata, operations. |
| **Developer** | Projects, repos, agents, scans, UI customization, non-governed deploys. |
| **Security** | Findings, policies, exceptions, deployment approvals, audit export. |
| **Billing Admin** | Subscription, usage, invoices, refunds. |
| **Viewer** | Read-only on assigned resources; no billing or audit by default. |

Only **Owner** and **Admin** should invite members or change roles unless you define a custom role with `member.invite` and `member.role.update`.

## Invitations

1. Open **Members & invites** → **Invite member**.
2. Enter email and choose a role (Admin, DevOps, Developer, Security, Billing Admin, or Viewer).
3. The recipient receives a link to `/invite/{token}`.
4. After sign-in, they accept the invitation and land in the organization.

Invitations expire. Owners and admins can resend or revoke pending invites.

## Security policy and deployment gates

Under **Security policy**, owners and security roles can enable organization-wide gates before production deploys:

- Block deployments when **critical** vulnerabilities exceed a threshold.
- Block **exposed secrets** in scan results.
- Require evidence of **SAST**, **SCA**, **container scan**, or **DAST** before apply.
- Require **N production approvals** for governed environments.

These policies complement—not replace—human confirmation in **Deploy** and review in **Security Agent**. A failed gate surfaces in the deployment flow; fix findings or request an exception per your process.

## Cloud and AI at org scope

**Cloud & AI** lists cloud accounts connected for the organization and AI provider metadata. DevOps and admins connect accounts; developers typically **use** approved accounts only. BYOK keys for model calls remain under **BYOK → Keys** at the workspace level; organization tabs show what is approved for shared work.

## Billing in an organization

Organization **Billing & usage** shows plan name and subscription status. Checkout and credit packs live on **Account → Billing** (`/dashboard/billing`). **Billing Admin** and **Owner** roles can manage subscription; others may have read-only or no billing access depending on role.

Enterprise contracts (`founders@deplai.tech`) can pool credits at organization scope—terms are on the contract, not self-serve checkout.

## Compliance notes

- **Audit log** records membership, role, policy, and integration changes. Export is available to Security and Admin roles where permitted.
- DeplAI does not become your identity provider; GitHub sign-in remains the user anchor.
- Organization deletion and ownership transfer are owner-only and may be irreversible—confirm with your admin runbook.

Related: [Security and data](security-and-data.md) · [Billing](billing.md) · [Deploy](agents/deploy.md) · [Security Agent](agents/security-agent.md)
