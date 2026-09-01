# DeplAI client guide

This guide is for people using DeplAI: connecting repositories, running security and DAST, customizing UI, deploying to AWS, managing organizations, and billing through Razorpay.

The same guide ships in the product at **Dashboard → Documentation** (`/dashboard/documentation`). After editing these Markdown files, regenerate the in-app copy:

```bash
cd Connector && npm run docs:embed
```

Do not put engineering internals (service graphs, Docker, database tables, API keys, host paths) in these pages.

## Information architecture

### Start here
1. [Introduction](introduction.md)
2. [Core concepts](concepts.md)
3. [How it works](how-it-works.md)
4. [Getting started](getting-started.md)

### Services
5. [Security Agent](agents/security-agent.md)
6. [DAST](dast.md)
7. [Deploy](agents/deploy.md)
8. [Instance management](instance-management.md)
9. [UI/UX customizer](agents/uiux-customizer.md)
10. [Code Reviewer](agents/code-reviewer.md)
11. [Sessions](sessions.md)

### Account
12. [Organizations](organizations.md)
13. [Plans, credits, and billing](billing.md)
14. [Profile, usage, and invoices](profile-usage-and-invoices.md)
15. [Security and data handling](security-and-data.md) (includes BYOK)

### Help
16. [Glossary and FAQ](glossary.md)

Dashboard labels: **Services**, **BYOK** (Keys, Catalog, Compare, Usage), **Account** (Billing, Invoices, Integrations), **Organizations**, **Your Profile**, **Usage**.

`_internal-review.md` is for the team, not clients.
