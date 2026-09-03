# DeplAI design principles

These principles describe how the implemented platform is intended to divide reasoning, control, and execution. They are useful when evaluating a workflow or designing a new one.

## Agents propose, systems enforce

Models can interpret evidence and generate candidates. Deterministic services enforce identity, permissions, schemas, paths, state transitions, policy, and confirmation. A model response is never itself cloud or repository authority.

## Evidence before recommendation

Repository analysis, scanner output, user decisions, and external status should precede an engineering recommendation. When evidence conflicts, preserve the conflict and ask for confirmation instead of hiding uncertainty.

## Least privilege

Scope projects, repository installations, organization roles, model credentials, cloud credentials, and service access to the minimum necessary action. Secret metadata and secret values are different permissions.

## Bounded autonomy

Automation should operate inside declared tools, files, resources, budgets, and policies. Increasing model capability should not silently increase execution authority.

## Human control at high-impact boundaries

Source persistence, pull requests, Terraform apply, production operations, and destructive actions need visible intent and appropriate permission. Approval should identify the artifact being approved.

## Structured and reproducible execution

Prefer typed context, explicit decisions, generated artifacts, pinned tooling, plans, and deterministic validators over ad-hoc production commands. Record provenance when a fallback or rescue renderer is used.

## Recoverable long-running work

Workflows should emit identifiers and progress, preserve safe durable state, support bounded retry or resume where possible, and make partial external effects discoverable. Recovery behavior must be documented per subsystem.

## Observable by default

Important actions should emit sanitized events, logs, status, and artifacts. Observability must help explain who requested what, against which project and environment, without leaking credentials or source secrets.

## Repository-aware

Agents should use the smallest relevant slice of verified repository context. This improves accuracy and cost while avoiding universal source access.

## Security throughout the lifecycle

Security is not one final scan. Ownership, target authorization, secret handling, finding normalization, remediation validation, infrastructure policy, and deployment health all contribute different evidence.

## Provider independence with honest differences

Shared adapters and canonical errors reduce coupling to one model provider. Providers and models still differ in capability, context, latency, cost, availability, and policy fit; the platform must preserve those differences rather than pretend they are identical.

## Truthful readiness

A successful intermediate stage must not be promoted into a broader success claim. Terraform applied, host bootstrapped, application started, and HTTP healthy are separate facts. The user should see the narrowest accurate status.

## Secure defaults, explicit exceptions

Private execution services, verified DAST targets, masked credentials, project-scoped paths, and approval gates are defaults. Any relaxation must be explicit, environment-scoped, and visible to operators.

Related: [How DeplAI fits together](platform-architecture.md) | [Production operations](production-operations.md) | [Future direction](future-direction.md)
