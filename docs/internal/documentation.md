# Documentation system

DeplAI maintains two deliberately separate documentation products:

| Audience | Source of truth | Delivery |
| --- | --- | --- |
| Engineers and operators | `docs/internal/` | Repository handbook only |
| Dashboard users | `docs/guide/` | Embedded at `/dashboard/documentation` |

Do not copy operational details, service credentials, hostnames, database tables, Docker commands, or provider-routing internals into the client guide. Do not use client copy as an authority for implementation decisions; the handbook and source code are authoritative.

## Client-guide publishing flow

The Markdown files in `docs/guide/` are the editable client-doc source. `Connector/scripts/embed-guide-docs.cjs` defines the published navigation and emits the generated `Connector/src/features/docs/guide-pages.ts` bundle. The dashboard reads that bundle through `GuideMarkdown`.

After changing a published guide page, run:

```bash
cd Connector
npm run docs:embed
npm run test:docs
```

Commit both the Markdown source and the regenerated `guide-pages.ts`. Do not hand-edit `guide-pages.ts`; the header identifies it as generated. A guide Markdown file that is not listed in the embed script is not visible in the dashboard. `_internal-review.md`, README files, and operational setup notes must remain unembedded.

## Content requirements

Client pages must describe observable product behavior, prerequisites, approval points, expected outputs, and recovery actions. Use dashboard labels and routes only when they help a user navigate. Be precise about boundaries:

- Security remediation uses the platform OpenRouter free-model route only. It is not a BYOK, paid-model, or direct-provider workflow.
- A remediation request produces proposed diffs; source persistence and GitHub writes require review.
- Deploy requires an explicit plan confirmation; DAST requires a verified target.
- State availability and resume behavior must be stated truthfully. Do not promise recovery that the service does not implement.

When behavior changes, update the closest task-specific guide page first, then update concepts, glossary, troubleshooting, and cross-links where they make a conflicting claim.

## Diagrams and Mermaid

The client guide supports `flowchart`, `sequenceDiagram`, and `stateDiagram-v2` Mermaid blocks through `Connector/src/features/docs/MermaidBlock.tsx`. Mermaid is an active dependency because published guide pages render those diagrams. The application does not provide a Quadrant-chart feature and no first-party Quadrant source exists.

The Mermaid package may install internal support files for diagram types the guide does not use, including Quadrant charts, under `Connector/node_modules/`. `node_modules` is an ignored dependency installation, not repository source; do not delete individual vendored files because package installation will restore them and partial deletion can corrupt the dependency. Remove or replace Mermaid only after replacing every published Mermaid diagram and its renderer.

## Review checklist

1. Confirm statements against routes, guards, and the relevant service implementation.
2. Check that no customer page exposes internal secrets, quota values, filesystem paths, or service-only headers.
3. Update source Markdown and regenerate the bundle.
4. Run `npm run test:docs` and `npm run build` in `Connector` when the renderer, embed configuration, or links change.
5. Run `git diff --check` and review the generated bundle alongside the Markdown change.
