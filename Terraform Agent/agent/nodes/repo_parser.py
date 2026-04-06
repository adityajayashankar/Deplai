"""repo_parser.py – Reads the repository from disk (if not already loaded) and
extracts infrastructure signals from file names and content.

Bug fixed: previously this node expected ``raw_file_contents`` to be
pre-populated by the caller, meaning ``repo_reader`` was never actually
invoked during a normal graph run.  Now the node reads the repo itself when
the contents dict is absent or empty.
"""
from __future__ import annotations

import re
from typing import Any

from state import AgentState
from tools.repo_reader import read_repo


SERVERLESS_HINTS = ("serverless.yml", "lambda_handler", "handler.py")


def run_repo_parser(state: AgentState) -> AgentState:
    # ── 1. Load repo from disk when not already provided ──────────────────
    raw_file_contents: dict[str, str] = state.get("raw_file_contents") or {}

    if not raw_file_contents:
        repo_path: str | None = state.get("repo_path")
        if not repo_path:
            raise ValueError(
                "repo_parser: neither 'raw_file_contents' nor 'repo_path' is "
                "set in AgentState.  Pass a 'repo_path' so the agent can read "
                "the repository from disk."
            )
        loaded = read_repo(repo_path)
        raw_file_tree: str = loaded.pop("__tree__", "")
        raw_file_contents = loaded
        state["raw_file_tree"] = raw_file_tree
        state["raw_file_contents"] = raw_file_contents
    else:
        raw_file_tree = state.get("raw_file_tree", "")

    # ── 2. Build a unified text blob for signal detection ─────────────────
    files = sorted(k for k in raw_file_contents.keys() if not k.startswith("__"))
    joined = "\n".join(files) + "\n" + "\n".join(raw_file_contents.values())
    lower_blob = joined.lower()

    # ── 3. Detect high-level signals ──────────────────────────────────────
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
    # Additional signals
    if "mongodb" in lower_blob or "pymongo" in lower_blob or "motor" in lower_blob:
        signals.append("mongodb_detected")
    if "rabbitmq" in lower_blob or "pika" in lower_blob or "amqp" in lower_blob:
        signals.append("rabbitmq_detected")
    if any(name.endswith(".go") for name in files):
        signals.append("golang_detected")
    if any(name.endswith((".ts", ".tsx", ".js", ".jsx")) for name in files):
        signals.append("nodejs_detected")
    if "package.json" in files:
        signals.append("npm_project_detected")

    # ── 4. Build structured tech-stack summary ────────────────────────────
    tech_stack: dict[str, Any] = {
        "languages": [],
        "frameworks": [],
        "containers": "dockerfile" in lower_blob,
        "data_stores": [],
        "workers": "celery" in lower_blob,
        "ports": [],
        "files": files,
        "tree": raw_file_tree,
    }

    # Languages
    if any(name.endswith(".py") for name in files):
        tech_stack["languages"].append("python")
    if any(name.endswith(".go") for name in files):
        tech_stack["languages"].append("go")
    if any(name.endswith((".ts", ".tsx")) for name in files):
        tech_stack["languages"].append("typescript")
    elif any(name.endswith((".js", ".jsx")) for name in files):
        tech_stack["languages"].append("javascript")
    if any(name.endswith((".java", ".kt")) for name in files):
        tech_stack["languages"].append("java")

    # Frameworks
    if "fastapi" in lower_blob:
        tech_stack["frameworks"].append("fastapi")
    if "uvicorn" in lower_blob:
        tech_stack["frameworks"].append("uvicorn")
    if "django" in lower_blob:
        tech_stack["frameworks"].append("django")
    if "flask" in lower_blob:
        tech_stack["frameworks"].append("flask")
    if "express" in lower_blob:
        tech_stack["frameworks"].append("express")
    if "nextjs" in lower_blob or "next.js" in lower_blob:
        tech_stack["frameworks"].append("nextjs")

    # Data stores
    if "sqlalchemy" in lower_blob or "psycopg2" in lower_blob:
        tech_stack["data_stores"].append("postgres")
    if "redis" in lower_blob:
        tech_stack["data_stores"].append("redis")
    if "mongodb" in lower_blob or "pymongo" in lower_blob:
        tech_stack["data_stores"].append("mongodb")
    if "mysql" in lower_blob or "mysqlclient" in lower_blob:
        tech_stack["data_stores"].append("mysql")

    # Exposed ports (`:8000`, `EXPOSE 8000`, `"8000:8000"`, etc.)
    for match in re.findall(r"(?:expose\s+|:\s*|[\"'])(\d{2,5})(?:[\"':]|\s|$)", lower_blob):
        if match not in tech_stack["ports"]:
            tech_stack["ports"].append(match)

    state["tech_stack"] = tech_stack
    state["detected_signals"] = signals
    return state