# DeplAI product overview

## What we are

DeplAI is a human-controlled engineering workspace that helps a team take an
application from source code to a reviewed, deployable AWS runtime. It brings
together repository onboarding, security analysis, remediation, architecture
planning, cost review, Terraform generation, deployment operations, and
project-specific customization.

The product is source-aware: planning begins with signals detected in a selected
repository or local ZIP project rather than with a generic cloud template. The
platform can use LLMs for bounded tasks, but its critical flow also has
deterministic contracts, validators, curated Terraform components, approval
gates, and observable execution status.

## What we are trying to solve

Shipping an application to the cloud is normally a chain of separate tools and
handoffs:

- A developer grants repository access or sends a source archive.
- Security tooling finds issues, then someone translates findings into changes.
- Architecture and cost decisions are made with incomplete source context.
- Infrastructure code is generated or hand-written, reviewed separately, then
  applied with credentials.
- The running system is checked in a different operational surface.

That fragmentation makes it easy to lose ownership context, skip review, or
deploy infrastructure that does not match the application. DeplAI joins those
steps around one project. It carries repository evidence into architecture and
IaC decisions; exposes progress, diffs, plan summaries, and runtime state; and
keeps material actions under an authenticated user and explicit confirmation.

## Vision

DeplAI aims to make secure cloud delivery a repeatable, understandable workflow
instead of an integration project. The intended outcome is not fully autonomous
cloud mutation. It is an explainable sequence from repository evidence to an
approved deployment decision where people remain accountable for:

- accepting source changes and pull requests;
- choosing the cloud account, region, and operational constraints;
- reviewing architecture, cost, warnings, and Terraform plan output; and
- authorizing infrastructure apply and resource destruction.

Over time, the platform can improve the quality of recommendations and the
range of supported deployment shapes without weakening those review points.

## Product goals

| Goal | How the current implementation supports it |
| --- | --- |
| Preserve context | A project connects a GitHub repository or local ZIP with scans, analysis, planning, deployments, and chat history. |
| Improve security before delivery | SAST/SCA scanning feeds a remediation workflow that produces validated proposed changes and can hand them to a GitHub pull request. |
| Make architecture choices evidence-based | Repository analysis detects languages, frameworks, data stores, build/runtime configuration, CI, health, and infrastructure hints before architecture review. |
| Make trade-offs visible | Architecture review, the Infrastructure Advisor, cost estimation, Stage 7 approval payloads, and Terraform warnings surface decisions before apply. |
| Reduce unsafe IaC generation | Deployment-profile contracts, a curated pinned module registry, deterministic renderers/rescue paths, file validation, state locking, and plan confirmation constrain execution. |
| Keep operations close to delivery | The workspace surfaces apply status, runtime details, endpoint verification, supported instance actions, app-secret management, and DeplAI-scoped destruction. |
| Enable controlled product changes | Tenant customization turns a manifest conversation into a scoped repository plan, implementation, validation, snapshot, preview, and optional PR workflow. |

## Current capabilities

### Bring in and understand a project

- GitHub OAuth sign-in and GitHub App installation/repository access.
- Repository sync, clone/pull, branch and file access, webhook processing, and
  GitHub pull-request handoff.
- Local ZIP upload, extraction, and project-scoped browsing.
- A project dashboard that keeps work scoped to the selected source.

### Secure and improve the source

- Security scan validation, SAST/SCA worker execution, result/status APIs, and
  authenticated WebSocket progress.
- Finding grouping, snippet extraction, LLM-assisted or deterministic fix
  generation, diff validation, and repository/PR handoff.
- A guarded chat interaction that can start supported project actions.

### Design, price, and approve an AWS deployment

- Repository analysis and a structured architecture review.
- Natural-language architecture generation for AWS, Azure, or GCP diagrams;
  provider-specific cost estimation is present for all three.
- An AWS-focused Infrastructure Advisor that proposes baseline, recommended,
  and resilient tiers against a monthly budget.
- Stage 7 diagram, cost, budget-gate, and approval payload generation.
- Terraform consultation, generation, plan review, and explicit apply
  confirmation.

### Run and operate the result

- Deterministic deployment-profile bundles and repository-aware EC2 application
  bundles, plus a multi-worker Terraform generation path.
- AWS runtime details, endpoint verification, EC2 lifecycle actions, generated
  key conversion, app-secret operations, and project-tagged runtime destroy.
- Repository-aware detection of database needs and optional RDS provisioning
  for supported application bundles.

### Customize a tenant experience

- Conversational manifest collection, source scanning, front-end/back-end
  planning, implementation, validation, modification reports, assets, previews,
  snapshots, reset, and GitHub PR preparation through the Connector.

## Scope and boundaries today

- The primary deployment and runtime path is **AWS**. Azure and GCP currently
  have architecture/cost-estimation support; this repository does not implement
  a corresponding Azure or GCP Terraform apply path.
- DeplAI is an engineering workspace, not a managed cloud account or a source
  of record. GitHub and the user-selected cloud account remain the systems of
  record.
- LLM availability is optional and provider-configurable. The platform has
  deterministic fallbacks for several workflow stages, but a fallback does not
  turn an unsupported deployment shape into a supported one.
- Deployment, apply, and destroy can create or remove billable cloud resources.
  They require appropriate credentials and should be operated with normal
  change-control practices.

## Typical journey

```text
Sign in -> add GitHub repository or local ZIP -> scan -> review/remediate
        -> analyze source -> review architecture / budget -> generate IaC
        -> inspect plan -> explicitly confirm apply -> operate or destroy
```

Users may enter the planning workflow directly, but the full value comes from
using the earlier source and security evidence to inform the later decisions.
