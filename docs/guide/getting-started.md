# Getting started

Shortest path from GitHub login to a scan you can read.

## 1. Sign in

1. Open DeplAI and choose **Continue with GitHub**.
2. Pick the GitHub account that can see the repository. DeplAI asks GitHub to show an account chooser instead of reusing the last session silently.
3. Approve email, profile, and org membership. That is identity only. Repository access comes from the GitHub App next.

## 2. Connect a repository

1. Open **Integrations** (or add a project from the workspace picker).
2. Install the DeplAI GitHub App on the account or organization that owns the repo.
3. Grant the repositories you want DeplAI to see.
4. Select the repository. DeplAI clones it on its servers for scans and analysis.

**ZIP instead of GitHub:** upload an archive from the project picker. Remediation can still write local diffs; pull requests need a GitHub project.

## 3. Run the first scan

1. Select the project in the left nav.
2. Open **Security Agent**.
3. On **Scan**, choose coverage:

| Option | What runs |
| --- | --- |
| **SAST** | Bearer — source for vulnerabilities and hardcoded secrets. |
| **SCA** | Syft inventory + Grype CVE match on dependencies. |
| **Full Scan** | Both, in parallel. Use this if you are unsure. |

4. Start the scan and leave the tab open.
5. When it completes, the pipeline moves to **Results**.

## 4. Read the first result

- **Code security** — CWE-grouped Bearer findings, path, line, severity.
- **Supply chain** — package, installed version, CVE, optional fix version.

Start with `critical` and `high`. Those are **major** when you later scope remediation.

You do not have to remediate in DeplAI. Export a report, or continue to **Agent setup** → **Remediation**.

## 5. Optional next steps

- **Agent setup → Remediation → Review → GitHub & verify** — [Security Agent](agents/security-agent.md)
- **UI/UX customizer** — [UI/UX customizer](agents/uiux-customizer.md)
- **Deploy** — [Deploy](agents/deploy.md)
- **Credits / Subscription** — [Billing](billing.md)
- **BYOK → Credentials** — [Security and data](security-and-data.md)
