from __future__ import annotations

import re
from typing import Any

from models.llm_config import get_llm_client
from state import AgentState


SERVERLESS_HINTS = ("serverless.yml", "lambda_handler", "handler.py")


def run_repo_parser(state: AgentState) -> AgentState:
    _ = get_llm_client()

    raw_tree = state.get("raw_file_tree", "")
    contents = state.get("raw_file_contents", {})

    files = sorted(k for k in contents.keys() if not k.startswith("__"))
    joined = "\n".join(files) + "\n" + "\n".join(contents.values())
    lower_blob = joined.lower()

    signals: list[str] = []
    if "dockerfile" in lower_blob:
        signals.append("dockerfile_present")
    if "docker-compose" in lower_blob:
        signals.append("compose_present")
    if "psycopg2" in lower_blob or "sqlalchemy" in lower_blob:
        signals.append("postgres_libraries_detected")
    if "redis" in lower_blob:
        signals.append("redis_detected")
    if "celery" in lower_blob:
        signals.append("celery_worker_detected")
    if any(h in lower_blob for h in SERVERLESS_HINTS):
        signals.append("serverless_indicators_detected")

    tech_stack: dict[str, Any] = {
        "languages": [],
        "frameworks": [],
        "containers": "dockerfile" in lower_blob,
        "data_stores": [],
        "workers": "celery" in lower_blob,
        "ports": [],
        "files": files,
        "tree": raw_tree,
    }

    if any(name.endswith(".py") for name in files):
        tech_stack["languages"].append("python")
    if "fastapi" in lower_blob:
        tech_stack["frameworks"].append("fastapi")
    if "uvicorn" in lower_blob:
        tech_stack["frameworks"].append("uvicorn")
    if "sqlalchemy" in lower_blob or "psycopg2" in lower_blob:
        tech_stack["data_stores"].append("postgres")
    if "redis" in lower_blob:
        tech_stack["data_stores"].append("redis")

    for match in re.findall(r":(\d{2,5})", lower_blob):
        if match not in tech_stack["ports"]:
            tech_stack["ports"].append(match)

    state["tech_stack"] = tech_stack
    state["detected_signals"] = signals
    return state
