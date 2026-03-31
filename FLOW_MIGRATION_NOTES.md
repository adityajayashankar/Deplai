# DeplAI Flow Migration Notes

This file tracks migration status from the old queue/worker flow to the current React + BFF + FastAPI flow.

## 1. Current Implemented Flow

Implemented and wired in UI:

1. Stage 0 preflight
2. Stage 1 scan
3. Stage 2 KG analysis
4. Stage 3 remediation
5. Stage 4 PR
6. Stage 4.5 merge confirmation
7. Stage 4.6 post-merge action
8. Stage 6 QA capture
9. Stage 7 architecture + cost (via Stage7 agent path)
10. Stage 7.5 approval gate
11. Stage 8 IaC generation
12. Stage 9 policy gate
13. Stage 10 deploy

## 2. Key Migration Outcomes

- Old multi-service queue workflow is replaced by:
  - Connector BFF routes
  - Agentic Layer orchestration
  - direct WS streaming for scan/remediation
- Delivery-stage orchestration is HTTP-driven from Connector.
- Stage 7 is integrated through backend subprocess call to `diagram_cost-estimation_agent`.
- Remediation loop has explicit human approval and a hard cap of 2 cycles.

## 3. What Is Not Fully Unified Yet

## 3.1 Artifact continuity

Artifacts are still split across storage layers:

- UI session/local storage (QA, architecture, cost, IaC bundle, deploy state)
- Docker volumes (scan reports, working repo, outputs)
- MySQL metadata tables

There is no single versioned workflow artifact persisted end-to-end.

## 3.2 Provider symmetry

- Current delivery UI is AWS-centric.
- Non-AWS APIs exist for architecture/cost/template generation, but full stage UX/runtime deploy is AWS-focused.

## 3.3 Terraform generator simplification

- `terraform_rag_agent` has been removed from this repository.
- `terraform_runner.py` now returns unavailable, and Connector Stage 8 relies on template fallback generation.
- Top-level `terraform_agent/` directory remains non-runtime in the current pipeline path.

## 3.4 KG service model

- KG enrichment is in-process via imports inside Agentic Layer remediation path.
- Old docs implied a separate KG HTTP service startup path; that is not the active integration model here.

## 4. Recommended Next Migration Steps

1. Introduce a canonical persisted workflow run object with versioned artifacts.
2. Normalize provider behavior across architecture/cost/iac/deploy UI stages.
3. Align terraform generator naming and deprecate unused legacy path docs.
4. Reduce session/localStorage coupling for critical delivery artifacts.
5. Add explicit state-machine transitions persisted server-side for resumability and audit.
