# Core concepts

These terms match labels in the dashboard.

## Agent

A named item under **Services**: UI/UX customizer, Security Agent, Deploy, Code Reviewer, and Sessions. Each one is a bounded workflow with optional model steps — not an unconstrained model with your cloud credentials.

Example: Security Agent runs Bearer (SAST) and Syft+Grype (SCA), then a remediator only after **Results** and **Agent setup**.

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

One grouped vulnerability. Code findings (Bearer) are grouped by CWE. Supply-chain findings (Grype) have a CVE, package, installed version, and optional fix version. Severity: `critical`, `high`, `medium`, `low`.

Example: `lodash@4.17.20` / `CVE-2021-23337` at `high`, and a code row `CWE-79`.

## Remediation

The pass that turns selected findings into proposed diffs. It stops before GitHub. Persistence and a pull request wait for **Review** and **GitHub & verify**.

Example: after a round you can run another pass or take the current fixes. Nothing is pushed until you approve.

## Workspace / project

The dashboard is the workspace. Work applies to the **project** in the nav: a GitHub repo from your GitHub App, or a ZIP you uploaded. **Organizations** in the nav is a placeholder.

Example: the project picker lists GitHub repos you granted and ZIP projects you own.

## BYOK

You store a provider API key under **BYOK → Credentials**. DeplAI encrypts it and shows only a masked suffix. Agents and Playground pick **Platform**, **BYOK**, or **Auto**.

Example: on Free, flagship platform models stay locked until you add a key or upgrade. Full map: [Security and data](security-and-data.md).

## Credits

An integer on **Account → Credits**, granted with your plan (and packs/promos). On Starter and Pro, bonus credits unlock after paid remaining hits zero, then expire at UTC month end.

Example: Starter grants 20 paid credits; after those are gone, up to 5 bonus credits unlock. Details: [Billing](billing.md).

Related: [How it works](how-it-works.md) · [Security and data](security-and-data.md) · [Billing](billing.md)
