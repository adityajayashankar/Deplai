# Glossary and FAQ

## Glossary

| Term | Meaning |
| --- | --- |
| **Agent** | A **Services** workflow: UI/UX customizer, Security Agent, Deploy (Code Reviewer is listed, not shipped). |
| **Pipeline** | The stage rail. Security Agent: Scan → Results → Agent setup → Remediation → Review → GitHub & verify. |
| **Session** | A saved run under **Sessions**. |
| **Stage** | One named step on a pipeline. |
| **Finding** | Grouped SAST (CWE) or SCA (CVE) item with severity `critical` / `high` / `medium` / `low`. |
| **Remediation** | Proposed source diffs; GitHub waits for **Review**. |
| **Project** | Selected GitHub repo or ZIP. |
| **BYOK** | Your provider key in **BYOK → Credentials**. Modes: **Platform**, **BYOK**, **Auto**. |
| **Platform credentials** | DeplAI-hosted keys, gated by plan. Also a **Policies** toggle. |
| **Paid / bonus credits** | See [Billing](billing.md). |
| **GitHub App** | Grants repo access. GitHub login is identity only. |
| **GitHub PAT (Optional)** | Field on **Agent setup** for that push only. Not stored in Credentials. |
| **Plan confirmation** | Deploy does not apply until you confirm the plan. |
| **Full Scan** | SAST + SCA together. |
| **Major findings** | `critical` and `high`. |

## FAQ

**Does signing in with GitHub let DeplAI push to my default branch?**  
No. Login is identity only. Pushes and PRs use the GitHub App after you approve **Review**. You can instead paste a **GitHub PAT (Optional)** on **Agent setup** for that run.

**Can UI/UX customizer change my API?**  
No. Frontend only. Protected business-logic files fail **Functional safety**.

**Why can’t I pick Claude Opus on Free without a key?**  
Platform models on Free are **Best fast** and **Best cost**. Add a BYOK key or upgrade to Starter.

**Does Destroy undo itself?**  
No. It is best-effort deletion of DeplAI-tagged resources in the AWS account you used.

**Where did my scan go after I closed the tab?**  
**Sessions** → Security Agent → open the row. That page does not resume the live scan; start a new run from **Security Agent**.

**Is Code Reviewer available?**  
Not in this build. The nav item is a placeholder.

**Dashboard → Usage vs BYOK → Usage?**  
Dashboard Usage is a year-style wrap. BYOK Usage is LLM token metering.

**Do credits drop after every scan?**  
The picker shows remaining credits and the plan gates platform models. Token/USD detail is on **BYOK → Usage** / **Costs**. See [Billing](billing.md).

**Who do I email?**  
Settings → **Contact info**: `support@deplai.tech`, `feature@deplai.tech`, `demo@deplai.tech`, `founders@deplai.tech`, `careers@deplai.tech`.

**Are Azure and GCP deployable from Deploy?**  
They can appear in planning/cost notes. Apply is AWS.

Related: [Introduction](introduction.md) · [Getting started](getting-started.md)
