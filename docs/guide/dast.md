# Dynamic application security testing (DAST)

**DAST** tests a **running**, **authorized** HTTP target—not your repository in isolation. Configure targets under **Services → DAST** (`/dashboard/dast`), then attach a verified target to **Security Agent** scans or post-deploy checks.

DeplAI is not an open-ended penetration tool. Every target must be **verified** (DNS TXT or HTTP challenge) before active testing. Unverified or out-of-scope URLs are rejected.

## When to use DAST

| Scenario | Approach |
| --- | --- |
| Staging or production URL you own | Add target → verify → run **Passive** or **Active** profile. |
| API behind HTTPS | Use **API DAST** after verification. |
| Code-only review | Use **Security Agent** SAST/SCA first; DAST complements runtime behavior. |
| Post-deploy confidence | Deploy pipeline can run **Post-Deploy Security** after apply when a verified target exists. |

## Add and verify a target

1. Select the **project** in the workspace nav.
2. Open **DAST**.
3. Enter the public URL (for example `https://app.example.com`).
4. Choose **environment** (for example `staging` or `production`) and **scope**:
   - **Verified host** — only the exact hostname.
   - **Verified domain** — subdomains allowed per your verification record.
5. Complete verification:
   - **DNS TXT** — publish the token DeplAI shows at your DNS host.
   - **HTTP** — serve the token at the path DeplAI provides.
6. Wait until status is **Verified**. Expired or revoked targets cannot run scans.

Verification proves you control the asset. Do not point DAST at third-party sites without authorization.

## Scan profiles

| Profile | Label in UI | Behavior |
| --- | --- | --- |
| **BASELINE** | Passive DAST | Discovers issues without active attacks; lower risk to app state. |
| **FULL** | Active DAST | Deeper checks; may change application state—use on non-production first. |
| **API** | API DAST | Focused on API surface and auth patterns. |

Pick the profile before starting a run from **Security Agent** or the DAST page.

## Security Agent integration

On **Scan**, when DAST modules are enabled, the pipeline uses the **selected verified target** from DAST. If no verified target exists, dynamic testing is skipped or blocked with a clear message—not run against an arbitrary URL.

Findings appear under the **DAST** category in **Results**, alongside SAST and SCA. Remediation follows the same **Review** gate as other findings.

## Organization policy

Organization **Security policy** can require DAST evidence before production deploys. If **Require DAST** is on, ensure at least one verified target and a recent scan before apply. Details: [Organizations](organizations.md).

## Operational guidance

- Re-verify after DNS or hosting changes if status moves to **Expired**.
- Run **Passive** on production; reserve **Active** for staging unless your change window allows it.
- Combine DAST with SAST/SCA: a clean dependency tree does not guarantee safe runtime configuration.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| **Unauthorized target** | Verification incomplete, wrong hostname, or scope too narrow. |
| **No dynamic findings** | Target returned no alerts this run; confirm the app is reachable publicly. |
| **DAST skipped in scan** | No verified asset selected; open **DAST** and link a target to the project. |

Related: [Security Agent](agents/security-agent.md) · [Deploy](agents/deploy.md) · [Organizations](organizations.md)
