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
    gen_prompt = _read_prompt("terraform_generation_prompt.txt")

    user_prompt = (
        f"{gen_prompt}\n\n"
        f"Infra plan:\n{json.dumps(state.get('infra_plan', {}), indent=2)}\n\n"
        "Return terraform_files in JSON mode."
    )

    terraform_files: dict[str, str]
    try:
        response = chat_json(system_prompt, user_prompt)
        terraform_files = response.get("terraform_files", {}) if isinstance(response, dict) else {}
    except Exception:
        terraform_files = {}

    if not terraform_files or not isinstance(terraform_files, dict):
        terraform_files = generate_terraform(state.get("infra_plan", {}))

    cleaned: dict[str, str] = {}
    for path, content in terraform_files.items():
        if isinstance(path, str) and isinstance(content, str):
            cleaned[path] = content

    state["terraform_files"] = cleaned
    return state
