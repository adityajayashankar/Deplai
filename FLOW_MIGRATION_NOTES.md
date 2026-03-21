# DeplAI Old -> React Flow Migration Notes

## What `DeplAI_old` is doing
- It is a queue-driven architecture assistant stack.
- UI: Streamlit multi-stage wizard.
- Backend services:
  - Architecture JSON generation (`architectureJsonRequestQueue`)
  - Cost estimation (`costEstimationRequestQueue`)
  - Diagram generation (`diagramRequestQueue`)
  - Terraform generation worker (`terraformGenerationRequestQueue`)
  - GitHub deployment worker (`deploymentRequestQueue`)
- Terraform generation is an agent/toolchain workflow; deployment configures GitHub repo + CI workflow.

## Legacy 8 stages (old Streamlit)
1. Project Definition
2. Confirm Details
3. Requirements Gathering
4. Analysis
5. Architecture Generation
6. Final Report
7. Terraform Generation
8. Deployment

## Target flow requested
1. Q/A
2. Architecture Context
3. Cost Estimation (pre-scan)
4. Code Scan
5. KG Agent
6. Remediate (business logic + syntax + functional)
7. Re-run code validation
8. Cost Estimation (post-remediation)
9. Generate Terraform/Ansible
10. GitHub CI
11. Deploy

## Fundamental design risks to address
1. Missing canonical artifact model:
   - Q/A, architecture JSON, scan findings, remediation patchset, IaC plan, and deploy plan are not currently a single versioned workflow artifact.
2. Mixed orchestration styles:
   - Current stack is WebSocket-driven for scan/remediation; old stack is RabbitMQ request/reply.
   - Without a unified workflow ID/state machine, retries and step resumption can drift.
3. Cost-estimation ambiguity:
   - "Pre" and "post" cost should be tied to explicit architecture versions, not scan counts.
4. Quality gates are not formally enforced in one place:
   - Remediation has quality checks, but IaC generation/deploy gates need equivalent policy checks.
5. Security boundary drift:
   - User runtime secrets (LLM keys, cloud creds, GitHub tokens) currently appear in multiple paths and need strict central handling policy.

## Architecture direction
- Keep React as the single UI.
- Keep Agentic Layer as workflow orchestrator for security pipeline.
- Introduce a unified workflow record + state machine for all steps (architecture -> scan -> remediate -> IaC -> deploy).
- Adapt old worker capabilities behind typed API contracts before enabling production deploy flow.

