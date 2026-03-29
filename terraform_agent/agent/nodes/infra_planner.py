from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from models.llm_config import chat_json
from state import AgentState


PROMPTS_DIR = Path(__file__).resolve().parents[1] / "prompts"


def _read_prompt(name: str) -> str:
    return (PROMPTS_DIR / name).read_text(encoding="utf-8")


def _fallback_plan(signals: list[str]) -> dict[str, Any]:
    has_container = "dockerfile_present" in signals
    has_serverless = "serverless_indicators_detected" in signals
    has_db = "postgres_libraries_detected" in signals
    has_redis = "redis_detected" in signals
    has_worker = "celery_worker_detected" in signals

    compute = "ecs_fargate" if has_container and not has_serverless else "lambda" if has_serverless else "requires_clarification"

    services = ["api"]
    if has_worker:
        services.append("worker")

    return {
        "compute": compute,
        "services": services,
        "database": "rds_postgres" if has_db else "none",
        "cache": "elasticache_redis" if has_redis else "none",
        "networking": "vpc_with_private_subnets",
        "state_backend": "s3_dynamodb",
    }


def run_infra_planner(state: AgentState) -> AgentState:
    system_prompt = _read_prompt("system_prompt.txt")
    planning_prompt = _read_prompt("infra_planning_prompt.txt")

    payload = {
        "tech_stack": state.get("tech_stack", {}),
        "detected_signals": state.get("detected_signals", []),
        "raw_file_tree": state.get("raw_file_tree", ""),
    }
    user_prompt = f"{planning_prompt}\n\nInput:\n{json.dumps(payload, indent=2)}"

    try:
        plan = chat_json(system_prompt, user_prompt)
    except Exception:
        plan = _fallback_plan(state.get("detected_signals", []))

    if not isinstance(plan, dict) or "compute" not in plan:
        plan = _fallback_plan(state.get("detected_signals", []))

    state["infra_plan"] = plan
    return state
