# Glossary and FAQ

## Glossary

| Term | Meaning |
| --- | --- |
| **Agent** | A **Services** workflow: Security Agent, Deploy, UI/UX customizer, DAST, etc. Code Reviewer is **Soon**. |
| **Pipeline** | Stage rail. Security Agent: Scan → Results → Agent setup → Remediation → Review → GitHub & verify. |
| **Session** | Saved run under **Sessions** with logs and status. |
| **Finding** | Grouped SAST (CWE), SCA (CVE), or DAST issue with severity. |
| **Remediation** | Proposed diffs; GitHub waits for **Review**. |
| **Project** | Selected GitHub repo or ZIP in the workspace picker. |
| **Organization** | Team workspace with members, roles, policies, audit. |
| **BYOK** | Your provider key under **BYOK → Keys**. Modes: Platform, BYOK, Auto. |
| **Billing** | Unified page at `/dashboard/billing` (Plans + Credit packs). |
| **DAST** | Dynamic tests against **verified** HTTP targets only. |
| **Plan confirmation** | Deploy waits for your confirm before `terraform apply`. |
| **Major findings** | `critical` and `high` severities. |

## FAQ — Access and GitHub

**Does signing in with GitHub let DeplAI push to my default branch?**  
No. Login is identity only. Pushes and PRs use the GitHub App after **Review**. Optional **GitHub PAT** on **Agent setup** covers a single push.

**Can UI/UX customizer change my API?**  
No. Frontend only. Protected business-logic files fail **Functional safety**.

## FAQ — Billing and credits

**Where do I change my plan or buy credits?**  
**Account → Billing** (`/dashboard/billing`). Use **Plans** or **Credit packs** tabs. `/dashboard/subscription` and `/dashboard/payment` redirect here.

**Why is checkout in INR if plans show USD?**  
Catalog prices are USD reference values. Razorpay charges INR using USD×rate (default 83) plus 18% GST. The modal shows the final INR amount.

**Why can’t I pick flagship models on Free?**  
Platform models on Free are **Best fast** and **Best cost**. Add a BYOK key or upgrade to Starter.

**Do credits drop after every scan?**  
Credits gate **platform** models. Token detail is on **BYOK → Usage**. See [Billing](billing.md).

## FAQ — Organizations and roles

**How do I invite a teammate?**  
**Organizations → Members & invites** (Owner/Admin). They accept via `/invite/{token}` after GitHub sign-in.

**Who can approve production deploys?**  
Depends on role and org **Security policy** (`deployment.approve`, production approval count). Security and DevOps roles are typical approvers.

## FAQ — Deploy and operations

**Does Destroy undo itself?**  
No. Best-effort deletion of DeplAI-tagged AWS resources for the project.

**Where do I start/stop EC2 after deploy?**  
**Instance Management**, not the Deploy wizard.

**Are Azure and GCP deployable?**  
They may appear in cost notes. Apply is **AWS** only.

## FAQ — Security testing

**Where did my scan go after I closed the tab?**  
**Sessions** → open the row for logs. Start a **new scan** from **Security Agent** to resume live work.

**Why was DAST blocked?**  
Target not **verified**, wrong scope, or org policy. Configure [DAST](dast.md) first.

**What scan modules should I enable first?**  
**Full Scan** on first connect. Add **DAST** after verifying a staging URL. See [Security Agent](agents/security-agent.md).

**Can Security Agent auto-merge to main?**  
No. **Review** approval is required. PRs use the GitHub App after you approve.

**What model should I use for remediation?**  
**Best coding** for patches. For complex agentic fixes, use **MiniMax M3** or **Grok 4.6** with high/extrahigh effort via BYOK. See [BYOK models](byok-models.md).

**Why does remediation say no model?**  
Free plan limits platform aliases; add a BYOK key or upgrade. Pick **Platform**, **BYOK**, or **Auto** on Agent setup.

## FAQ — Usage and support

**Dashboard Usage vs BYOK Usage?**  
Dashboard **Usage** = year-style activity wrap. **BYOK → Usage** = LLM tokens and USD estimates.

**Who do I email?**  
**Settings → Contact info**: `support@deplai.tech`, `feature@deplai.tech`, `demo@deplai.tech`, `founders@deplai.tech`, `careers@deplai.tech`.

**Is Code Reviewer available?**  
Not yet—nav shows **Soon**. Use **Security Agent** and GitHub review on PRs.

## Troubleshooting quick reference

| Issue | Check |
| --- | --- |
| Payment succeeded, no credits | Wait for verification; open **Invoices**; email support with payment id. |
| Checkout shows ₹1 | Test mode banner on **Billing**; production charges full INR quote. |
| Repo missing in picker | GitHub App install and repo grant on **Integrations**. |
| Apply blocked | Org security policy, missing scan evidence, or unconfirmed plan. |
| BYOK call failed | **Keys** validation status; provider quota; **Auto** vs **BYOK** mode. |
| Security Agent scan failed | Repo access; module skipped reasons; see [Security Agent](agents/security-agent.md) troubleshooting. |
| Remediation failed | Model/BYOK readiness; try **Best coding** or MiniMax M3 / Grok 4.6. |
| Results empty after scan | Modules skipped; run **Full Scan** with GitHub access confirmed. |

Related: [Getting started](getting-started.md) · [Billing](billing.md) · [Organizations](organizations.md)
