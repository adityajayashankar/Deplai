from __future__ import annotations

import json
from pathlib import Path

from models.llm_config import chat_json
from state import AgentState


PROMPTS_DIR = Path(__file__).resolve().parents[1] / "prompts"


def _read_prompt(name: str) -> str:
    return (PROMPTS_DIR / name).read_text(encoding="utf-8")


def run_refiner(state: AgentState) -> AgentState:
    current_files = state.get("terraform_files", {})
    errors = state.get("validation_errors", [])
    retry_count = int(state.get("retry_count", 0)) + 1
    state["retry_count"] = retry_count

    system_prompt = _read_prompt("system_prompt.txt")
    refine_prompt = (
        "You are fixing terraform based on validator failures. "
        "Return JSON only with key terraform_files mapping file paths to complete corrected file contents."
    )

    user_prompt = (
        f"Validation errors:\n{json.dumps(errors, indent=2)}\n\n"
        f"Current terraform files:\n{json.dumps(current_files, indent=2)}\n\n"
        "Fix all errors while preserving production readiness."
    )

    try:
        response = chat_json(system_prompt + "\n\n" + refine_prompt, user_prompt)
        refined_files = response.get("terraform_files", {}) if isinstance(response, dict) else {}
    except Exception:
        refined_files = {}

    if isinstance(refined_files, dict) and refined_files:
        cleaned: dict[str, str] = {}
        for path, content in refined_files.items():
            if isinstance(path, str) and isinstance(content, str):
                cleaned[path] = content
        if cleaned:
            state["terraform_files"] = cleaned

    return state
