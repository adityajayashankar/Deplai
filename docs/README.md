# DeplAI documentation

Two tracks. Do not mix them: the client guide is what a customer reads; the
engineering docs below it are implementation.

## Client guide

Start here if you are evaluating or onboarding to DeplAI:

**[docs/guide](guide/README.md)** — Introduction, concepts, how it works,
Getting started, each service (Security Agent, Deploy, UI/UX customizer,
Code Reviewer), Sessions, security/data/BYOK, billing/credits, glossary.

The same pages are in the dashboard under **Dashboard → Documentation**
(`/dashboard/documentation`). After editing Markdown here, run
`cd Connector && npm run docs:embed`.

`docs/guide/_internal-review.md` is team-only (margins, unfinished UI, wiring
gaps). Do not publish it.

There is also an in-app Documentation screen at `/dashboard/documentation`
that renders this client guide.

## Engineering

Start here for implementation:

**[docs/internal](internal/README.md)** — handbook: services, pipelines, data model, env, local Compose, known gaps. Not embedded in the dashboard.

Complementary narratives (prefer `docs/internal/` when they disagree):

1. [Product overview](product-overview.md) — what DeplAI is, the delivery problem it addresses, its vision, goals, features, and current boundaries.
2. [Technical architecture](technical-architecture.md) — Level-1 system architecture, frameworks, service responsibilities, persistence, and security boundaries.
3. [Agent architecture](agent-architecture.md) — the repository-to-runtime workflow and each agent or workflow graph in depth.
4. [Architecture and execution flows](architecture.md) — implementation-derived component, authentication, storage, and operating flows. This is **not** the client “How it works” page (that is [guide/how-it-works.md](guide/how-it-works.md)).
5. [API reference](api-reference.md) — Connector and Agentic Layer endpoints, WebSockets, and client behavior.
6. [AI platform](ai-platform.md) — gateway, BYOK vault, routing, metering internals.

The documents describe the code currently in this repository. They distinguish
implemented behavior from direction: a deployed container or a package in the
workspace is not automatically a feature exposed by the application.
