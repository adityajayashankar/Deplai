"""terraform_generator.py – Calls the LLM to produce Terraform files and falls
back to the deterministic generator when the LLM response is absent or invalid.

Key fix: previously the LLM *system* prompt and *user* prompt were swapped when
calling ``chat_json``, causing the model to see the system constraints as user
input.  Also the fallback path now correctly forwards ``infra_plan`` so the
deterministic generator can make plan-aware decisions.
"""
from __future__ import annotations

import json
from pathlib import Path

from models.llm_config import chat_json
from state import AgentState
from tools.terraform_tools import generate_terraform


PROMPTS_DIR = Path(__file__).resolve().parents[1] / "prompts"


def _read_prompt(name: str) -> str:
    return (PROMPTS_DIR / name).read_text(encoding="utf-8")


def run_terraform_generator(state: AgentState) -> AgentState:
    system_prompt = _read_prompt("system_prompt.txt")
    gen_prompt    = _read_prompt("terraform_generation_prompt.txt")
    infra_plan    = state.get("infra_plan", {})

    user_prompt = (
        f"{gen_prompt}\n\n"
        f"Infra plan:\n{json.dumps(infra_plan, indent=2)}\n\n"
        "Return terraform_files in JSON mode."
    )

    terraform_files: dict[str, str] = {}

    try:
        response = chat_json(system_prompt, user_prompt)
        if isinstance(response, dict):
            terraform_files = response.get("terraform_files", {})
    except Exception as exc:
        # Log and fall through to the deterministic generator
        print(f"[terraform_generator] LLM call failed, using deterministic fallback: {exc}")
        terraform_files = {}

    # Fall back to the deterministic generator when:
    #   - LLM returned nothing / an empty dict
    #   - LLM returned something that isn't a dict of {path: content} pairs
    if not terraform_files or not isinstance(terraform_files, dict):
        terraform_files = generate_terraform(infra_plan)

    # Sanitise: keep only str->str pairs (guard against partial LLM responses)
    cleaned: dict[str, str] = {
        path: content
        for path, content in terraform_files.items()
        if isinstance(path, str) and isinstance(content, str)
    }

    state["terraform_files"] = cleaned
    return state