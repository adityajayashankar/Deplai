# DeplAI client guide

This is the customer-facing source for **Dashboard → Documentation** (`/dashboard/documentation`). It explains observable product behavior: connecting repositories, security scans and remediation, DAST authorization, UI/UX customization, AWS deployment, organizations, model access, and billing.

It is not an engineering handbook. Do not add service keys, Docker commands, database tables, internal hostnames, provider fallback implementation, or production-only operational data. Engineering documentation lives in [docs/internal/](../internal/README.md).

## Publish a guide change

The dashboard reads a generated bundle, not Markdown directly. Edit the relevant page below, then regenerate and validate it:

```bash
cd Connector
npm run docs:embed
npm run test:docs
npm run build
```

Commit both the Markdown source and the generated `Connector/src/features/docs/guide-pages.ts`. Do not hand-edit that generated TypeScript file. Only pages listed in `Connector/scripts/embed-guide-docs.cjs` are published. `README.md`, `_internal-review.md`, and `security-remediation-mongodb.md` are intentionally not embedded.

## Information architecture

### Start here
1. [Introduction](introduction.md)
2. [Core concepts](concepts.md)
3. [Repository to production](how-it-works.md)
4. [Getting started](getting-started.md)
5. [Why DeplAI](why-deplai.md)

### Services
6. [Security Agent](agents/security-agent.md)
7. [DAST](dast.md)
8. [Deploy](agents/deploy.md)
9. [Instance management](instance-management.md)
10. [UI/UX customizer](agents/uiux-customizer.md)
11. [Code Reviewer](agents/code-reviewer.md)
12. [Sessions](sessions.md)
13. [Agents and workflows](agents-and-workflows.md)
14. [Repository intelligence](repository-intelligence.md)
15. [Artifacts, state, and recovery](artifacts-and-state.md)

### Account and models
16. [Organizations](organizations.md)
17. [Plans, credits, and billing](billing.md)
18. [Profile, usage, and invoices](profile-usage-and-invoices.md)
19. [Security and data handling](security-and-data.md)
20. [BYOK models](byok-models.md)
21. [Models and providers](model-providers.md)

### Help and reference
22. [API and automation](api-and-automation.md)
23. [Troubleshooting](troubleshooting.md)
24. [Glossary and FAQ](glossary.md)
25. [Design principles](design-principles.md)
26. [Platform architecture](platform-architecture.md)
27. [Production operations](production-operations.md)
28. [Future direction](future-direction.md)

## Content rules

- Use dashboard labels exactly: **Services**, **BYOK**, **Account**, **Organizations**, **Your Profile**, and **Usage**.
- State the approval boundary for every high-impact workflow. Remediation creates proposed diffs before review; Deploy requires plan confirmation; DAST requires a verified target.
- Security remediation is platform OpenRouter free-model only. Do not tell users to add a BYOK key, choose a paid model, or use direct-provider access to run remediation.
- Keep model-provider details scoped to the relevant product feature. General BYOK and Compare behavior does not override remediation policy.
- Prefer task-specific pages for workflows and update Concepts, Glossary, Troubleshooting, and cross-links whenever a policy change makes their existing guidance inaccurate.

`_internal-review.md` is for the team and is never customer-facing.
