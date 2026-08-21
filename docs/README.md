# DeplAI documentation

This documentation is organized from product intent to implementation detail.
Start with the first document when you are new to the platform; use the later
documents when operating or extending it.

1. [Product overview](product-overview.md) — what DeplAI is, the delivery problem it addresses, its vision, goals, features, and current boundaries.
2. [Technical architecture](technical-architecture.md) — Level-1 system architecture, frameworks, service responsibilities, persistence, and security boundaries.
3. [Agent architecture](agent-architecture.md) — the repository-to-runtime workflow and each agent or workflow graph in depth.
4. [Architecture and execution flows](architecture.md) — implementation-derived component, authentication, storage, and operating flows.
5. [API reference](api-reference.md) — Connector and Agentic Layer endpoints, WebSockets, and client behavior.

The documents describe the code currently in this repository. They distinguish
implemented behavior from direction: a deployed container or a package in the
workspace is not automatically a feature exposed by the application.
