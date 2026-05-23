# DeplAI — IaC Generation & Execution Pipeline: Implementation Plan
> For Claude Sonnet 4.5 coding agent. Every section maps directly to files in the repo.

---

## Context from codebase audit

| Layer | Key facts |
|---|---|
| **Connector** | Next.js 16.1.1 / TS5 — has `/api/pipeline/deploy/route.ts` that generates a raw six-file HCL bundle locally via LLM. This is the unstable path to replace. |
| **Agentic Layer** | FastAPI / Python 3.13 — already has `/api/terraform/apply`. Mounted with `Terraform Agent` at `/app/terraform_agent` via docker-compose volume. |
| **Terraform Agent** | Already exists as a LangGraph stub at `Terraform Agent/agent/`. Not wired into the main deploy flow. This is the foundation to build on. |
| **docker-compose.yml** | `Agentic Layer` container does NOT install the Terraform CLI binary — this must be added to the Dockerfile. |
| **IaC gap** | Current Connector deploy route writes raw HCL using LLM → unstable. Plan replaces this with Template Library + LLM-fills-JSON-params → stable. |

---

## What stays unchanged

- All of Steps 1–3 (repo analysis, customization agent, diagram + cost stage 7)
- GitHub OAuth, MySQL session, WebSocket scan/remediate flows
- `/api/terraform/apply` endpoint signature (do not rename, only enhance internally)
- `Diagram-Cost-Agent`, `KGagent`, `remediation_pipeline` — untouched

---

## Phase 1 — Template Library (no LLM, pure Terraform)

**Goal**: A library of battle-tested, provider-pinned Terraform modules for every AWS service we support. The LLM never writes HCL. It only fills a JSON params object.

### 1.1 Create `Terraform Agent/agent/templates/` directory

Create one subdirectory per service. Each must have three files:

```
Terraform Agent/agent/templates/
  ec2/
    main.tf          # uses terraform-aws-modules/ec2-instance/aws ~> 5.0
    variables.tf     # declares all inputs with types and defaults
    outputs.tf       # public_ip, instance_id, keypair_name, availability_zone, arn
  s3/
    main.tf          # uses terraform-aws-modules/s3-bucket/aws ~> 4.0
    variables.tf
    outputs.tf       # bucket_id, bucket_arn, bucket_domain_name, region
  rds/
    main.tf          # uses terraform-aws-modules/rds/aws ~> 6.0
    variables.tf
    outputs.tf       # endpoint, port, db_instance_id, db_instance_arn
  vpc/
    main.tf          # uses terraform-aws-modules/vpc/aws ~> 5.0
    variables.tf
    outputs.tf       # vpc_id, private_subnets, public_subnets, nat_gateway_ids
  ecs/
    main.tf          # ECS cluster + Fargate task, uses aws_ecs_* resources directly
    variables.tf
    outputs.tf       # cluster_arn, service_name, task_definition_arn
  lambda/
    main.tf          # uses terraform-aws-modules/lambda/aws ~> 7.0
    variables.tf
    outputs.tf       # lambda_function_arn, lambda_function_name, lambda_function_url
  elasticache/
    main.tf
    variables.tf
    outputs.tf       # primary_endpoint_address, port, cluster_id
  alb/
    main.tf          # Application Load Balancer with target group
    variables.tf
    outputs.tf       # lb_dns_name, lb_arn, target_group_arn
```

**Coding rules for all templates:**
- Pin provider: `required_providers { aws = { source = "hashicorp/aws", version = "~> 5.0" } }`
- All sensitive variables (passwords, keys) use `sensitive = true`
- All resources tagged with: `Name`, `Environment`, `ManagedBy = "deplai"`, `ProjectId`
- `outputs.tf` must export everything the UI needs — IPs, ARNs, endpoints, names

### 1.2 Create `Terraform Agent/agent/template_registry.py`

```python
# Maps service_type string → template directory path
# Must be kept in sync with the templates/ directory

SERVICE_TEMPLATE_MAP: dict[str, str] = {
    "ec2": "templates/ec2",
    "s3": "templates/s3",
    "rds": "templates/rds",
    "vpc": "templates/vpc",
    "ecs": "templates/ecs",
    "lambda": "templates/lambda",
    "elasticache": "templates/elasticache",
    "alb": "templates/alb",
}

# Schema for what params the LLM must fill per service
# Used for prompt construction and validation of LLM output
PARAM_SCHEMA: dict[str, list[dict]] = {
    "ec2": [
        {"name": "instance_name", "type": "string", "required": True},
        {"name": "instance_type", "type": "string", "default": "t3.micro"},
        {"name": "aws_region",    "type": "string", "default": "us-east-1"},
        {"name": "ami_id",        "type": "string", "default": ""},  # empty = fetch latest Ubuntu
        {"name": "key_pair_name", "type": "string", "default": "deplai-keypair"},
        {"name": "root_volume_size_gb", "type": "number", "default": 20},
    ],
    "s3": [
        {"name": "bucket_name",   "type": "string", "required": True},
        {"name": "aws_region",    "type": "string", "default": "us-east-1"},
        {"name": "versioning",    "type": "bool",   "default": False},
        {"name": "force_destroy", "type": "bool",   "default": True},
    ],
    # ... (full schema for all 8 services)
}
```

---

## Phase 2 — LLM Param Selector

**Goal**: Replace the current six-file HCL generator with a lightweight LLM call that only outputs a JSON params dict. No HCL, no hallucination risk.

### 2.1 Create `Terraform Agent/agent/param_selector.py`

```python
# Single function: given service_type + context → returns validated params dict

async def select_params(
    service_type: str,
    repo_context: dict,          # from earlier pipeline stages
    user_customizations: dict,   # from Step 2 customization agent
    aws_region: str,
    project_id: str,
) -> dict:
    """
    Calls Claude (claude-sonnet-4-5) with a strict JSON-only system prompt.
    Prompt includes:
      - The PARAM_SCHEMA for this service (so Claude knows exactly what fields to fill)
      - repo_context (language, framework, expected load)
      - user_customizations (instance size preferences, etc.)
    
    Parse response as JSON, validate all required fields are present,
    apply defaults for any missing optional fields from PARAM_SCHEMA.
    
    Returns: validated params dict ready to write as terraform.tfvars.json
    """
```

**System prompt template** (embed in this file):
```
You are a Terraform parameter selector. Your ONLY output must be a valid JSON object.
No markdown, no explanation, no code fences.

Fill the following parameters for a {service_type} deployment:
{param_schema_json}

Context about the application being deployed:
{repo_context_summary}

User customization preferences:
{user_customizations_json}

Rules:
- Use the exact field names from the schema
- For instance types, prefer free-tier eligible options unless user specified otherwise
- bucket_name must be globally unique — append a 6-char random hex suffix
- Never invent fields not in the schema
```

---

## Phase 3 — Validation Loop

**Goal**: Run `terraform validate` (and optionally `tflint`) on the generated workspace. On failure, feed the full stderr back to Claude for a targeted param correction. Max 3 retries.

### 3.1 Create `Terraform Agent/agent/validator.py`

```python
import subprocess
import tempfile
import json
import shutil
from pathlib import Path

class ValidationResult:
    success: bool
    errors: list[str]   # raw stderr lines
    stdout: str

def prepare_workspace(
    service_type: str,
    params: dict,
    project_id: str,
    aws_credentials: dict,
) -> Path:
    """
    1. Copy template directory to a fresh temp workspace:
       /tmp/deplai-workspaces/{project_id}_{service_type}/
    2. Write params as terraform.tfvars.json
    3. Write provider credentials as environment-variable references in provider.tf
       (never write credentials as literals in .tf files — use env vars)
    Returns workspace Path.
    """

async def validate(workspace: Path) -> ValidationResult:
    """
    Runs: terraform init -backend=false && terraform validate
    Sets AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY as subprocess env vars.
    Captures stdout + stderr.
    Returns ValidationResult.
    """

async def validate_with_retry(
    service_type: str,
    params: dict,
    project_id: str,
    aws_credentials: dict,
    max_retries: int = 3,
) -> tuple[Path, dict]:
    """
    Main entry point for validation phase.
    
    Loop:
      1. prepare_workspace(params)
      2. validate(workspace) 
      3. If success → return (workspace, params)
      4. If failure → call param_selector.correct_params(service_type, params, errors)
         (new Claude call with errors in prompt: "These validation errors occurred: {stderr}
          Here are the current params: {params}. Return corrected params JSON only.")
      5. Increment retry count. If retry == max_retries → raise IaCValidationError
    """
```

### 3.2 Add `correct_params()` to `param_selector.py`

```python
async def correct_params(
    service_type: str,
    current_params: dict,
    validation_errors: list[str],
) -> dict:
    """
    Called by the retry loop. Sends errors + current params to Claude.
    Prompt: "Fix only the fields causing these Terraform validation errors.
    Return the complete corrected params JSON."
    """
```

---

## Phase 4 — Execution Engine

**Goal**: Run `terraform plan` then `terraform apply` in the validated workspace, stream output over WebSocket, capture state.

### 4.1 Create `Terraform Agent/agent/executor.py`

```python
import asyncio
import subprocess
from pathlib import Path
from typing import AsyncGenerator

async def stream_apply(
    workspace: Path,
    aws_credentials: dict,
    run_id: str,
) -> AsyncGenerator[str, None]:
    """
    Runs: terraform apply -auto-approve -json
    Streams each line of stdout as it arrives.
    Each yielded line is a raw Terraform JSON event string.
    
    Env vars for subprocess:
      AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION
      TF_IN_AUTOMATION=1 (suppresses interactive prompts)
      TF_CLI_ARGS_apply="-compact-warnings"
    
    On non-zero exit code: raise IaCApplyError with captured stderr.
    """

async def get_outputs(workspace: Path, aws_credentials: dict) -> dict:
    """
    Runs: terraform output -json
    Parses JSON and returns flat dict:
    {
      "public_ip": "54.x.x.x",
      "instance_id": "i-0abc...",
      "keypair_name": "deplai-keypair",
      "arn": "arn:aws:ec2:...",
      "region": "us-east-1",
      ... (service-specific fields)
    }
    """

async def plan(workspace: Path, aws_credentials: dict) -> str:
    """
    Runs: terraform plan -json -out=tfplan
    Returns human-readable summary string (resource count to add/change/destroy).
    Used to show the user what will be created before apply.
    """
```

---

## Phase 5 — Output Parser

**Goal**: Turn raw `terraform output -json` into the structured dict that the UI resource card displays.

### 5.1 Create `Terraform Agent/agent/output_parser.py`

```python
from typing import Any

# Maps service type → list of output keys to extract from terraform output
SERVICE_OUTPUT_KEYS = {
    "ec2":          ["public_ip", "instance_id", "keypair_name", "availability_zone", "arn"],
    "s3":           ["bucket_id", "bucket_arn", "bucket_domain_name", "region"],
    "rds":          ["endpoint", "port", "db_instance_id", "db_instance_arn"],
    "ecs":          ["cluster_arn", "service_name", "task_definition_arn"],
    "lambda":       ["lambda_function_arn", "lambda_function_name", "lambda_function_url"],
    "elasticache":  ["primary_endpoint_address", "port", "cluster_id"],
    "alb":          ["lb_dns_name", "lb_arn", "target_group_arn"],
    "vpc":          ["vpc_id", "public_subnets", "private_subnets"],
}

def parse_outputs(raw_tf_outputs: dict, service_type: str) -> dict:
    """
    raw_tf_outputs format: { "output_name": { "value": ..., "type": ... }, ... }
    Extracts only the keys in SERVICE_OUTPUT_KEYS[service_type].
    Adds metadata: service_type, managed_by="deplai", timestamp.
    Returns flat dict ready for UI rendering.
    """

def extract_keypair_details(workspace_path: str) -> dict | None:
    """
    For EC2 deployments — reads the generated .pem file from workspace.
    Returns { "private_key_pem": "...", "keypair_name": "..." } or None.
    Private key must be included in the UI response ONCE and then scrubbed from disk.
    """
```

---

## Phase 6 — IaC Pipeline Orchestrator

**Goal**: Single entry point that chains all phases and maintains run state for async polling/streaming.

### 6.1 Create `Terraform Agent/agent/iac_pipeline.py`

```python
import asyncio
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable

class RunStatus(str, Enum):
    PENDING        = "pending"
    SELECTING_PARAMS = "selecting_params"
    VALIDATING     = "validating"
    PLANNING       = "planning"
    APPLYING       = "applying"
    COMPLETED      = "completed"
    FAILED         = "failed"

@dataclass
class IaCRun:
    run_id: str
    project_id: str
    service_type: str
    status: RunStatus = RunStatus.PENDING
    params: dict = field(default_factory=dict)
    plan_summary: str = ""
    apply_logs: list[str] = field(default_factory=list)
    outputs: dict = field(default_factory=dict)
    error: str | None = None
    workspace_path: str | None = None

# In-memory run store (keyed by run_id)
# For production: replace with Redis or DB-backed store
_RUNS: dict[str, IaCRun] = {}

async def run_pipeline(
    project_id: str,
    service_type: str,
    repo_context: dict,
    user_customizations: dict,
    aws_credentials: dict,
    aws_region: str,
    log_callback: Callable[[str], None] | None = None,
) -> IaCRun:
    """
    Full pipeline:
    1. Create IaCRun, store in _RUNS
    2. Phase 2: select_params → run.params
    3. Phase 3: validate_with_retry → run.workspace_path
    4. executor.plan → run.plan_summary
    5. executor.stream_apply → stream logs via log_callback, append to run.apply_logs
    6. executor.get_outputs → run.outputs
    7. output_parser.parse_outputs → normalize
    8. Set run.status = COMPLETED
    9. Cleanup workspace (but keep .pem key until retrieved once)
    
    On any exception: set run.status = FAILED, run.error = str(e), re-raise
    Returns the completed IaCRun.
    """

def get_run(run_id: str) -> IaCRun | None:
    return _RUNS.get(run_id)
```

---

## Phase 7 — Agentic Layer: New IaC Router

**Goal**: New FastAPI router exposing three endpoints: start pipeline, poll status, stream logs over WebSocket.

### 7.1 Create `Agentic Layer/routers/iac_apply.py`

```python
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/iac", tags=["iac"])

class IaCGenerateRequest(BaseModel):
    project_id: str
    service_type: str               # "ec2" | "s3" | "rds" | etc.
    repo_context: dict              # forwarded from pipeline stages 1-2
    user_customizations: dict       # from customization agent
    aws_credentials: dict           # { access_key_id, secret_access_key, region }
    # NOTE: credentials are NEVER logged or persisted

class IaCGenerateResponse(BaseModel):
    run_id: str
    status: str

@router.post("/generate-and-apply", response_model=IaCGenerateResponse)
async def generate_and_apply(body: IaCGenerateRequest, background_tasks: BackgroundTasks):
    """
    Starts the IaC pipeline as a background task.
    Returns run_id immediately for polling / WebSocket connection.
    """

@router.get("/status/{run_id}")
async def get_status(run_id: str):
    """
    Returns current IaCRun status + outputs (if completed) + error (if failed).
    Connector polls this at 3s intervals while apply is in progress.
    """

@router.websocket("/ws/{run_id}")
async def apply_logs_ws(websocket: WebSocket, run_id: str):
    """
    Streams apply log lines to the frontend in real time.
    Sends JSON: { "type": "log" | "status" | "done", "data": "..." }
    Closes connection when status reaches COMPLETED or FAILED.
    """

@router.delete("/run/{run_id}")
async def cleanup_run(run_id: str):
    """
    Destroys the Terraform workspace for a run.
    Called by UI "Destroy resources" button.
    Runs: terraform destroy -auto-approve in workspace_path.
    """
```

### 7.2 Modify `Agentic Layer/main.py`

Add one import and one `app.include_router()` call for the new `iac_apply` router. No other changes.

```python
# Add near other router imports:
from routers.iac_apply import router as iac_router

# Add after existing include_router calls:
app.include_router(iac_router)
```

---

## Phase 8 — Connector: Replace Deploy Route

**Goal**: Stop generating raw HCL in the Connector. Delegate fully to Agentic Layer.

### 8.1 Modify `Connector/src/app/api/pipeline/deploy/route.ts`

**Delete**: All code that constructs the six-file HCL bundle locally via LLM.

**Replace with**:
```typescript
// POST /api/pipeline/deploy
export async function POST(req: Request) {
  const session = await getIronSession(...)
  const body = await req.json()
  
  // Forward to Agentic Layer new endpoint
  const agenticResponse = await fetch(
    `${process.env.AGENTIC_LAYER_URL}/api/iac/generate-and-apply`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": process.env.DEPLAI_SERVICE_KEY!,
      },
      body: JSON.stringify({
        project_id:          body.project_id,
        service_type:        body.service_type,
        repo_context:        body.repo_context,
        user_customizations: body.user_customizations,
        aws_credentials: {
          access_key_id:     body.aws_access_key_id,
          secret_access_key: body.aws_secret_access_key,
          region:            body.aws_region ?? "us-east-1",
        },
      }),
    }
  )
  
  if (!agenticResponse.ok) {
    return NextResponse.json({ error: "IaC pipeline failed to start" }, { status: 502 })
  }
  
  const { run_id } = await agenticResponse.json()
  return NextResponse.json({ run_id, status: "pending" })
}
```

### 8.2 Create `Connector/src/app/api/pipeline/iac-status/[runId]/route.ts`

Thin proxy that forwards status polls from frontend → Agentic Layer `/api/iac/status/{run_id}`. Adds session validation so only the project owner can poll.

---

## Phase 9 — Agentic Layer Dockerfile: Install Terraform CLI

### 9.1 Modify `Agentic Layer/Dockerfile`

Add Terraform installation. Insert after base image declaration, before `COPY requirements.txt`:

```dockerfile
# Install Terraform CLI
RUN apt-get update && apt-get install -y gnupg software-properties-common curl unzip && \
    curl -fsSL https://releases.hashicorp.com/terraform/1.9.5/terraform_1.9.5_linux_amd64.zip \
      -o /tmp/terraform.zip && \
    unzip /tmp/terraform.zip -d /usr/local/bin && \
    rm /tmp/terraform.zip && \
    terraform version

# Install tflint for validation
RUN curl -fsSL https://github.com/terraform-linters/tflint/releases/download/v0.53.0/tflint_linux_amd64.zip \
      -o /tmp/tflint.zip && \
    unzip /tmp/tflint.zip -d /usr/local/bin && \
    rm /tmp/tflint.zip
```

### 9.2 Add to `Agentic Layer/requirements.txt`

```
# Already present (do not duplicate):
# anthropic, fastapi, uvicorn, boto3

# Add if not present:
python-multipart>=0.0.9
```

---

## Phase 10 — Frontend: Resource Card UI

**Goal**: After apply completes, show a "provisioned resource" card with all outputs. Replace the current static download-bundle UI.

### 10.1 Create `Connector/src/components/pipeline/ResourceCard.tsx`

```typescript
// Props interface:
interface ResourceCardProps {
  runId: string
  serviceType: string
  outputs: {
    public_ip?: string
    instance_id?: string
    keypair_name?: string
    private_key_pem?: string   // shown once, then user must download
    bucket_id?: string
    endpoint?: string
    arn?: string
    region?: string
    [key: string]: unknown
  }
  onDestroy: (runId: string) => void
}

// Component renders:
// - Service type badge (EC2 / S3 / RDS / etc.)
// - Key-value grid of all outputs (copy-to-clipboard on each value)
// - Private key PEM: textarea with "Download .pem" button (shown once with warning)
// - Region + ARN in monospace
// - "Destroy resources" button → calls DELETE /api/pipeline/iac-status/{runId}
//   with a confirmation dialog before proceeding
// - Timestamp of deployment
```

### 10.2 Create `Connector/src/components/pipeline/ApplyLogViewer.tsx`

```typescript
// Real-time log viewer connecting to Agentic Layer WebSocket via:
// /api/pipeline/iac-ws-proxy/{runId}  (Connector proxy — see 10.3)
// 
// Shows:
// - Scrollable terminal-style log output (dark bg, monospace font)
// - Status indicator: pending → validating → planning → applying → done/error
// - Progress stepper matching RunStatus enum
// - On "done" → calls onComplete(outputs) prop to render ResourceCard
```

### 10.3 Create `Connector/src/app/api/pipeline/iac-ws-proxy/[runId]/route.ts`

WebSocket proxy: browser ↔ Connector ↔ Agentic Layer. Needed because:
- Browser cannot reach `localhost:8000` directly in production
- Connector enforces session auth before opening backend WS

```typescript
// Uses Node.js 'ws' package to bridge two WebSocket connections.
// Validates session ownership before connecting upstream.
// Forwards all JSON message frames transparently.
```

### 10.4 Modify pipeline stage UI (whichever page renders the deploy stage)

Find the component/page that renders Stage 7 (diagram/cost approval) and the current deploy button. After approval:
- Replace "Generating IaC bundle..." with `<ApplyLogViewer runId={runId} onComplete={setOutputs} />`
- On complete, render `<ResourceCard outputs={outputs} runId={runId} onDestroy={handleDestroy} />`

---

## Phase 11 — Environment & Configuration

### 11.1 Add to `.env.template`

```bash
# IaC pipeline tuning
IAC_MAX_VALIDATION_RETRIES=3          # how many times to retry on tf validate failure
IAC_WORKSPACE_ROOT=/tmp/deplai-workspaces  # where tf workspaces are created inside container
IAC_WORKSPACE_TTL_HOURS=24            # auto-cleanup old workspaces
IAC_TERRAFORM_PARALLELISM=10          # -parallelism flag for apply
```

### 11.2 Add to `Agentic Layer` env reads

Read the above vars in `Terraform Agent/agent/executor.py` via `os.getenv()` with the defaults shown above.

---

## Dependency additions

### `Terraform Agent/requirements.txt` (create if missing)
```
anthropic>=0.40.0
python-dotenv>=1.0.0
```

### `Connector/package.json` — add dev dependency
```bash
npm install ws @types/ws
```
Only needed for the WebSocket proxy route.

---

## Testing checkpoints for the coding agent

After each phase, the agent should verify:

**After Phase 1**: `terraform validate` passes on each template directory individually with a sample `terraform.tfvars.json`.

**After Phase 3**: Call `validate_with_retry()` with intentionally broken params (e.g. invalid instance type). Confirm the retry loop catches it and `correct_params()` fixes it within 2 retries.

**After Phase 4**: Mock `stream_apply()` by running against LocalStack (or a real AWS account with a t3.micro EC2). Confirm `get_outputs()` returns the expected keys.

**After Phase 7**: `POST /api/iac/generate-and-apply` with dummy credentials → returns `run_id`. `GET /api/iac/status/{run_id}` → returns `{ status: "pending" }` immediately.

**After Phase 8**: `POST /api/pipeline/deploy` from Connector → no longer returns a zip file, returns `{ run_id }`. Old bundle-download code path is gone.

**After Phase 10**: In browser, after clicking Deploy, the log viewer appears, status steps through validating → applying, and on completion the ResourceCard renders with IPs and ARN.

---

## Execution order for the coding agent

```
Phase 1  → Phase 2  → Phase 3 (validator)
                    → Phase 3.2 (correct_params)
Phase 4  → Phase 5  → Phase 6  (pipeline orchestrator)
Phase 7.1 (new router) → Phase 7.2 (register router)
Phase 8.1 (strip old deploy) → Phase 8.2 (status proxy)
Phase 9  (Dockerfile — must be done before integration testing)
Phase 10.1 (ResourceCard) → 10.2 (LogViewer) → 10.3 (WS proxy) → 10.4 (wire into page)
Phase 11 (env vars)
```

Do **not** start Phase 8 until Phase 7 is working end-to-end. The Connector deploy route must have a working Agentic Layer endpoint to point to before it stops generating bundles locally.

---

## What this does NOT change

- The six-file bundle download path for Azure/GCP stays as-is (AWS-only is being replaced)
- The GitOps deploy path (GitHub repo creation + workflow injection) is untouched
- `DEPLAI_FREE_TIER_EC2_TYPES` env var still applies — the param selector respects it
- Budget guardrail on `/api/pipeline/deploy` stays — the new route must still check `budget_override`

---

*Generated from audit of `adityajayashankar/Deplai` main branch — May 2026*
