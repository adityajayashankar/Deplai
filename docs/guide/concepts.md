# Core concepts

These terms match labels in the DeplAI dashboard.

## Agent

A named workflow under **Services**: UI/UX customizer, Security Agent, Deploy, DAST, Cloud, Instance Management, and Sessions. **Code Reviewer** is listed with a **Soon** tag. Each agent is a bounded pipeline—not an open-ended model with your cloud credentials.

Example: Security Agent runs Bearer (SAST) and Syft+Grype (SCA), then remediation only after **Results** and **Agent setup**.

## Pipeline

The ordered stage rail for one run. Security Agent’s rail is labeled **Pipeline** and has six stages.

Example: the header shows `01 / 06 · Scan` and advances as later stages unlock.

## Session

A saved record of a run: service, project, status, stage, logs, files changed. Open **Sessions** after the live view is gone.

Example: a scan creates a Security Agent session that moves from Scan to Results when it finishes.

## Stage

One named step. Locked stages cannot be skipped.

Example: **GitHub & verify** stays locked until **Review** is done.

## Finding

One grouped vulnerability. Code findings (Bearer) group by CWE. Supply-chain findings (Grype) include CVE, package, version, and optional fix. DAST findings come from authorized runtime targets. Severity: `critical`, `high`, `medium`, `low`.

## Remediation

The pass that turns selected findings into proposed diffs. It stops before GitHub. Persistence and pull requests wait for **Review** and **GitHub & verify**.

## Workspace / project / organization

- **Workspace** — the signed-in DeplAI dashboard.
- **Project** — the selected GitHub repo (via GitHub App) or ZIP upload in the nav picker.
- **Organization** — optional team boundary for members, roles, policies, and shared cloud context. See [Organizations](organizations.md).

Personal work uses your profile and billing; org work adds governance on top.

## BYOK

**Bring your own key**: store a provider API key under **BYOK → Keys** (`/dashboard/ai`). DeplAI encrypts it and shows only a masked suffix. Agents use **Platform**, **BYOK**, or **Auto** access modes.

| Item | Path | Purpose |
| --- | --- | --- |
| **Keys** | `/dashboard/ai` | Add, validate, revoke provider keys. |
| **Catalog** | `/dashboard/ai/catalog` | Models and providers in your workspace. |
| **Compare** | `/dashboard/ai/compare` | Side-by-side model comparison and ad-hoc chat. |
| **Usage** | `/dashboard/ai/usage` | Tokens, requests, estimated USD—platform vs BYOK. |

Open **Compare** for the September 2026 model landscape. For **best performance**, use **MiniMax M3** or **Grok 4.6** with **high** or **extrahigh** reasoning effort—see the [BYOK model catalog](byok-models.md) for the full list, pricing, and effort tiers.

DeplAI uses **GPT-5.6 Sol** as the platform baseline for internal routing. The catalog also includes **Gemini 3.1 Pro**, **Grok 4.5**, **MiniMax M2.7**, **Claude Opus 5**, **Sonnet 5**, and **Fable 5**. Rankings in Compare are relative to DeplAI jobs—not a generic chat leaderboard.

Example: on Free, flagship platform models stay locked until you add a key or upgrade. Full map: [Security and data](security-and-data.md).

## Credits

Integer balance on **Billing** and **Your Profile**, granted with your plan and packs. Starter and Pro unlock **bonus** credits after paid remaining hits zero; bonus expires at UTC month end.

Example: Starter grants 20 paid credits; after those are gone, up to 5 bonus credits unlock. Details: [Billing](billing.md).

Related: [How it works](how-it-works.md) · [Organizations](organizations.md) · [Security and data](security-and-data.md) · [Billing](billing.md)
