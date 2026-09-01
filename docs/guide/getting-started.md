# Getting started

Shortest path from GitHub login to a scan you can read—and where to go for billing, teams, and deploy.

## 1. Sign in

1. Open DeplAI and choose **Continue with GitHub**.
2. Pick the GitHub account that can see your repository. DeplAI requests an account chooser instead of silently reusing the last session.
3. Approve **email**, **profile**, and **org membership**. That is identity only—repository access comes from the GitHub App next.

## 2. Connect a repository

1. Open **Account → Integrations** or **Your Profile → Integrations**.
2. Install the DeplAI GitHub App on the account or GitHub organization that owns the repo.
3. Grant the repositories DeplAI should see.
4. Select the repository in the workspace project picker. DeplAI clones it for scans and analysis.

**ZIP instead of GitHub:** upload an archive from the project picker. Remediation can produce local diffs; pull requests require a GitHub project.

## 3. Optional: create or join an organization

For team governance, open **Organizations** → create an org or accept an invite from email (`/invite/{token}`). Owners invite members and assign roles. Personal projects can stay on your user account. Details: [Organizations](organizations.md).

## 4. Run the first scan

1. Select the project in the left nav.
2. Open **Security Agent**.
3. On **Scan**, choose coverage:

| Option | What runs |
| --- | --- |
| **SAST** | Bearer — source vulnerabilities and hardcoded secrets. |
| **SCA** | Syft inventory + Grype CVE match on dependencies. |
| **Full Scan** | SAST + SCA plus secrets, infrastructure, API checks when relevant files exist. |

4. Start the scan and leave the tab open until **Results** unlocks.

## 5. Read the first result

- **Code security** — CWE-grouped Bearer findings with path, line, severity.
- **Supply chain** — package, installed version, CVE, optional fix version.

Prioritize `critical` and `high`—those map to **major** scope in remediation.

Export a report or continue through the full pipeline—see [Security Agent](agents/security-agent.md) for every stage, integration, and troubleshooting detail.

## 6. Optional next steps

| Goal | Page |
| --- | --- |
| Fix findings and open a PR | [Security Agent](agents/security-agent.md) |
| Verify a staging URL and run DAST | [DAST](dast.md) |
| Restyle the frontend only | [UI/UX customizer](agents/uiux-customizer.md) |
| Generate Terraform and deploy to AWS | [Deploy](agents/deploy.md) |
| Operate EC2 after apply | [Instance management](instance-management.md) |
| Plans, Razorpay checkout, credit packs | [Billing](billing.md) |
| Profile, usage wrap, invoices | [Profile, usage, and invoices](profile-usage-and-invoices.md) |
| Provider API keys | [Security and data](security-and-data.md) |

Related: [How it works](how-it-works.md) · [Core concepts](concepts.md)
