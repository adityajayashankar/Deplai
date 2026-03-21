# DeplAI Architecture

This document describes runtime architecture, orchestration, and agent interactions.

## 1. System Architecture

```mermaid
flowchart LR
    U[User Browser] --> C[Connector Next.js]
    C -->|REST| DB[(MySQL)]
    C -->|REST + X-API-Key| A[Agentic Layer FastAPI]
    C -->|WebSocket| A

    A -->|Docker SDK| D[(Docker Engine)]
    D --> V1[(codebase_deplai)]
    D --> V2[(security_reports)]
    D --> V3[(LLM_Output)]
    D --> V4[(grype_db_cache)]

    A -->|KG analysis import| K[KGagent LangGraph]
    K --> N[(Neo4j)]
    K --> Q[(Qdrant)]
    K --> E[External Intel APIs]

    A --> G[GitHub API]
    C --> G
```

## 2. Scan Orchestration

`EnvironmentInitializer` is the scan orchestrator in `Agentic Layer/environment.py`.

Responsibilities:
- validate Docker availability
- ensure Docker volumes exist
- clear stale codebase and stale project report files
- ingest source (GitHub clone or local project copy)
- run scanners:
  - Bearer for SAST
  - Syft + Grype for SCA
- stream progress over websocket to Connector

```mermaid
sequenceDiagram
    participant UI as Connector UI
    participant BFF as Connector API
    participant AG as Agentic Layer
    participant ENV as EnvironmentInitializer
    participant DO as Docker Engine
    participant SR as security_reports volume

    UI->>BFF: POST /api/scan/validate
    BFF->>AG: POST /api/scan/validate
    AG-->>BFF: validation ok
    UI->>AG: WS /ws/scan/{project_id} + start
    AG->>ENV: run()
    ENV->>DO: ensure volumes + cleanup stale data
    ENV->>DO: ingest source into codebase_deplai
    par SAST branch
      ENV->>DO: run bearer/bearer
      DO->>SR: write *_Bearer.json
    and SCA branch
      ENV->>DO: run anchore/syft
      DO->>SR: write *_sbom.json
      ENV->>DO: run anchore/grype
      DO->>SR: write *_Grype.json
    end
    ENV-->>AG: success/failure
    AG-->>UI: websocket status updates
    UI->>BFF: GET /api/scan/status + /api/scan/results
    BFF->>AG: fetch status/results
```

## 3. Remediation Orchestration

`RemediationRunner` is the remediation orchestrator in `Agentic Layer/remediation.py`.

Responsibilities:
- ingest parsed scan results
- run KG intelligence analysis (`run_analysis_agent`)
- call remediation LLM and apply file edits in `codebase_deplai`
- emit changed files to UI
- enforce human approval gate before persistence
- persist to local codebase or GitHub (branch + PR)
- invalidate cache and run post-fix re-scan

```mermaid
flowchart TD
    A[RemediationRunner start] --> B[Load scan results]
    B --> C[Run KG analysis agent]
    C --> D[Run LLM remediator]
    D --> E[Apply file edits in codebase volume]
    E --> F[Send changed files to UI]
    F --> G{Human approval?}
    G -- No --> G
    G -- Yes --> H{Project type}
    H -- local --> I[Copy files to local project path]
    H -- github --> J[Commit + push branch + create PR]
    I --> K[Invalidate result cache]
    J --> K
    K --> L[Run Bearer + Syft + Grype re-scan]
    L --> M[Emit completed/error]
```

## 4. Agent Orchestration and Interaction Model

There are two major agent loops in this system:

1. **Pipeline Orchestrators (workflow control)**
- `EnvironmentInitializer` (scan pipeline)
- `RemediationRunner` (remediation pipeline)

2. **Knowledge/Reasoning Agents (security intelligence + fix generation)**
- `KGagent` LangGraph planner/tool loop
- LLM remediator (`run_claude_remediation` with provider abstraction)

### 4.1 Agent Interaction Diagram

```mermaid
sequenceDiagram
    participant RR as RemediationRunner
    participant AGG as run_analysis_agent
    participant LG as KG LangGraph Agent
    participant TOOLS as KG Tools
    participant GDB as Neo4j/Qdrant
    participant LLM as Remediation LLM
    participant REPO as codebase_deplai
    participant GH as GitHub API
    participant UI as Connector UI

    RR->>AGG: run_analysis_agent(project_id, scan_data)
    AGG->>LG: agent_query(...)
    LG->>TOOLS: select and execute tool actions
    TOOLS->>GDB: graph/vector retrieval + evidence
    GDB-->>TOOLS: direct + inferred correlations
    TOOLS-->>LG: structured evidence payload
    LG-->>AGG: contract JSON (confidence, hitl, actions)
    AGG-->>RR: business/vuln summary + context

    RR->>LLM: remediation prompt(scan findings + KG context + file contexts)
    LLM-->>RR: JSON changeset
    RR->>REPO: apply file updates
    RR-->>UI: changed_files + waiting_approval
    UI-->>RR: approve_rescan

    alt github project
      RR->>GH: push branch + open PR
    else local project
      RR->>REPO: persist to local-projects source path
    end
```

### 4.2 Orchestration Guarantees

- Shared scan/remediation websocket protocol (`start`, `approve_rescan`)
- Explicit terminal statuses (`completed`, `error`, `waiting_approval`)
- Cache invalidation before UI re-fetches results
- Empty scanner report guardrails to avoid false-clean outcomes
- Human-in-the-loop checkpoint before post-fix persistence + re-scan

## 5. Data Boundaries

- **Metadata boundary**: MySQL (`users`, `github_installations`, `github_repositories`, `projects`)
- **Transient execution boundary**: Docker volumes (`codebase_deplai`, `security_reports`, `LLM_Output`, `grype_db_cache`)
- **External boundary**: GitHub APIs, optional LLM providers, optional Neo4j/Qdrant infra

## 6. Security Posture Notes

- `DEPLAI_SERVICE_KEY` secures Connector -> Agentic REST calls and websocket tokening
- GitHub remediation uses either runtime token or installation token
- Runtime LLM API keys are sent for remediation execution and should be handled as secrets
- Do not commit real credentials to repo files

