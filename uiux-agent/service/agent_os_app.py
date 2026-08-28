"""AgentOS service entry point.

This is the file you run to start the UI/UX Refactor Agent as a local
AgentOS instance:

    python service/agent_os_app.py

It wires:
1. MongoDB (local mongod or Atlas) as the persistence backend.
2. The UI/UX Refactor Workflow with all its agents and tools.
3. AgentOS serving on port 7777 with tracing enabled and telemetry disabled.

Tier 0 (default):
    mongod --dbpath ./tmp/mongo-data --port 27017 --bind_ip 127.0.0.1
    python service/agent_os_app.py

Tier 1 (Docker Compose):
    docker compose up -d --build
    # AgentOS is served at http://localhost:7777

Control Plane connection (both tiers):
    os.agno.com → Add new OS → Local → http://localhost:7777
"""

from __future__ import annotations

import os
import sys

# Add the uiux-agent root to the Python path so that intra-package imports
# work when running this file directly.
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_AGENT_ROOT = os.path.dirname(_THIS_DIR)
if _AGENT_ROOT not in sys.path:
    sys.path.insert(0, _AGENT_ROOT)

# ── Environment ──────────────────────────────────────────────────────────

# Kill telemetry immediately, before any Agno import can phone home.
os.environ.setdefault("AGNO_TELEMETRY", "false")

from agno.agent import Agent
from agno.workflow import Workflow

# ── MongoDB Setup ────────────────────────────────────────────────────────

# Tier 0: local mongod (default)
# Tier 1+: Atlas or Docker Compose (swap the URL via env var)
MONGO_DB_URL = os.environ.get("MONGO_DB_URL", "mongodb://localhost:27017")
MONGO_DB_NAME = os.environ.get("MONGO_DB_NAME", "agno")

try:
    from agno.db.mongo import MongoDb
except ImportError as exc:
    raise RuntimeError(
        "MongoDB support is required for the UI/UX agent. Install agno[os] and pymongo."
    ) from exc

# Create the DB instance — same interface whether local or Atlas.
db = MongoDb(
    db_url=MONGO_DB_URL,
    db_name=MONGO_DB_NAME,
    session_collection="uiux_refactor_sessions",
)

# ── Workflow Import ──────────────────────────────────────────────────────

from workflows.uiux_refactor import build_uiux_refactor_workflow

workflow = build_uiux_refactor_workflow(db)

# ── AgentOS App ──────────────────────────────────────────────────────────

# AgentOS wraps the Workflow in a FastAPI app with 50+ endpoints:
# - /workflows/{id}/runs — trigger a refactoring run
# - /workflows/{id}/runs/{run_id}/continue — resolve HITL pauses
# - /health — health check
# - /docs — OpenAPI docs
# - Tracing, sessions, RBAC — all built in.

from agno.os import AgentOS
from fastapi import FastAPI

base_app = FastAPI(
    title="UI/UX Refactor Agent",
    description="Agno-powered UI/UX refactoring pipeline",
    version="0.1.0",
)


@base_app.get("/uiux/health")
async def health():
    """Health contract consumed by the Connector customization UI."""
    ready = bool(workflow.steps)
    stage_count = len(workflow.steps) if workflow.steps else 0
    return {
        "status": "ok" if ready else "degraded",
        "ready": ready,
        "detail": (
            f"UI/UX workflow ready with {stage_count} stages."
            if ready
            else "The workflow scaffold has no executable stages yet; UI/UX runs are disabled to prevent no-op requests."
        ),
        "workflow": workflow.id,
        "db": "mongodb",
        "stages": stage_count,
    }


agent_os = AgentOS(
    id="uiux-refactor-agent",
    workflows=[workflow],
    db=db,
    base_app=base_app,
    tracing=True,
    telemetry=False,
)
app = agent_os.get_app()

# ── Entrypoint ───────────────────────────────────────────────────────────

AGENTOS_PORT = int(os.environ.get("AGENTOS_PORT", "7777"))

if __name__ == "__main__":
    import uvicorn

    print(f"Starting UI/UX Refactor Agent on port {AGENTOS_PORT}...")
    print(f"  MongoDB: {MONGO_DB_URL}")
    print(f"  DB name: {MONGO_DB_NAME}")
    print(f"  Telemetry: {os.environ.get('AGNO_TELEMETRY', 'false')}")
    print(f"  Docs: http://localhost:{AGENTOS_PORT}/docs")
    print(f"  Control Plane: os.agno.com → Add new OS → Local → http://localhost:{AGENTOS_PORT}")

    uvicorn.run(
        "service.agent_os_app:app",
        host="0.0.0.0",
        port=AGENTOS_PORT,
        reload=True,
    )
