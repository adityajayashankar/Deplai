# DeplAI client guide

This guide is for people using DeplAI: connecting a repository, running Security Agent, customizing UI, deploying to AWS, and managing credits and BYOK.

The same guide is in the product at **Dashboard → Documentation** (`/dashboard/documentation`). After editing these Markdown files, regenerate the in-app copy:

```bash
cd Connector && npm run docs:embed
```

Do not put engineering internals (service graphs, Docker, database tables, API keys, host paths) in these pages. Those stay in `docs/` for the team only.

## Pages

1. [Introduction](introduction.md)
2. [Core concepts](concepts.md)
3. [How it works](how-it-works.md)
4. [Getting started](getting-started.md)
5. [Security Agent](agents/security-agent.md)
6. [Deploy](agents/deploy.md)
7. [UI/UX customizer](agents/uiux-customizer.md)
8. [Code Reviewer](agents/code-reviewer.md)
9. [Sessions](sessions.md)
10. [Security and data handling](security-and-data.md) (includes BYOK)
11. [Plans, credits, and billing](billing.md)
12. [Glossary and FAQ](glossary.md)

Names in this guide match the dashboard: **Services** (UI/UX customizer, Security Agent, Deploy, Code Reviewer, Sessions), **BYOK** (Overview through Audit), **Account** (Subscription, Invoices, Credits, Integrations), and **Settings**.

`_internal-review.md` in this folder is for the team, not for clients.
