from __future__ import annotations

import json
import os
import sys
from math import ceil
from pathlib import Path
from typing import Any, Callable
from urllib import error as urlerror
from urllib import request as urlrequest

from anthropic import Anthropic
from dotenv import load_dotenv

for dotenv_path in (
    Path(__file__).resolve().with_name(".env"),
    Path(__file__).resolve().parents[1] / ".env",
):
    if dotenv_path.exists():
        load_dotenv(dotenv_path=dotenv_path, override=False)

for candidate in (Path(__file__).resolve().parents[1], Path("/app")):
    if candidate.exists() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from architecture_decision.service import _profile_to_architecture_view, _profile_to_infra_plan
from deployment_planning_contract import (
    ArchitectureAnswersDocument,
    ArchitectureQuestion,
    ArchitectureReviewPayload,
    ConflictItem,
    DeploymentProfileDocument,
    LowConfidenceItem,
    QuestionOption,
    RepositoryContextDocument,
    parse_deployment_profile,
)
from planning_runtime import (
    analyzer_context_md_path,
    analyzer_context_path,
    decision_answers_path,
    decision_approval_payload_path,
    decision_architecture_view_path,
    decision_claude_usage_path,
    decision_profile_path,
    decision_review_payload_path,
    read_json,
    runtime_paths_for_workspace,
    write_json,
)
from repository_sources import resolve_repository_source
from stage7_bridge import run_stage7_approval_payload
from terraform_agent.agent.engine.deployment_profile import build_profile_bundle, build_profile_manifest
from terraform_agent.agent.engine.runtime import DEFAULT_PROVIDER_CONSTRAINT


SKIP_DIRS = {
    ".git",
    ".next",
    ".venv",
    "venv",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".terraform",
    "dist",
    "build",
    "coverage",
}

TEXT_EXTENSIONS = {
    ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".py", ".js", ".ts", ".tsx", ".jsx",
    ".html", ".css", ".scss", ".env", ".example", ".ini", ".cfg", ".conf", ".sql", ".tf",
    ".prisma", ".sh", ".dockerignore",
}
IMPORTANT_NAMES = {
    "readme.md", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
    "requirements.txt", "pyproject.toml", "dockerfile", "docker-compose.yml", "docker-compose.yaml",
    "procfile", ".env.example", ".env.local.example", "next.config.js", "next.config.ts",
    "vite.config.ts", "vite.config.js", "tsconfig.json", "schema.prisma", "alembic.ini",
}
ENTRYPOINT_HINTS = (
    "main.py", "app.py", "server.py", "manage.py",
    "index.js", "server.js", "app.js", "main.js",
    "index.ts", "server.ts", "app.ts", "main.ts",
)
MAX_TREE_FILES = 300
MAX_FILE_CHARS = 7000
MAX_TOTAL_CHARS = 48000
MAX_FILES = 14

REPO_ANALYZER_MODEL = os.getenv("CLAUDE_REPO_ANALYZER_MODEL", "claude-3-5-haiku-20241022").strip() or "claude-3-5-haiku-20241022"
REVIEW_QUESTION_MODEL = os.getenv("CLAUDE_REVIEW_QUESTION_MODEL", "claude-3-5-haiku-20241022").strip() or "claude-3-5-haiku-20241022"
INFRA_PLANNER_MODEL = os.getenv("CLAUDE_INFRA_PLANNER_MODEL", os.getenv("CLAUDE_MODEL", "claude-3-7-sonnet-latest")).strip() or "claude-3-7-sonnet-latest"
TERRAFORM_CONTEXT_MODEL = os.getenv("CLAUDE_TERRAFORM_CONTEXT_MODEL", REPO_ANALYZER_MODEL).strip() or REPO_ANALYZER_MODEL
TERRAFORM_PROFILE_MODEL = os.getenv("CLAUDE_TERRAFORM_PROFILE_MODEL", INFRA_PLANNER_MODEL).strip() or INFRA_PLANNER_MODEL
TERRAFORM_STRUCTURE_MODEL = os.getenv("CLAUDE_TERRAFORM_STRUCTURE_MODEL", REPO_ANALYZER_MODEL).strip() or REPO_ANALYZER_MODEL
TERRAFORM_VALIDATOR_MODEL = os.getenv("CLAUDE_TERRAFORM_VALIDATOR_MODEL", REPO_ANALYZER_MODEL).strip() or REPO_ANALYZER_MODEL
MAX_CLAUDE_PIPELINE_COST_USD = float(os.getenv("DEPLAI_CLAUDE_MAX_PIPELINE_COST_USD", "3.0") or "3.0")
MAX_CLAUDE_TERRAFORM_GEN_COST_USD = float(os.getenv("DEPLAI_CLAUDE_MAX_TERRAFORM_GEN_COST_USD", "1.0") or "1.0")
FREE_TERRAFORM_DEFAULT_PROVIDER = "groq"
FREE_TERRAFORM_DEFAULT_MODEL = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant").strip() or "llama-3.1-8b-instant"
FREE_TERRAFORM_OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "meta-llama/llama-3.3-70b-instruct:free").strip() or "meta-llama/llama-3.3-70b-instruct:free"
FREE_TERRAFORM_OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5-coder:7b").strip() or "qwen2.5-coder:7b"
TERRAFORM_LLM_PROVIDERS = ("groq", "openrouter", "ollama")
MODEL_PRICING_PER_MILLION: dict[str, tuple[float, float]] = {
    "claude-3-5-haiku-20241022": (0.80, 4.00),
    "claude-3-5-sonnet-20241022": (3.00, 15.00),
    "claude-3-7-sonnet-latest": (3.00, 15.00),
}


def _claude_client() -> Anthropic:
    api_key = (
        os.getenv("ANTHROPIC_API_KEY", "").strip()
        or os.getenv("CLAUDE_API_KEY", "").strip()
    )
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is required for the Claude deployment pipeline.")
    return Anthropic(api_key=api_key)


def _claude_available() -> bool:
    return bool(
        os.getenv("ANTHROPIC_API_KEY", "").strip()
        or os.getenv("CLAUDE_API_KEY", "").strip()
    )


def _pricing_for_model(model: str) -> tuple[float, float]:
    normalized = str(model or "").strip().lower()
    if any(token in normalized for token in ("llama", "qwen", "gpt-oss", "mistral", ":free")):
        return (0.0, 0.0)
    if normalized in MODEL_PRICING_PER_MILLION:
        return MODEL_PRICING_PER_MILLION[normalized]
    if "haiku" in normalized:
        return MODEL_PRICING_PER_MILLION["claude-3-5-haiku-20241022"]
    return MODEL_PRICING_PER_MILLION["claude-3-7-sonnet-latest"]


def _estimate_tokens(text: str) -> int:
    return max(1, ceil(len(str(text or "")) / 4))


def _usage_snapshot(workspace: str) -> dict[str, Any]:
    path = decision_claude_usage_path(workspace)
    if path.exists():
        try:
            existing = read_json(path)
            if isinstance(existing, dict):
                return existing
        except Exception:
            pass
    return {
        "workspace": workspace,
        "budget_cap_usd": MAX_CLAUDE_PIPELINE_COST_USD,
        "total_usd": 0.0,
        "calls": [],
    }


def _write_usage_snapshot(workspace: str, payload: dict[str, Any]) -> None:
    write_json(decision_claude_usage_path(workspace), payload)


def _usd_cost_for_tokens(model: str, input_tokens: int, output_tokens: int) -> float:
    input_rate, output_rate = _pricing_for_model(model)
    return ((max(0, input_tokens) * input_rate) + (max(0, output_tokens) * output_rate)) / 1_000_000


def _guard_budget(*, workspace: str, model: str, system_prompt: str, user_prompt: str, max_tokens: int, stage: str) -> None:
    usage = _usage_snapshot(workspace)
    estimated_input_tokens = _estimate_tokens(system_prompt) + _estimate_tokens(user_prompt)
    projected_cost = _usd_cost_for_tokens(model, estimated_input_tokens, max_tokens)
    current_total = float(usage.get("total_usd") or 0.0)
    if current_total + projected_cost > MAX_CLAUDE_PIPELINE_COST_USD:
        raise RuntimeError(
            f"Claude budget exceeded for {stage}. "
            f"Current spend ${current_total:.4f}, projected worst-case ${projected_cost:.4f}, "
            f"cap ${MAX_CLAUDE_PIPELINE_COST_USD:.2f}."
        )

    terraform_stages = {
        "deployment_profile",
        "terraform_repo_context",
        "terraform_architecture_profile",
        "terraform_structure",
        "terraform_bundle_plan",
        "terraform_file_generation",
        "terraform_validation",
    }
    if stage in terraform_stages:
        calls = list(usage.get("calls") or [])
        terraform_stage_total = sum(
            float(call.get("cost_usd") or 0.0)
            for call in calls
            if str(call.get("stage") or "") in terraform_stages
        )
        if terraform_stage_total + projected_cost > MAX_CLAUDE_TERRAFORM_GEN_COST_USD:
            raise RuntimeError(
                "Terraform generation LLM budget exceeded. "
                f"Current spend ${terraform_stage_total:.4f}, projected worst-case ${projected_cost:.4f}, "
                f"cap ${MAX_CLAUDE_TERRAFORM_GEN_COST_USD:.2f}."
            )


def _record_usage(
    *,
    workspace: str,
    model: str,
    stage: str,
    system_prompt: str,
    user_prompt: str,
    response: Any,
) -> None:
    usage_payload = _usage_snapshot(workspace)
    usage = getattr(response, "usage", None)
    input_tokens = int(
        getattr(usage, "input_tokens", 0)
        + getattr(usage, "cache_creation_input_tokens", 0)
        + getattr(usage, "cache_read_input_tokens", 0)
    )
    output_tokens = int(getattr(usage, "output_tokens", 0))
    if input_tokens <= 0:
        input_tokens = _estimate_tokens(system_prompt) + _estimate_tokens(user_prompt)
    cost_usd = _usd_cost_for_tokens(model, input_tokens, output_tokens)
    usage_payload["budget_cap_usd"] = MAX_CLAUDE_PIPELINE_COST_USD
    usage_payload["total_usd"] = round(float(usage_payload.get("total_usd") or 0.0) + cost_usd, 6)
    calls = list(usage_payload.get("calls") or [])
    calls.append(
        {
            "stage": stage,
            "model": model,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost_usd": round(cost_usd, 6),
        }
    )
    usage_payload["calls"] = calls
    _write_usage_snapshot(workspace, usage_payload)


def _extract_json_object(text: str) -> dict[str, Any]:
    raw = str(text or "").strip()
    if not raw:
        raise ValueError("Claude returned empty content.")
    depth = 0
    start = -1
    for index, ch in enumerate(raw):
        if ch == "{":
            if depth == 0:
                start = index
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start != -1:
                candidate = raw[start : index + 1]
                try:
                    parsed = json.loads(candidate)
                    if isinstance(parsed, dict):
                        return parsed
                except json.JSONDecodeError:
                    start = -1
                    continue
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("Claude response was valid JSON but not an object.")
    return parsed


def _call_claude_json(
    *,
    workspace: str,
    stage: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 4096,
) -> dict[str, Any]:
    _guard_budget(
        workspace=workspace,
        model=model,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        max_tokens=max_tokens,
        stage=stage,
    )
    client = _claude_client()
    try:
        response = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system_prompt,
            messages=[{"role": "user", "content": user_prompt}],
        )
    except Exception as exc:
        message = str(exc)
        lowered = message.lower()
        if "credit balance is too low" in lowered:
            raise RuntimeError(
                "Claude API key is loaded, but the Anthropic account has insufficient credits for the deployment pipeline."
            ) from exc
        raise RuntimeError(f"Claude request failed during {stage}: {message}") from exc
    _record_usage(
        workspace=workspace,
        model=model,
        stage=stage,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        response=response,
    )
    text_chunks: list[str] = []
    for block in response.content:
        block_text = getattr(block, "text", None)
        if isinstance(block_text, str) and block_text.strip():
            text_chunks.append(block_text)
    return _extract_json_object("\n".join(text_chunks))


def _is_text_file(path: Path) -> bool:
    suffix = path.suffix.lower()
    return suffix in TEXT_EXTENSIONS or path.name.lower() in IMPORTANT_NAMES or "." not in path.name


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")[:MAX_FILE_CHARS]
    except UnicodeDecodeError:
        return path.read_text(encoding="latin-1", errors="ignore")[:MAX_FILE_CHARS]


def _relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _list_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in root.rglob("*"):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.is_file():
            files.append(path)
    return sorted(files)


def _score_file(path: Path, root: Path) -> tuple[int, str]:
    rel = _relative(path, root)
    name = path.name.lower()
    score = 0
    if name in IMPORTANT_NAMES:
        score += 100
    if any(hint == name for hint in ENTRYPOINT_HINTS):
        score += 90
    if "readme" in name:
        score += 80
    if rel.count("/") == 0:
        score += 20
    if any(part in {"src", "app", "api", "server"} for part in path.parts):
        score += 10
    return score, rel


def _select_salient_files(root: Path, files: list[Path]) -> list[tuple[str, str]]:
    chosen: list[tuple[str, str]] = []
    total_chars = 0
    for path in sorted((path for path in files if _is_text_file(path)), key=lambda item: _score_file(item, root), reverse=True):
        rel = _relative(path, root)
        content = _read_text(path)
        if not content.strip():
            continue
        projected = total_chars + len(content)
        if len(chosen) >= MAX_FILES or projected > MAX_TOTAL_CHARS:
            continue
        chosen.append((rel, content))
        total_chars = projected
    return chosen


def _render_repository_tree(root: Path, files: list[Path]) -> str:
    rel_paths = [_relative(path, root) for path in files[:MAX_TREE_FILES]]
    return "\n".join(f"- {path}" for path in rel_paths)


def _repo_analysis_system_prompt() -> str:
    return (
        "You are a cost-conscious deployment repo analyzer. "
        "Infer how an application should be deployed to AWS from a partial repository snapshot. "
        "Return exactly one JSON object. "
        "Do not wrap in markdown. "
        "Only include these keys: language, frameworks, build, frontend, data_stores, processes, "
        "environment_variables, health, monitoring, infrastructure_hints, conflicts, low_confidence_items, readme_notes, summary. "
        "Be conservative. If uncertain, add low_confidence_items instead of inventing facts. "
        "Use compact but concrete values that fit the existing contract."
    )


def _review_question_system_prompt() -> str:
    return (
        "You generate a small review questionnaire before AWS deployment planning. "
        "Return exactly one JSON object with keys questions and defaults. "
        "Questions must be 2 to 5 items max, only for unresolved deployment decisions. "
        "Each question object must include id, category, question, required, default, options, affects. "
        "Each option must include value, label, description. "
        "Defaults should be practical, low-cost AWS defaults."
    )


def _deployment_profile_system_prompt() -> str:
    return (
        "You are an AWS infra planner. Convert repository context plus user answers into a single deployment_profile JSON object. "
        "Return exactly one JSON object and no prose. "
        "The top-level object must match this shape: "
        "{document_kind:'deployment_profile', workspace, project_name, provider:'aws', application_type, environment, "
        "compute:{strategy, services:[{id, process_type, cpu, memory, port, desired_count, command}]}, "
        "networking:{vpc, layout, nat_gateway, load_balancer, ports_exposed}, "
        "data_layer:[{id, type, engine_version, instance_class, multi_az, storage_gb, backup_retention_days, migrate_command, node_type, cluster_mode, purpose}], "
        "build_pipeline:{build_command, start_command, ecr_repository, ci_provider, provision_codepipeline}, "
        "runtime_config:{required_secrets, config_values, secrets_manager_prefix}, "
        "dns_and_tls:{domain, zone_id, acm_certificate, cloudfront}, "
        "operational:{health_check_path, health_check_interval, log_group, log_retention_days, enable_container_insights}, "
        "compliance:{requirements, encryption_at_rest, encryption_in_transit}, warnings:[...]}. "
        "Allowed compute.strategy values are ec2, ecs_fargate, s3_cloudfront. "
        "Prefer simple, cost-effective AWS deployments: ec2 for straightforward web apps, s3_cloudfront for static sites, ecs_fargate only when clearly needed."
    )


def _terraform_repo_context_system_prompt() -> str:
    return (
        "You are the repo-context worker in a Terraform generation pipeline. "
        "Your job is to infer deploy-relevant facts from analyzed repository context and an approved deployment profile. "
        "Return exactly one JSON object and no prose. "
        "Do not invent capabilities that are not supported by the supplied context. "
        "Be explicit about uncertainty by adding concise entries to risk_items instead of guessing. "
        "Required top-level keys: summary, application_shape, deployable_units, commands, frontend, health, env, data_dependencies, risk_items. "
        "deployable_units must be an array of objects with id, kind, port, command, reason. "
        "commands must include build_command, start_command, migrate_command. "
        "frontend must include static_candidate, framework, output_dir, entry_candidates, hosting_hint. "
        "health must include path, confidence, reason. "
        "env must include required_secrets and config_values. "
        "data_dependencies must summarize only the concrete data stores actually present or clearly implied by the approved profile. "
        "application_shape must be one of static_site, single_service_web, api_service, multi_service_web, worker_only. "
        "hosting_hint must be one of s3_cloudfront, ec2, ecs_fargate. "
        "Prefer low-cost, low-complexity deployment interpretations unless the supplied context clearly requires more."
    )


def _terraform_architecture_profile_system_prompt() -> str:
    return (
        "You are the architecture-to-profile worker in a Terraform generation pipeline. "
        "You receive an already approved deployment profile plus deployable repo context signals. "
        "Your task is to reconcile them into a final deployment_profile JSON document that remains faithful to the approved architecture while filling practical deployment gaps. "
        "Return exactly one JSON object and no prose. "
        "The output must satisfy this contract: "
        "{document_kind:'deployment_profile', workspace, project_name, provider:'aws', application_type, environment, "
        "compute:{strategy, services:[{id, process_type, cpu, memory, port, desired_count, command}]}, "
        "networking:{vpc, layout, nat_gateway, load_balancer, ports_exposed}, "
        "data_layer:[{id, type, engine_version, instance_class, multi_az, storage_gb, backup_retention_days, migrate_command, node_type, cluster_mode, purpose}], "
        "build_pipeline:{build_command, start_command, ecr_repository, ci_provider, provision_codepipeline}, "
        "runtime_config:{required_secrets, config_values, secrets_manager_prefix}, "
        "dns_and_tls:{domain, zone_id, acm_certificate, cloudfront}, "
        "operational:{health_check_path, health_check_interval, log_group, log_retention_days, enable_container_insights}, "
        "compliance:{requirements, encryption_at_rest, encryption_in_transit}, warnings:[...]}. "
        "Allowed compute.strategy values are ec2, ecs_fargate, s3_cloudfront. "
        "Respect the approved profile as the source of truth. Only refine missing or obviously inconsistent values. "
        "Prefer a single-service EC2 plan for ordinary web applications, s3_cloudfront for static sites, and ecs_fargate only when container orchestration is clearly justified. "
        "Use concise warnings for any unresolved tension between repo signals and approved architecture."
    )


def _terraform_structure_system_prompt() -> str:
    return (
        "You are the Terraform structure worker in a Terraform generation pipeline. "
        "You do not write HCL. You produce a precise rendering plan for a curated multi-file Terraform tree. "
        "Return exactly one JSON object and no prose. "
        "Required top-level keys: bundle_strategy, surface_files, terraform_directories, file_tree, module_inventory, file_ownership_map, symbol_requirements, cross_file_dependencies, resource_focus, ordering, rendering_hints, validation_focus, summary. "
        "bundle_strategy must be one of static_site_bundle, ec2_bundle, ecs_fargate_bundle. "
        "surface_files must be the user-visible file paths in the final bundle. "
        "file_tree must list every Terraform file path that should be generated. "
        "module_inventory must describe enabled module groups and their purpose. "
        "file_ownership_map must map worker group ids to the exact files they own. "
        "symbol_requirements must capture outputs, references, or module wiring expectations. "
        "cross_file_dependencies must capture ordering or reference dependencies between file groups. "
        "ordering must be the preferred presentation order for those files. "
        "resource_focus must be a concise list of AWS resource themes that must appear in the rendered Terraform. "
        "rendering_hints must be concise implementation notes for the file-generation workers. "
        "validation_focus must state what the validator should inspect after rendering. "
        "Assume the final Terraform must remain simple, explainable, and editable in the UI. "
        "Always use a module-based file tree for AWS."
    )


def _terraform_default_model_for_provider(provider: str) -> str:
    normalized = str(provider or "").strip().lower()
    if normalized == "groq":
        return FREE_TERRAFORM_DEFAULT_MODEL
    if normalized == "openrouter":
        return FREE_TERRAFORM_OPENROUTER_MODEL
    if normalized == "ollama":
        return FREE_TERRAFORM_OLLAMA_MODEL
    return FREE_TERRAFORM_DEFAULT_MODEL


def _terraform_base_url_for_provider(provider: str, explicit_base: str = "") -> str:
    normalized = str(provider or "").strip().lower()
    base = str(explicit_base or "").strip().rstrip("/")
    if base:
        return base
    if normalized == "groq":
        return os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1").strip().rstrip("/")
    if normalized == "openrouter":
        return os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").strip().rstrip("/")
    if normalized == "ollama":
        return os.getenv("OLLAMA_BASE_URL", "https://api.ollama.com/v1").strip().rstrip("/")
    return ""


def _terraform_api_key_for_provider(provider: str, explicit_key: str = "") -> str:
    normalized = str(provider or "").strip().lower()
    if explicit_key:
        return explicit_key
    if normalized == "groq":
        return os.getenv("GROQ_API_KEY", "").strip()
    if normalized == "openrouter":
        return os.getenv("OPENROUTER_API_KEY", "").strip()
    if normalized == "ollama":
        return os.getenv("OLLAMA_API_KEY", "").strip()
    return ""


def _terraform_provider_available(config: dict[str, str]) -> bool:
    provider = str(config.get("provider") or "").strip().lower()
    if provider == "ollama":
        return bool(str(config.get("base_url") or "").strip())
    return bool(str(config.get("api_key") or "").strip())


def _terraform_provider_config(
    provider: str,
    *,
    explicit_key: str = "",
    explicit_model: str = "",
    explicit_base: str = "",
) -> dict[str, str]:
    normalized = str(provider or "").strip().lower()
    return {
        "provider": normalized,
        "api_key": _terraform_api_key_for_provider(normalized, explicit_key),
        "model": explicit_model or _terraform_default_model_for_provider(normalized),
        "base_url": _terraform_base_url_for_provider(normalized, explicit_base),
    }


def _preferred_terraform_provider_order(explicit_provider: str = "") -> list[str]:
    preferred: list[str] = []
    explicit = str(explicit_provider or "").strip().lower()
    env_backend = str(os.getenv("AGENT_LLM_BACKEND", "") or "").strip().lower()
    for candidate in (explicit, env_backend, FREE_TERRAFORM_DEFAULT_PROVIDER, "openrouter", "ollama"):
        if candidate in TERRAFORM_LLM_PROVIDERS and candidate not in preferred:
            preferred.append(candidate)
    for candidate in TERRAFORM_LLM_PROVIDERS:
        if candidate not in preferred:
            preferred.append(candidate)
    return preferred


def _preferred_provider_for_stage(stage: str, worker_id: str = "") -> str:
    normalized_stage = str(stage or "").strip().lower()
    normalized_worker = str(worker_id or "").strip().lower()
    if normalized_stage == "terraform_repo_context":
        return "groq"
    if normalized_stage == "terraform_architecture_profile":
        return "openrouter"
    if normalized_stage == "terraform_structure":
        return "ollama"
    if normalized_stage == "terraform_validation":
        return "openrouter"
    if normalized_stage == "terraform_file_generation":
        cycle = ("groq", "openrouter", "ollama")
        checksum = sum(ord(char) for char in normalized_worker) if normalized_worker else 0
        return cycle[checksum % len(cycle)]
    return str(os.getenv("AGENT_LLM_BACKEND", "") or "").strip().lower() or FREE_TERRAFORM_DEFAULT_PROVIDER


def _ordered_terraform_candidates_for_worker(
    llm_config: dict[str, str],
    *,
    stage: str,
    worker_id: str,
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = [dict(llm_config)]
    fallbacks = llm_config.get("fallbacks")
    if isinstance(fallbacks, list):
        candidates.extend(dict(item) for item in fallbacks if isinstance(item, dict))
    if not candidates:
        return []
    preferred_provider = _preferred_provider_for_stage(stage, worker_id)
    preferred: list[dict[str, Any]] = []
    remainder: list[dict[str, Any]] = []
    for candidate in candidates:
        if str(candidate.get("provider") or "").strip().lower() == preferred_provider:
            preferred.append(candidate)
        else:
            remainder.append(candidate)
    ordered = preferred + remainder
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for candidate in ordered:
        provider = str(candidate.get("provider") or "").strip().lower()
        if not provider or provider in seen:
            continue
        seen.add(provider)
        deduped.append(candidate)
    return deduped


def _terraform_file_generation_system_prompt() -> str:
    return (
        "You are a Terraform file-generation worker in an AWS IaC pipeline. "
        "You own one file group only and must generate the exact files assigned to your group. "
        "Return exactly one JSON object and no prose. "
        "Required top-level keys: group_id, files, unresolved_dependencies, summary. "
        "files must be an array of objects with keys path, role, content, references, exports. "
        "Every file listed in files must belong to the current worker's assigned file list. "
        "content must be valid Terraform HCL or Markdown when the path is README.md. "
        "Do not invent file paths. Do not emit placeholders like TODO, your-value-here, or example.com unless the approved profile explicitly contains them. "
        "Prefer concise, editable Terraform that matches the approved deployment profile and repo context."
    )


def _terraform_validation_system_prompt() -> str:
    return (
        "You are the validation-remediation worker in a Terraform generation pipeline. "
        "You review a rendered Terraform bundle against the approved deployment profile and the structure plan. "
        "Return exactly one JSON object and no prose. "
        "Required top-level keys: approved, warnings, missing_files, ordering_confirmed, remediation_actions, unresolved_references, duplicate_resource_names, resource_profile_mismatches, summary. "
        "approved must be a boolean. "
        "warnings must contain only concrete risks, mismatches, or editability concerns. "
        "missing_files must list required surfaced paths that are absent. "
        "ordering_confirmed must be the final display order that the UI should show. "
        "remediation_actions must be short, actionable items. "
        "unresolved_references must list unresolved module/resource symbol issues. "
        "duplicate_resource_names must list concrete duplicate Terraform addresses or names. "
        "resource_profile_mismatches must list concrete differences between the rendered bundle and the approved profile. "
        "Approve only when the rendered bundle aligns with the requested AWS strategy, includes the expected surfaced Terraform files, and looks editable by an operator."
    )


def _resolve_terraform_llm_config(
    *,
    llm_provider: str | None,
    llm_api_key: str | None,
    llm_model: str | None,
    llm_api_base_url: str | None,
) -> dict[str, str] | None:
    explicit_provider = str(llm_provider or "").strip().lower()
    explicit_key = str(llm_api_key or "").strip()
    explicit_model = str(llm_model or "").strip()
    explicit_base = str(llm_api_base_url or "").strip().rstrip("/")
    candidates: list[dict[str, str]] = []
    for provider in _preferred_terraform_provider_order(explicit_provider):
        if explicit_provider and provider != explicit_provider and explicit_key:
            continue
        candidate = _terraform_provider_config(
            provider,
            explicit_key=explicit_key if provider == explicit_provider else "",
            explicit_model=explicit_model if provider == explicit_provider else "",
            explicit_base=explicit_base if provider == explicit_provider else "",
        )
        if not _terraform_provider_available(candidate):
            continue
        candidates.append(candidate)
    if not candidates:
        return None
    primary = dict(candidates[0])
    primary["fallbacks"] = [dict(item) for item in candidates[1:]]
    return primary


def _terraform_llm_available(config: dict[str, str] | None) -> bool:
    if not isinstance(config, dict):
        return False
    if _terraform_provider_available(config):
        return True
    fallbacks = config.get("fallbacks")
    if isinstance(fallbacks, list):
        return any(_terraform_provider_available(item) for item in fallbacks if isinstance(item, dict))
    return False


def _call_terraform_free_llm_json(
    *,
    system_prompt: str,
    user_prompt: str,
    config: dict[str, str],
    max_tokens: int = 2400,
) -> dict[str, Any]:
    provider = str(config.get("provider") or "").strip().lower()
    model = str(config.get("model") or "").strip()
    base_url = str(config.get("base_url") or "").strip().rstrip("/")
    api_key = str(config.get("api_key") or "").strip()

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    if provider == "ollama":
        endpoint = f"{base_url}/chat/completions"
        payload = {
            "model": model or FREE_TERRAFORM_OLLAMA_MODEL,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
        }
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
    else:
        endpoint = f"{base_url}/chat/completions"
        payload = {
            "model": model,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }
        if provider == "openrouter":
            headers["HTTP-Referer"] = os.getenv("NEXT_PUBLIC_APP_URL", "http://localhost:3000")
            headers["X-Title"] = os.getenv("OPENROUTER_APP_NAME", "deplai-agentic")

    req = urlrequest.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urlrequest.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urlerror.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{provider} worker call failed with HTTP {exc.code}: {raw}") from exc
    except Exception as exc:
        raise RuntimeError(f"{provider} worker call failed: {exc}") from exc

    content = ""
    if provider == "ollama":
        content = str((((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "")).strip()
    else:
        content = str((((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "")).strip()
    return _extract_json_object(content)


def _worker_event(
    *,
    msg_type: str,
    content: str,
    worker_id: str,
    worker_role: str,
    worker_status: str,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": msg_type,
        "content": content,
        "worker_id": worker_id,
        "worker_role": worker_role,
        "worker_status": worker_status,
        "stage": "terraform_generation",
    }
    if isinstance(extra, dict):
        for key, value in extra.items():
            if value is not None:
                payload[key] = value
    return payload


def _emit_worker(
    progress_callback: Callable[[dict[str, Any]], None] | None,
    *,
    msg_type: str,
    content: str,
    worker_id: str,
    worker_role: str,
    worker_status: str,
    extra: dict[str, Any] | None = None,
) -> None:
    if not progress_callback:
        return
    progress_callback(
        _worker_event(
            msg_type=msg_type,
            content=content,
            worker_id=worker_id,
            worker_role=worker_role,
            worker_status=worker_status,
            extra=extra,
        )
    )


def _render_json_excerpt(payload: Any, limit: int = 12000) -> str:
    raw = json.dumps(payload, indent=2, ensure_ascii=True)
    if len(raw) <= limit:
        return raw
    return f"{raw[:limit]}\n... [truncated]"


def _fallback_repo_context_document(
    *,
    project_name: str,
    repository_context_json: dict[str, Any] | None,
    architecture_json: dict[str, Any],
    qa_summary: str,
) -> dict[str, Any]:
    repo = repository_context_json if isinstance(repository_context_json, dict) else {}
    frontend = repo.get("frontend") if isinstance(repo.get("frontend"), dict) else {}
    build = repo.get("build") if isinstance(repo.get("build"), dict) else {}
    env = repo.get("environment_variables") if isinstance(repo.get("environment_variables"), dict) else {}
    health = repo.get("health") if isinstance(repo.get("health"), dict) else {}
    processes = repo.get("processes") if isinstance(repo.get("processes"), list) else []
    data_stores = repo.get("data_stores") if isinstance(repo.get("data_stores"), list) else []
    compute = architecture_json.get("compute") if isinstance(architecture_json.get("compute"), dict) else {}
    services = compute.get("services") if isinstance(compute.get("services"), list) else []
    strategy = str(compute.get("strategy") or "").strip().lower()
    static_candidate = bool(frontend.get("static_site_candidate")) or strategy == "s3_cloudfront"
    app_shape = "static_site" if static_candidate else ("multi_service_web" if len(services) > 1 else "single_service_web")
    deployable_units = []
    for index, service in enumerate(services or [], start=1):
        service_dict = service if isinstance(service, dict) else {}
        deployable_units.append(
            {
                "id": str(service_dict.get("id") or f"service-{index}"),
                "kind": "frontend" if static_candidate else "web",
                "port": service_dict.get("port"),
                "command": service_dict.get("command") or build.get("start_command"),
                "reason": "Derived from approved deployment profile service definition.",
            }
        )
    if not deployable_units and static_candidate:
        deployable_units.append(
            {
                "id": "static-site",
                "kind": "frontend",
                "port": None,
                "command": build.get("build_command"),
                "reason": "Frontend analysis and compute strategy indicate static hosting.",
            }
        )
    return {
        "summary": str(repo.get("summary") or qa_summary or f"Derived deployable context for {project_name}.").strip(),
        "application_shape": app_shape,
        "deployable_units": deployable_units,
        "commands": {
            "build_command": build.get("build_command"),
            "start_command": build.get("start_command"),
            "migrate_command": build.get("migrate_command"),
        },
        "frontend": {
            "static_candidate": static_candidate,
            "framework": frontend.get("framework"),
            "output_dir": frontend.get("output_dir"),
            "entry_candidates": frontend.get("entry_candidates") if isinstance(frontend.get("entry_candidates"), list) else [],
            "hosting_hint": "s3_cloudfront" if static_candidate else ("ecs_fargate" if strategy == "ecs_fargate" else "ec2"),
        },
        "health": {
            "path": health.get("endpoint"),
            "confidence": health.get("confidence") or "low",
            "reason": "Lifted from repository analysis health metadata.",
        },
        "env": {
            "required_secrets": env.get("required_secrets") if isinstance(env.get("required_secrets"), list) else [],
            "config_values": env.get("config_values") if isinstance(env.get("config_values"), list) else [],
        },
        "data_dependencies": data_stores,
        "risk_items": [
            "Repository-context worker used deterministic fallback because no free Terraform worker LLM was available."
        ],
        "processes": processes,
    }


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    seen: set[str] = set()
    items: list[str] = []
    for item in value:
        text = str(item or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        items.append(text)
    return items


def _module_paths(module_name: str) -> list[str]:
    return [
        f"terraform/modules/{module_name}/main.tf",
        f"terraform/modules/{module_name}/variables.tf",
        f"terraform/modules/{module_name}/outputs.tf",
    ]


def _compute_strategy(profile_payload: dict[str, Any]) -> str:
    compute = profile_payload.get("compute") if isinstance(profile_payload.get("compute"), dict) else {}
    return str(compute.get("strategy") or "ec2").strip().lower() or "ec2"


def _fallback_structure_plan(profile_payload: dict[str, Any]) -> dict[str, Any]:
    strategy = _compute_strategy(profile_payload)
    bundle_strategy = "static_site_bundle" if strategy == "s3_cloudfront" else ("ecs_fargate_bundle" if strategy == "ecs_fargate" else "ec2_bundle")
    root_files = [
        "README.md",
        "terraform/versions.tf",
        "terraform/providers.tf",
        "terraform/backend.tf",
        "terraform/variables.tf",
        "terraform/locals.tf",
        "terraform/main.tf",
        "terraform/outputs.tf",
        "terraform/terraform.tfvars",
    ]
    module_names = ["networking", "iam", "compute", "data"] if strategy != "s3_cloudfront" else ["storage"]
    file_tree = list(root_files)
    terraform_directories = ["terraform", *[f"terraform/modules/{module_name}" for module_name in module_names]]
    file_ownership_map: dict[str, list[str]] = {"root": list(root_files)}
    module_inventory: list[dict[str, Any]] = []
    for module_name in module_names:
        paths = _module_paths(module_name)
        file_tree.extend(paths)
        file_ownership_map[module_name] = paths
        module_inventory.append(
            {
                "id": module_name,
                "enabled": True,
                "files": paths,
                "purpose": (
                    "Static site hosting and CDN"
                    if module_name == "storage"
                    else "AWS networking resources"
                    if module_name == "networking"
                    else "IAM identities and policies"
                    if module_name == "iam"
                    else "Application runtime resources"
                    if module_name == "compute"
                    else "Managed data services"
                ),
            }
        )
    resource_focus = ["provider_constraints", "outputs"]
    symbol_requirements: list[dict[str, Any]] = [
        {"consumer": "terraform/main.tf", "requires": ["project_name", "aws_region", "environment"]},
    ]
    cross_file_dependencies: list[dict[str, Any]] = []
    if strategy == "s3_cloudfront":
        resource_focus.extend(["s3", "cloudfront"])
        symbol_requirements.append({"consumer": "terraform/main.tf", "requires": ["module.storage.website_url"]})
        cross_file_dependencies.append({"from": "root", "to": "storage", "reason": "root module wires storage outputs to root outputs"})
    else:
        resource_focus.extend(["networking", "runtime", "security"])
        if strategy == "ecs_fargate":
            resource_focus.extend(["ecs", "alb", "ecr", "logs"])
        else:
            resource_focus.extend(["ec2", "security_group"])
        if any(item.get("type") == "postgresql" for item in profile_payload.get("data_layer") or [] if isinstance(item, dict)):
            resource_focus.append("rds")
        if any(item.get("type") == "redis" for item in profile_payload.get("data_layer") or [] if isinstance(item, dict)):
            resource_focus.append("elasticache")
        symbol_requirements.extend(
            [
                {"consumer": "terraform/main.tf", "requires": ["module.networking.vpc_id", "module.networking.private_subnet_ids"]},
                {"consumer": "terraform/main.tf", "requires": ["module.iam.compute_role_arn"]},
                {"consumer": "terraform/main.tf", "requires": ["module.compute.service_endpoint", "module.compute.log_group_name"]},
                {"consumer": "terraform/main.tf", "requires": ["module.data.postgres_endpoint", "module.data.redis_endpoint"]},
            ]
        )
        cross_file_dependencies.extend(
            [
                {"from": "root", "to": "networking", "reason": "root wires networking outputs into compute and data modules"},
                {"from": "root", "to": "iam", "reason": "root wires IAM outputs into compute module"},
                {"from": "root", "to": "compute", "reason": "root surfaces compute outputs"},
                {"from": "root", "to": "data", "reason": "root surfaces data outputs"},
                {"from": "compute", "to": "networking", "reason": "compute resources run in generated subnets and security groups"},
                {"from": "data", "to": "networking", "reason": "data services require subnet groups and security groups"},
            ]
        )
    return {
        "bundle_strategy": bundle_strategy,
        "surface_files": file_tree,
        "terraform_directories": terraform_directories,
        "file_tree": file_tree,
        "module_inventory": module_inventory,
        "file_groups": [
            {
                "id": group_id,
                "owned_files": owned_files,
                "dependencies": [dep["to"] for dep in cross_file_dependencies if dep["from"] == group_id],
                "purpose": next((module["purpose"] for module in module_inventory if module["id"] == group_id), "Root module wiring and operator-facing files"),
            }
            for group_id, owned_files in file_ownership_map.items()
        ],
        "file_ownership_map": file_ownership_map,
        "symbol_requirements": symbol_requirements,
        "cross_file_dependencies": cross_file_dependencies,
        "resource_focus": resource_focus,
        "ordering": file_tree,
        "rendering_hints": [
            f"Render a curated module-based {strategy or 'ec2'} bundle instead of a flat Terraform bundle.",
            "Keep all operator-visible Terraform files explicit in the surfaced output.",
            "Prefer concise, editable Terraform with clear module interfaces.",
        ],
        "validation_focus": [
            "Required surfaced Terraform files are present.",
            "Module wiring aligns with the selected compute strategy.",
            "Cross-file references are resolved and resource names are unique.",
        ],
        "summary": f"Deterministic curated structure plan for {bundle_strategy}.",
    }


def _coerce_structure_plan(raw_plan: dict[str, Any] | None, profile_payload: dict[str, Any]) -> dict[str, Any]:
    fallback = _fallback_structure_plan(profile_payload)
    if not isinstance(raw_plan, dict):
        return fallback
    merged = dict(fallback)
    for key in (
        "bundle_strategy",
        "summary",
    ):
        value = str(raw_plan.get(key) or "").strip()
        if value:
            merged[key] = value
    for key in ("surface_files", "terraform_directories", "file_tree", "ordering", "rendering_hints", "validation_focus", "resource_focus"):
        values = _string_list(raw_plan.get(key))
        if values:
            merged[key] = values
    if isinstance(raw_plan.get("module_inventory"), list) and raw_plan["module_inventory"]:
        merged["module_inventory"] = raw_plan["module_inventory"]
    if isinstance(raw_plan.get("file_ownership_map"), dict) and raw_plan["file_ownership_map"]:
        merged["file_ownership_map"] = {
            str(group_id): _string_list(paths)
            for group_id, paths in dict(raw_plan["file_ownership_map"]).items()
            if _string_list(paths)
        }
    if isinstance(raw_plan.get("symbol_requirements"), list) and raw_plan["symbol_requirements"]:
        merged["symbol_requirements"] = raw_plan["symbol_requirements"]
    if isinstance(raw_plan.get("cross_file_dependencies"), list) and raw_plan["cross_file_dependencies"]:
        merged["cross_file_dependencies"] = raw_plan["cross_file_dependencies"]

    ownership = merged.get("file_ownership_map") if isinstance(merged.get("file_ownership_map"), dict) else {}
    fallback_groups = {str(group["id"]): group for group in fallback.get("file_groups") or [] if isinstance(group, dict)}
    merged_groups: list[dict[str, Any]] = []
    for group_id, owned_files in ownership.items():
        fallback_group = fallback_groups.get(str(group_id), {})
        merged_groups.append(
            {
                "id": str(group_id),
                "owned_files": _string_list(owned_files) or list(fallback_group.get("owned_files") or []),
                "dependencies": _string_list((raw_plan.get("group_dependencies") or {}).get(group_id) if isinstance(raw_plan.get("group_dependencies"), dict) else fallback_group.get("dependencies")),
                "purpose": str(
                    ((raw_plan.get("group_purposes") or {}).get(group_id) if isinstance(raw_plan.get("group_purposes"), dict) else "")
                    or fallback_group.get("purpose")
                    or "Terraform file group"
                ).strip(),
            }
        )
    merged["file_groups"] = merged_groups or fallback["file_groups"]
    if not merged.get("file_tree"):
        merged["file_tree"] = fallback["file_tree"]
    if not merged.get("surface_files"):
        merged["surface_files"] = merged["file_tree"]
    if not merged.get("ordering"):
        merged["ordering"] = merged["surface_files"]
    return merged


def _fallback_validation_report(*, ordered_paths: list[str], structure_plan: dict[str, Any], assembly_report: dict[str, Any] | None = None) -> dict[str, Any]:
    expected = [str(item) for item in list(structure_plan.get("surface_files") or []) if str(item).strip()]
    missing = [path for path in expected if path not in ordered_paths]
    confirmed = [path for path in expected if path in ordered_paths]
    if not confirmed:
        confirmed = list(ordered_paths)
    assembly = assembly_report if isinstance(assembly_report, dict) else {}
    return {
        "approved": len(missing) == 0 and not _string_list(assembly.get("unresolved_references")) and not _string_list(assembly.get("duplicate_paths")),
        "warnings": ["Validation worker used deterministic fallback because no free Terraform worker LLM was available."],
        "missing_files": missing,
        "ordering_confirmed": confirmed,
        "remediation_actions": ["Add the missing surfaced Terraform files before runtime apply."] if missing else [],
        "unresolved_references": _string_list(assembly.get("unresolved_references")),
        "duplicate_resource_names": _string_list(assembly.get("duplicate_paths")),
        "resource_profile_mismatches": _string_list(assembly.get("profile_mismatches")),
        "summary": "Validated rendered Terraform bundle with deterministic checks.",
    }


def _sort_surface_files(files: list[dict[str, Any]], preferred_order: list[str]) -> list[dict[str, Any]]:
    position = {path: index for index, path in enumerate(preferred_order)}
    return sorted(files, key=lambda item: (position.get(str(item.get("path") or ""), len(position) + 1), str(item.get("path") or "")))


def _normalize_generated_group(raw_result: dict[str, Any], group_plan: dict[str, Any]) -> dict[str, Any]:
    allowed_paths = set(_string_list(group_plan.get("owned_files")))
    files: list[dict[str, Any]] = []
    for item in list(raw_result.get("files") or []):
        if not isinstance(item, dict):
            continue
        path = str(item.get("path") or "").strip()
        if not path or path not in allowed_paths:
            continue
        content = str(item.get("content") or "")
        if not content.strip():
            continue
        files.append(
            {
                "path": path,
                "role": str(item.get("role") or "").strip(),
                "content": content,
                "references": _string_list(item.get("references")),
                "exports": _string_list(item.get("exports")),
            }
        )
    return {
        "group_id": str(raw_result.get("group_id") or group_plan.get("id") or "").strip() or str(group_plan.get("id") or ""),
        "files": files,
        "unresolved_dependencies": _string_list(raw_result.get("unresolved_dependencies")),
        "summary": str(raw_result.get("summary") or "").strip(),
        "missing_owned_files": [path for path in allowed_paths if path not in {file["path"] for file in files}],
    }


def _assemble_generated_files(
    *,
    generated_groups: list[dict[str, Any]],
    structure_plan: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    file_index: dict[str, dict[str, Any]] = {}
    duplicate_paths: list[str] = []
    unresolved_references: list[str] = []
    generated_file_count = 0
    fallback_file_count = 0
    for group in generated_groups:
        if not isinstance(group, dict):
            continue
        used_fallback = bool(group.get("used_fallback"))
        for item in list(group.get("files") or []):
            if not isinstance(item, dict):
                continue
            path = str(item.get("path") or "").strip()
            if not path:
                continue
            if path in file_index:
                duplicate_paths.append(path)
                continue
            content = str(item.get("content") or "")
            file_index[path] = {"path": path, "content": content}
            generated_file_count += 1
            if used_fallback:
                fallback_file_count += 1
        for entry in _string_list(group.get("unresolved_dependencies")):
            unresolved_references.append(f"{group.get('group_id')}: {entry}")
        for path in _string_list(group.get("missing_owned_files")):
            unresolved_references.append(f"{group.get('group_id')}: missing generated file {path}")
    preferred_order = _string_list(structure_plan.get("ordering"))
    ordered_files = _sort_surface_files(list(file_index.values()), preferred_order)
    ordered_paths = [str(item.get("path") or "") for item in ordered_files]
    expected_paths = _string_list(structure_plan.get("surface_files"))
    missing_files = [path for path in expected_paths if path not in ordered_paths]
    return ordered_files, {
        "ordered_paths": ordered_paths,
        "missing_files": missing_files,
        "unresolved_references": unresolved_references,
        "duplicate_paths": duplicate_paths,
        "profile_mismatches": [],
        "generated_file_count": generated_file_count,
        "fallback_file_count": fallback_file_count,
    }


def _run_terraform_json_worker(
    *,
    workspace: str,
    stage: str,
    model: str,
    llm_config: dict[str, str],
    system_prompt: str,
    prompt_payload: dict[str, Any],
    worker_id: str,
    worker_role: str,
    progress_callback: Callable[[dict[str, Any]], None] | None,
    max_tokens: int,
) -> dict[str, Any]:
    def _retryable_provider_failure(exc: Exception) -> bool:
        message = str(exc).lower()
        return any(token in message for token in ("http 401", "http 403", "http 429", "rate limit", "credit balance is too low"))

    _emit_worker(
        progress_callback,
        msg_type="info",
        content=f"{worker_role} started.",
        worker_id=worker_id,
        worker_role=worker_role,
        worker_status="started",
        extra={"model": model},
    )
    try:
        prompt_text = _render_json_excerpt(prompt_payload)
        _guard_budget(
            workspace=workspace,
            model=model,
            system_prompt=system_prompt,
            user_prompt=prompt_text,
            max_tokens=max_tokens,
            stage=stage,
        )
        candidates = _ordered_terraform_candidates_for_worker(
            llm_config,
            stage=stage,
            worker_id=worker_id,
        )
        attempt_errors: list[str] = []
        result: dict[str, Any] | None = None
        active_model = model
        active_provider = str(llm_config.get("provider") or "").strip().lower()
        for index, candidate in enumerate(candidates):
            candidate_model = str(candidate.get("model") or model or "").strip() or model
            candidate_provider = str(candidate.get("provider") or "").strip().lower()
            try:
                result = _call_terraform_free_llm_json(
                    system_prompt=system_prompt,
                    user_prompt=prompt_text,
                    config=candidate,
                    max_tokens=max_tokens,
                )
                active_model = candidate_model
                active_provider = candidate_provider
                if index > 0:
                    _emit_worker(
                        progress_callback,
                        msg_type="info",
                        content=f"{worker_role} recovered on fallback provider '{candidate.get('provider')}'.",
                        worker_id=worker_id,
                        worker_role=worker_role,
                        worker_status="running",
                        extra={"model": candidate_model, "provider": str(candidate.get('provider') or "")},
                    )
                elif candidate_provider:
                    _emit_worker(
                        progress_callback,
                        msg_type="info",
                        content=f"{worker_role} is using provider '{candidate_provider}'.",
                        worker_id=worker_id,
                        worker_role=worker_role,
                        worker_status="running",
                        extra={"model": candidate_model, "provider": candidate_provider},
                    )
                break
            except Exception as exc:
                attempt_errors.append(str(exc))
                has_next = index < len(candidates) - 1
                if has_next and _retryable_provider_failure(exc):
                    next_provider = str(candidates[index + 1].get("provider") or "").strip()
                    next_model = str(candidates[index + 1].get("model") or "").strip()
                    _emit_worker(
                        progress_callback,
                        msg_type="info",
                        content=f"{worker_role} switching provider after failure: {exc}",
                        worker_id=worker_id,
                        worker_role=worker_role,
                        worker_status="running",
                        extra={"model": next_model or candidate_model, "provider": next_provider},
                    )
                    continue
                raise RuntimeError(" | ".join(attempt_errors)) from exc
        if result is None:
            raise RuntimeError(" | ".join(attempt_errors) or "Terraform worker failed without a result.")
        _emit_worker(
            progress_callback,
            msg_type="success",
            content=f"{worker_role} completed.",
            worker_id=worker_id,
            worker_role=worker_role,
            worker_status="completed",
            extra={"model": active_model, "provider": active_provider},
        )
        return result
    except Exception as exc:
        _emit_worker(
            progress_callback,
            msg_type="info",
            content=f"{worker_role} could not complete with the configured LLM provider(s); deterministic fallback will be used: {exc}",
            worker_id=worker_id,
            worker_role=worker_role,
            worker_status="running",
            extra={"model": model, "provider": str(llm_config.get("provider") or "").strip().lower()},
        )
        raise


def _default_review_payload(context: RepositoryContextDocument, environment: str | None = None) -> ArchitectureReviewPayload:
    env_default = (environment or "dev").strip() or "dev"
    defaults = {
        "q_environment": env_default,
        "q_compute": "ec2",
        "q_database": "none",
        "q_cache": "none",
        "q_ci": "use_existing_ci",
    }
    questions = [
        ArchitectureQuestion(
            id="q_environment",
            category="deployment",
            question="Which environment should this deployment target?",
            required=True,
            default=env_default,
            affects=["environment"],
            options=[
                QuestionOption(value="dev", label="Development", description="Cheapest baseline deployment."),
                QuestionOption(value="staging", label="Staging", description="Closer to production but still cost-aware."),
                QuestionOption(value="production", label="Production", description="Higher availability defaults."),
            ],
        ),
        ArchitectureQuestion(
            id="q_compute",
            category="compute",
            question="Which compute strategy fits this repository best?",
            required=True,
            default="ec2",
            affects=["compute.strategy"],
            options=[
                QuestionOption(value="ec2", label="EC2", description="Simple single-service deployment."),
                QuestionOption(value="ecs_fargate", label="ECS Fargate", description="Container-oriented managed runtime."),
                QuestionOption(value="s3_cloudfront", label="S3 + CloudFront", description="Static frontend hosting."),
            ],
        ),
    ]
    return ArchitectureReviewPayload(
        context_json=context,
        questions=questions,
        defaults=defaults,
        conflicts=context.conflicts,
        low_confidence_items=context.low_confidence_items,
    )


def _context_markdown(context: RepositoryContextDocument) -> str:
    frameworks = ", ".join(sorted({item.name for item in context.frameworks})) or "unknown"
    data_stores = ", ".join(item.type for item in context.data_stores) or "none detected"
    processes = ", ".join(item.type for item in context.processes) or "none detected"
    return (
        f"# Repository Context\n\n"
        f"- Project: {context.project_name}\n"
        f"- Root: {context.project_root}\n"
        f"- Runtime: {context.language.runtime or 'unknown'}\n"
        f"- Frameworks: {frameworks}\n"
        f"- Data stores: {data_stores}\n"
        f"- Processes: {processes}\n"
        f"- Summary: {context.summary or 'No summary provided.'}\n"
    )


def run_repository_analysis(
    *,
    project_id: str,
    project_name: str,
    project_type: str,
    workspace: str,
    user_id: str | None = None,
    repo_full_name: str | None = None,
) -> tuple[RepositoryContextDocument, str, dict[str, str]]:
    root = resolve_repository_source(
        project_id=project_id,
        project_type=project_type,
        user_id=user_id,
        repo_full_name=repo_full_name,
    )
    files = _list_files(root)
    salient_files = _select_salient_files(root, files)
    prompt_payload = {
        "project_name": project_name,
        "project_type": project_type,
        "workspace": workspace,
        "repository_root": str(root),
        "file_tree": _render_repository_tree(root, files),
        "salient_files": [{"path": path, "content": content} for path, content in salient_files],
    }
    llm_output = _call_claude_json(
        workspace=workspace,
        stage="repository_analysis",
        model=REPO_ANALYZER_MODEL,
        system_prompt=_repo_analysis_system_prompt(),
        user_prompt=json.dumps(prompt_payload, indent=2),
        max_tokens=3000,
    )
    context = RepositoryContextDocument.model_validate(
        {
            "project_root": str(root),
            "workspace": workspace,
            "project_name": project_name,
            "project_type": project_type,
            **llm_output,
        }
    )
    context_md = _context_markdown(context)
    write_json(analyzer_context_path(workspace), context.model_dump(exclude_none=True))
    analyzer_context_md_path(workspace).write_text(context_md, encoding="utf-8")
    return context, context_md, runtime_paths_for_workspace(workspace)


def start_architecture_review(
    *,
    project_id: str,
    project_name: str,
    project_type: str,
    workspace: str,
    user_id: str | None = None,
    repo_full_name: str | None = None,
    environment: str | None = None,
) -> ArchitectureReviewPayload:
    cached_review_path = decision_review_payload_path(workspace)
    if cached_review_path.exists():
        return ArchitectureReviewPayload.model_validate(read_json(cached_review_path))

    cached_context_path = analyzer_context_path(workspace)
    if cached_context_path.exists():
        context = RepositoryContextDocument.model_validate(read_json(cached_context_path))
    else:
        context, _, _ = run_repository_analysis(
            project_id=project_id,
            project_name=project_name,
            project_type=project_type,
            workspace=workspace,
            user_id=user_id,
            repo_full_name=repo_full_name,
        )
    payload = {
        "context_json": context.model_dump(exclude_none=True),
        "requested_environment": environment or None,
    }
    try:
        llm_output = _call_claude_json(
            workspace=workspace,
            stage="review_questions",
            model=REVIEW_QUESTION_MODEL,
            system_prompt=_review_question_system_prompt(),
            user_prompt=json.dumps(payload, indent=2),
            max_tokens=1800,
        )
        questions = [ArchitectureQuestion.model_validate(item) for item in list(llm_output.get("questions") or [])[:5]]
        defaults = {str(k): str(v) for k, v in dict(llm_output.get("defaults") or {}).items() if str(k).strip()}
        if not questions:
            review_payload = _default_review_payload(context, environment)
        else:
            review_payload = ArchitectureReviewPayload(
                context_json=context,
                questions=questions,
                defaults=defaults,
                conflicts=context.conflicts,
                low_confidence_items=context.low_confidence_items,
            )
        write_json(cached_review_path, review_payload.model_dump(exclude_none=True))
        return review_payload
    except Exception:
        review_payload = _default_review_payload(context, environment)
        write_json(cached_review_path, review_payload.model_dump(exclude_none=True))
        return review_payload


def complete_architecture_review(
    *,
    project_id: str,
    project_name: str,
    project_type: str,
    workspace: str,
    answers: dict[str, str],
    user_id: str | None = None,
    repo_full_name: str | None = None,
) -> tuple[ArchitectureAnswersDocument, DeploymentProfileDocument, Any, dict[str, Any], dict[str, str]]:
    cached_review_path = decision_review_payload_path(workspace)
    if cached_review_path.exists():
        review = ArchitectureReviewPayload.model_validate(read_json(cached_review_path))
    else:
        review = start_architecture_review(
            project_id=project_id,
            project_name=project_name,
            project_type=project_type,
            workspace=workspace,
            user_id=user_id,
            repo_full_name=repo_full_name,
        )
    resolved_answers = dict(review.defaults)
    for key, value in (answers or {}).items():
        if value is not None and str(value).strip():
            resolved_answers[str(key)] = str(value).strip()
    answers_doc = ArchitectureAnswersDocument(workspace=workspace, answers=resolved_answers)

    llm_input = {
        "context_json": review.context_json.model_dump(exclude_none=True),
        "review_defaults": review.defaults,
        "resolved_answers": resolved_answers,
        "project_name": project_name,
        "workspace": workspace,
    }
    profile_payload = _call_claude_json(
        workspace=workspace,
        stage="deployment_profile",
        model=INFRA_PLANNER_MODEL,
        system_prompt=_deployment_profile_system_prompt(),
        user_prompt=json.dumps(llm_input, indent=2),
        max_tokens=3200,
    )
    if "workspace" not in profile_payload:
        profile_payload["workspace"] = workspace
    if "project_name" not in profile_payload:
        profile_payload["project_name"] = project_name
    if "document_kind" not in profile_payload:
        profile_payload["document_kind"] = "deployment_profile"
    if "provider" not in profile_payload:
        profile_payload["provider"] = "aws"

    profile = parse_deployment_profile(profile_payload)
    architecture_view = _profile_to_architecture_view(profile)
    infra_plan = _profile_to_infra_plan(profile)
    approval_payload = run_stage7_approval_payload(
        infra_plan=infra_plan,
        budget_cap_usd=100.0,
        pipeline_run_id=workspace,
        environment=profile.environment,
    )

    write_json(decision_answers_path(workspace), answers_doc.model_dump(exclude_none=True))
    write_json(decision_profile_path(workspace), profile.model_dump(exclude_none=True))
    write_json(decision_architecture_view_path(workspace), architecture_view.model_dump(exclude_none=True))
    write_json(decision_approval_payload_path(workspace), approval_payload)
    return answers_doc, profile, architecture_view, approval_payload, runtime_paths_for_workspace(workspace)


def _render_ecs_curated_bundle(
    *,
    payload: dict[str, Any],
    provider_version: str,
    state_bucket: str,
    lock_table: str,
    aws_region: str,
    context_summary: str,
) -> tuple[dict[str, str], list[str]]:
    compute = payload.get("compute") if isinstance(payload.get("compute"), dict) else {}
    services = [service for service in compute.get("services") or [] if isinstance(service, dict)]
    networking = payload.get("networking") if isinstance(payload.get("networking"), dict) else {}
    data_layer = [item for item in payload.get("data_layer") or [] if isinstance(item, dict)]
    runtime_config = payload.get("runtime_config") if isinstance(payload.get("runtime_config"), dict) else {}
    build_pipeline = payload.get("build_pipeline") if isinstance(payload.get("build_pipeline"), dict) else {}
    operational = payload.get("operational") if isinstance(payload.get("operational"), dict) else {}

    project_name = str(payload.get("project_name") or "deplai-project").strip() or "deplai-project"
    workspace = str(payload.get("workspace") or project_name).strip() or project_name
    environment = str(payload.get("environment") or "dev").strip() or "dev"
    provider_scaffold = build_profile_bundle(
        payload={
            "document_kind": "deployment_profile",
            "workspace": workspace,
            "project_name": project_name,
            "compute": {"strategy": "s3_cloudfront", "services": []},
            "networking": {},
        },
        provider_version=provider_version,
        state_bucket=state_bucket,
        lock_table=lock_table,
        aws_region=aws_region,
        context_summary=context_summary,
        website_index_html="",
    )[0]
    versions_tf = provider_scaffold.get("terraform/versions.tf", "")
    providers_tf = provider_scaffold.get("terraform/providers.tf", "")
    backend_tf = provider_scaffold.get("terraform/backend.tf", "")

    required_secrets = [str(item).strip() for item in runtime_config.get("required_secrets") or [] if str(item).strip()]
    build_command = str(build_pipeline.get("build_command") or "").strip()
    start_command = str(build_pipeline.get("start_command") or "").strip()
    log_group = str(operational.get("log_group") or f"/deplai/{project_name}/ecs").strip()
    log_retention = int(operational.get("log_retention_days") or 30)
    ecr_repository = str(build_pipeline.get("ecr_repository") or f"{project_name}-app").strip() or f"{project_name}-app"

    postgres = next((item for item in data_layer if str(item.get("type") or "") == "postgresql"), None)
    redis = next((item for item in data_layer if str(item.get("type") or "") == "redis"), None)

    variables_tf = f"""variable "project_name" {{
  type    = string
  default = {json.dumps(project_name)}
}}

variable "environment" {{
  type    = string
  default = {json.dumps(environment)}
}}

variable "aws_region" {{
  type    = string
  default = {json.dumps(aws_region)}
}}
"""
    locals_tf = f"""locals {{
  common_tags = {{
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "deplai"
  }}

  services = jsondecode(<<JSON
{json.dumps(services, ensure_ascii=True)}
JSON
  )

  networking = jsondecode(<<JSON
{json.dumps(networking, ensure_ascii=True)}
JSON
  )

  data_layer = jsondecode(<<JSON
{json.dumps(data_layer, ensure_ascii=True)}
JSON
  )

  runtime_config = jsondecode(<<JSON
{json.dumps(runtime_config, ensure_ascii=True)}
JSON
  )

  build_pipeline = jsondecode(<<JSON
{json.dumps(build_pipeline, ensure_ascii=True)}
JSON
  )
}}
"""
    main_tf = """module "networking" {
  source                = "./modules/networking"
  project_name          = var.project_name
  create_nat_gateway    = try(local.networking.nat_gateway, true)
  load_balancer_enabled = true
  ports_exposed         = [for svc in local.services : try(svc.port, 0) if try(svc.port, 0) > 0]
  common_tags           = local.common_tags
}

module "iam" {
  source               = "./modules/iam"
  project_name         = var.project_name
  required_secret_names = try(local.runtime_config.required_secrets, [])
  common_tags          = local.common_tags
}

module "data" {
  source            = "./modules/data"
  project_name      = var.project_name
  postgres_config   = try([for item in local.data_layer : item if try(item.type, "") == "postgresql"][0], null)
  redis_config      = try([for item in local.data_layer : item if try(item.type, "") == "redis"][0], null)
  private_subnet_ids = module.networking.private_subnet_ids
  db_security_group_id = module.networking.db_security_group_id
  cache_security_group_id = module.networking.cache_security_group_id
  common_tags       = local.common_tags
}

module "compute" {
  source                = "./modules/compute"
  project_name          = var.project_name
  aws_region            = var.aws_region
  services              = local.services
  vpc_id                = module.networking.vpc_id
  public_subnet_ids     = module.networking.public_subnet_ids
  private_subnet_ids    = module.networking.private_subnet_ids
  alb_security_group_id = module.networking.alb_security_group_id
  app_security_group_id = module.networking.app_security_group_id
  ecs_execution_role_arn = module.iam.ecs_execution_role_arn
  ecs_task_role_arn     = module.iam.ecs_task_role_arn
  ecr_repository_name   = try(local.build_pipeline.ecr_repository, var.project_name)
  desired_log_group_name = try(local.runtime_config.log_group_name, null)
  log_group_override    = null
  log_retention_days    = 30
  load_balancer_enabled = true
  common_tags           = local.common_tags
}
"""
    outputs_tf = """output "alb_dns_name" {
  value = module.compute.alb_dns_name
}

output "ecs_cluster_name" {
  value = module.compute.ecs_cluster_name
}

output "ecs_service_names" {
  value = module.compute.ecs_service_names
}

output "ecr_repository_url" {
  value = module.compute.ecr_repository_url
}

output "rds_endpoint" {
  value = module.data.postgres_endpoint
}

output "redis_endpoint" {
  value = module.data.redis_endpoint
}
"""
    tfvars = f'project_name = {json.dumps(project_name)}\nenvironment = {json.dumps(environment)}\naws_region = {json.dumps(aws_region)}\n'
    readme = f"# IaC Bundle - {project_name}\n\nGenerated from deployment_profile using the curated ECS module tree.\n\n{context_summary}\n"

    networking_variables_tf = """variable "project_name" { type = string }
variable "create_nat_gateway" { type = bool }
variable "load_balancer_enabled" { type = bool }
variable "ports_exposed" { type = list(number) }
variable "common_tags" { type = map(string) }
"""
    networking_main_tf = """data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block           = "10.60.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(var.common_tags, { Name = "${var.project_name}-vpc" })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = merge(var.common_tags, { Name = "${var.project_name}-igw" })
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 1)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags                    = merge(var.common_tags, { Name = "${var.project_name}-public-${count.index + 1}" })
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 11)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = merge(var.common_tags, { Name = "${var.project_name}-private-${count.index + 1}" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = merge(var.common_tags, { Name = "${var.project_name}-public-rt" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  count  = var.create_nat_gateway ? 1 : 0
  domain = "vpc"
}

resource "aws_nat_gateway" "main" {
  count         = var.create_nat_gateway ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id
  tags          = merge(var.common_tags, { Name = "${var.project_name}-nat" })
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  tags   = merge(var.common_tags, { Name = "${var.project_name}-private-rt" })
}

resource "aws_route" "private_nat" {
  count                  = var.create_nat_gateway ? 1 : 0
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[0].id
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = var.create_nat_gateway ? aws_route_table.private.id : aws_route_table.public.id
}

resource "aws_security_group" "alb" {
  name_prefix = "${var.project_name}-alb-"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "app" {
  name_prefix = "${var.project_name}-app-"
  vpc_id      = aws_vpc.main.id

  dynamic "ingress" {
    for_each = toset([for port in var.ports_exposed : tostring(port)])
    content {
      from_port       = tonumber(ingress.value)
      to_port         = tonumber(ingress.value)
      protocol        = "tcp"
      security_groups = [aws_security_group.alb.id]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "db" {
  name_prefix = "${var.project_name}-db-"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "cache" {
  name_prefix = "${var.project_name}-cache-"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
"""
    networking_outputs_tf = """output "vpc_id" { value = aws_vpc.main.id }
output "public_subnet_ids" { value = aws_subnet.public[*].id }
output "private_subnet_ids" { value = aws_subnet.private[*].id }
output "alb_security_group_id" { value = aws_security_group.alb.id }
output "app_security_group_id" { value = aws_security_group.app.id }
output "db_security_group_id" { value = aws_security_group.db.id }
output "cache_security_group_id" { value = aws_security_group.cache.id }
"""

    iam_variables_tf = """variable "project_name" { type = string }
variable "required_secret_names" { type = list(string) }
variable "common_tags" { type = map(string) }
"""
    iam_main_tf = """resource "aws_iam_role" "ecs_execution" {
  name_prefix = "${var.project_name}-ecs-exec-"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action = "sts:AssumeRole"
    }]
  })
  tags = var.common_tags
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "ecs_task" {
  name_prefix = "${var.project_name}-ecs-task-"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action = "sts:AssumeRole"
    }]
  })
  tags = var.common_tags
}

resource "aws_iam_role_policy" "ecs_task_secrets" {
  name_prefix = "${var.project_name}-secrets-"
  role        = aws_iam_role.ecs_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["secretsmanager:GetSecretValue"]
      Resource = "*"
    }]
  })
}
"""
    iam_outputs_tf = """output "ecs_execution_role_arn" { value = aws_iam_role.ecs_execution.arn }
output "ecs_task_role_arn" { value = aws_iam_role.ecs_task.arn }
output "compute_role_arn" { value = aws_iam_role.ecs_task.arn }
"""

    data_variables_tf = """variable "project_name" { type = string }
variable "postgres_config" { type = any }
variable "redis_config" { type = any }
variable "private_subnet_ids" { type = list(string) }
variable "db_security_group_id" { type = string }
variable "cache_security_group_id" { type = string }
variable "common_tags" { type = map(string) }
"""
    data_main_tf = """resource "aws_db_subnet_group" "main" {
  count      = var.postgres_config == null ? 0 : 1
  name       = "${var.project_name}-db-subnets"
  subnet_ids = var.private_subnet_ids
  tags       = var.common_tags
}

resource "aws_db_instance" "main" {
  count                   = var.postgres_config == null ? 0 : 1
  identifier              = "${var.project_name}-postgres"
  engine                  = "postgres"
  engine_version          = try(var.postgres_config.engine_version, "15.4")
  instance_class          = try(var.postgres_config.instance_class, "db.t3.small")
  allocated_storage       = try(var.postgres_config.storage_gb, 20)
  storage_type            = "gp3"
  db_subnet_group_name    = aws_db_subnet_group.main[0].name
  vpc_security_group_ids  = [var.db_security_group_id]
  username                = "deplai"
  password                = "ChangeMe123!"
  skip_final_snapshot     = true
  publicly_accessible     = false
  backup_retention_period = try(var.postgres_config.backup_retention_days, 7)
  multi_az                = try(var.postgres_config.multi_az, false)
  tags                    = var.common_tags
}

resource "aws_elasticache_subnet_group" "main" {
  count      = var.redis_config == null ? 0 : 1
  name       = "${var.project_name}-cache-subnets"
  subnet_ids = var.private_subnet_ids
}

resource "aws_elasticache_cluster" "main" {
  count               = var.redis_config == null ? 0 : 1
  cluster_id          = "${var.project_name}-redis"
  engine              = "redis"
  node_type           = try(var.redis_config.node_type, "cache.t3.small")
  num_cache_nodes     = 1
  port                = 6379
  subnet_group_name   = aws_elasticache_subnet_group.main[0].name
  security_group_ids  = [var.cache_security_group_id]
}
"""
    data_outputs_tf = """output "postgres_endpoint" { value = try(aws_db_instance.main[0].address, null) }
output "redis_endpoint" { value = try(aws_elasticache_cluster.main[0].cache_nodes[0].address, null) }
"""

    compute_variables_tf = """variable "project_name" { type = string }
variable "aws_region" { type = string }
variable "services" { type = list(any) }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "private_subnet_ids" { type = list(string) }
variable "alb_security_group_id" { type = string }
variable "app_security_group_id" { type = string }
variable "ecs_execution_role_arn" { type = string }
variable "ecs_task_role_arn" { type = string }
variable "ecr_repository_name" { type = string }
variable "load_balancer_enabled" { type = bool }
variable "desired_log_group_name" {
  type    = string
  default = null
}
variable "log_group_override" {
  type    = string
  default = null
}
variable "log_retention_days" { type = number }
variable "common_tags" { type = map(string) }
"""
    compute_main_tf = f"""locals {{
  web_services = [for svc in var.services : svc if try(svc.port, 0) > 0]
  web_service  = length(local.web_services) > 0 ? local.web_services[0] : var.services[0]
  log_group_name = coalesce(var.log_group_override, var.desired_log_group_name, {json.dumps(log_group)})
}}

resource "aws_ecr_repository" "app" {{
  name                 = var.ecr_repository_name
  image_tag_mutability = "MUTABLE"
  tags                 = var.common_tags
}}

resource "aws_cloudwatch_log_group" "ecs" {{
  name              = local.log_group_name
  retention_in_days = var.log_retention_days
  tags              = var.common_tags
}}

resource "aws_ecs_cluster" "main" {{
  name = "${{var.project_name}}-cluster"
  tags = var.common_tags
}}

resource "aws_lb" "main" {{
  count              = var.load_balancer_enabled ? 1 : 0
  name               = substr("${{var.project_name}}-alb", 0, 32)
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.alb_security_group_id]
  subnets            = var.public_subnet_ids
  tags               = var.common_tags
}}

resource "aws_lb_target_group" "app" {{
  count       = var.load_balancer_enabled ? 1 : 0
  name_prefix = "tg-"
  port        = try(local.web_service.port, 3000)
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  health_check {{
    path                = "/"
    matcher             = "200-399"
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }}
}}

resource "aws_lb_listener" "http" {{
  count             = var.load_balancer_enabled ? 1 : 0
  load_balancer_arn = aws_lb.main[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {{
    type             = "forward"
    target_group_arn = aws_lb_target_group.app[0].arn
  }}
}}

resource "aws_ecs_task_definition" "service" {{
  for_each                 = {{ for svc in var.services : svc.id => svc }}
  family                   = "${{var.project_name}}-${{each.key}}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(try(each.value.cpu, 512))
  memory                   = tostring(try(each.value.memory, 1024))
  execution_role_arn       = var.ecs_execution_role_arn
  task_role_arn            = var.ecs_task_role_arn

  container_definitions = jsonencode([{{ 
    name      = each.key
    image     = aws_ecr_repository.app.repository_url
    essential = true
    command   = try(each.value.command, null)
    portMappings = try(each.value.port, 0) > 0 ? [{{
      containerPort = try(each.value.port, 3000)
      hostPort      = try(each.value.port, 3000)
      protocol      = "tcp"
    }}] : []
    logConfiguration = {{
      logDriver = "awslogs"
      options = {{
        awslogs-group         = aws_cloudwatch_log_group.ecs.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = each.key
      }}
    }}
  }}])
}}

resource "aws_ecs_service" "service" {{
  for_each        = {{ for svc in var.services : svc.id => svc }}
  name            = "${{var.project_name}}-${{each.key}}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.service[each.key].arn
  launch_type     = "FARGATE"
  desired_count   = try(each.value.desired_count, 1)

  network_configuration {{
    assign_public_ip = false
    subnets          = var.private_subnet_ids
    security_groups  = [var.app_security_group_id]
  }}

  dynamic "load_balancer" {{
    for_each = var.load_balancer_enabled && try(each.value.port, 0) > 0 && each.key == local.web_service.id ? [1] : []
    content {{
      target_group_arn = aws_lb_target_group.app[0].arn
      container_name   = each.key
      container_port   = try(each.value.port, 3000)
    }}
  }}
  depends_on = [aws_lb_listener.http]
}}
"""
    compute_outputs_tf = """output "alb_dns_name" { value = try(aws_lb.main[0].dns_name, null) }
output "ecs_cluster_name" { value = aws_ecs_cluster.main.name }
output "ecs_service_names" { value = values(aws_ecs_service.service)[*].name }
output "ecr_repository_url" { value = aws_ecr_repository.app.repository_url }
output "service_endpoint" { value = try(aws_lb.main[0].dns_name, null) }
output "log_group_name" { value = aws_cloudwatch_log_group.ecs.name }
"""

    files = {
        "README.md": readme,
        "terraform/versions.tf": versions_tf,
        "terraform/providers.tf": providers_tf,
        "terraform/variables.tf": variables_tf,
        "terraform/locals.tf": locals_tf,
        "terraform/main.tf": main_tf,
        "terraform/outputs.tf": outputs_tf,
        "terraform/terraform.tfvars": tfvars,
        "terraform/modules/networking/variables.tf": networking_variables_tf,
        "terraform/modules/networking/main.tf": networking_main_tf,
        "terraform/modules/networking/outputs.tf": networking_outputs_tf,
        "terraform/modules/iam/variables.tf": iam_variables_tf,
        "terraform/modules/iam/main.tf": iam_main_tf,
        "terraform/modules/iam/outputs.tf": iam_outputs_tf,
        "terraform/modules/data/variables.tf": data_variables_tf,
        "terraform/modules/data/main.tf": data_main_tf,
        "terraform/modules/data/outputs.tf": data_outputs_tf,
        "terraform/modules/compute/variables.tf": compute_variables_tf,
        "terraform/modules/compute/main.tf": compute_main_tf,
        "terraform/modules/compute/outputs.tf": compute_outputs_tf,
    }
    if backend_tf:
        files["terraform/backend.tf"] = backend_tf
    warnings = []
    if required_secrets:
        warnings.append(f"Curated ECS fallback assumes runtime secrets already exist in AWS Secrets Manager: {', '.join(required_secrets)}")
    if build_command or start_command:
        warnings.append("Curated ECS fallback preserved build/start commands in root locals for worker context but does not create CI automation.")
    if postgres and str(postgres.get("multi_az")).lower() == "true":
        warnings.append("Curated ECS fallback enables Multi-AZ RDS but still uses placeholder database credentials. Replace them before production rollout.")
    if redis:
        warnings.append("Curated ECS fallback provisions a single-node Redis cluster. Adjust for production resilience if required.")
    return files, warnings


def _render_curated_fallback_bundle(
    *,
    payload: dict[str, Any],
    provider_version: str,
    state_bucket: str,
    lock_table: str,
    aws_region: str,
    context_summary: str,
    website_index_html: str,
) -> tuple[dict[str, str], list[str]]:
    if _compute_strategy(payload) == "ecs_fargate":
        return _render_ecs_curated_bundle(
            payload=payload,
            provider_version=provider_version,
            state_bucket=state_bucket,
            lock_table=lock_table,
            aws_region=aws_region,
            context_summary=context_summary,
        )
    return build_profile_bundle(
        payload=payload,
        provider_version=provider_version,
        state_bucket=state_bucket,
        lock_table=lock_table,
        aws_region=aws_region,
        context_summary=context_summary,
        website_index_html=website_index_html,
    )


def _select_group_files(bundle_files: dict[str, str], group_plan: dict[str, Any]) -> list[dict[str, Any]]:
    owned_paths = _string_list(group_plan.get("owned_files"))
    return [
        {"path": path, "content": bundle_files[path]}
        for path in owned_paths
        if path in bundle_files and str(bundle_files[path]).strip()
    ]


def _legacy_generate_terraform_bundle_superseded(
    *,
    architecture_json: dict[str, Any],
    project_name: str,
    workspace: str,
    aws_region: str,
    iac_mode: str | None = None,
    qa_summary: str = "",
    website_index_html: str = "",
    repository_context_json: dict[str, Any] | None = None,
    deployment_profile_json: dict[str, Any] | None = None,
    approval_payload_json: dict[str, Any] | None = None,
    security_context_json: dict[str, Any] | None = None,
    website_asset_stats_json: dict[str, Any] | None = None,
    frontend_entrypoint_detection_json: dict[str, Any] | None = None,
    llm_provider: str | None = None,
    llm_api_key: str | None = None,
    llm_model: str | None = None,
    llm_api_base_url: str | None = None,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    resolved_iac_mode = "llm" if str(iac_mode or "").strip().lower() == "llm" else "deterministic"
    terraform_llm = _resolve_terraform_llm_config(
        llm_provider=llm_provider,
        llm_api_key=llm_api_key,
        llm_model=llm_model,
        llm_api_base_url=llm_api_base_url,
    ) if resolved_iac_mode == "llm" else None
    terraform_llm_enabled = _terraform_llm_available(terraform_llm)
    _emit_worker(
        progress_callback,
        msg_type="info",
        content="Terraform orchestrator accepted the approved deployment profile.",
        worker_id="terraform-orchestrator",
        worker_role="Terraform Orchestrator",
        worker_status="started",
        extra={
            "workspace": workspace,
            "aws_region": aws_region,
            "model": str((terraform_llm or {}).get("model") or "deterministic-fallback"),
        },
    )

    approved_profile = parse_deployment_profile(architecture_json)
    approved_profile_payload = approved_profile.model_dump(exclude_none=True)

    if terraform_llm_enabled:
        try:
            repo_context_document = _run_terraform_json_worker(
                workspace=workspace,
                stage="terraform_repo_context",
                model=str((terraform_llm or {}).get("model") or TERRAFORM_CONTEXT_MODEL),
                llm_config=terraform_llm or {},
                system_prompt=_terraform_repo_context_system_prompt(),
                prompt_payload={
                    "project_name": project_name,
                    "workspace": workspace,
                    "aws_region": aws_region,
                    "qa_summary": qa_summary,
                    "repository_context": repository_context_json or {},
                    "approved_deployment_profile": approved_profile_payload,
                },
                worker_id="repo-context-agent",
                worker_role="Repository Context Agent",
                progress_callback=progress_callback,
                max_tokens=2200,
            )
        except Exception:
            _emit_worker(
                progress_callback,
                msg_type="info",
                content="Repository Context Agent is falling back to deterministic normalization.",
                worker_id="repo-context-agent",
                worker_role="Repository Context Agent",
                worker_status="running",
            )
            repo_context_document = _fallback_repo_context_document(
                project_name=project_name,
                repository_context_json=repository_context_json,
                architecture_json=approved_profile_payload,
                qa_summary=qa_summary,
            )
            _emit_worker(
                progress_callback,
                msg_type="success",
                content="Repository Context Agent completed with deterministic fallback.",
                worker_id="repo-context-agent",
                worker_role="Repository Context Agent",
                worker_status="completed",
            )
    else:
        _emit_worker(
            progress_callback,
            msg_type="info",
            content="Repository Context Agent is using deterministic fallback input normalization.",
            worker_id="repo-context-agent",
            worker_role="Repository Context Agent",
            worker_status="started",
        )
        repo_context_document = _fallback_repo_context_document(
            project_name=project_name,
            repository_context_json=repository_context_json,
            architecture_json=approved_profile_payload,
            qa_summary=qa_summary,
        )
        _emit_worker(
            progress_callback,
            msg_type="success",
            content="Repository Context Agent completed with deterministic fallback.",
            worker_id="repo-context-agent",
            worker_role="Repository Context Agent",
            worker_status="completed",
        )

    if terraform_llm_enabled:
        try:
            refined_profile_payload = _run_terraform_json_worker(
                workspace=workspace,
                stage="terraform_architecture_profile",
                model=str((terraform_llm or {}).get("model") or TERRAFORM_PROFILE_MODEL),
                llm_config=terraform_llm or {},
                system_prompt=_terraform_architecture_profile_system_prompt(),
                prompt_payload={
                    "project_name": project_name,
                    "workspace": workspace,
                    "aws_region": aws_region,
                    "approved_deployment_profile": approved_profile_payload,
                    "repo_context_document": repo_context_document,
                    "qa_summary": qa_summary,
                },
                worker_id="architecture-profile-agent",
                worker_role="Architecture to Profile Agent",
                progress_callback=progress_callback,
                max_tokens=3200,
            )
        except Exception:
            _emit_worker(
                progress_callback,
                msg_type="info",
                content="Architecture to Profile Agent is falling back to the approved deployment profile.",
                worker_id="architecture-profile-agent",
                worker_role="Architecture to Profile Agent",
                worker_status="running",
            )
            refined_profile_payload = dict(approved_profile_payload)
            warnings = list(refined_profile_payload.get("warnings") or [])
            warnings.append("Architecture-to-profile worker fell back to the approved deployment profile after LLM failure.")
            refined_profile_payload["warnings"] = warnings
            _emit_worker(
                progress_callback,
                msg_type="success",
                content="Architecture to Profile Agent completed with deterministic fallback.",
                worker_id="architecture-profile-agent",
                worker_role="Architecture to Profile Agent",
                worker_status="completed",
            )
    else:
        _emit_worker(
            progress_callback,
            msg_type="info",
            content="Architecture to Profile Agent is using the approved deployment profile directly.",
            worker_id="architecture-profile-agent",
            worker_role="Architecture to Profile Agent",
            worker_status="started",
        )
        refined_profile_payload = dict(approved_profile_payload)
        warnings = list(refined_profile_payload.get("warnings") or [])
        warnings.append("Architecture-to-profile worker used deterministic fallback because no free Terraform worker LLM was available.")
        refined_profile_payload["warnings"] = warnings
        _emit_worker(
            progress_callback,
            msg_type="success",
            content="Architecture to Profile Agent completed with deterministic fallback.",
            worker_id="architecture-profile-agent",
            worker_role="Architecture to Profile Agent",
            worker_status="completed",
        )

    try:
        refined_profile = parse_deployment_profile(refined_profile_payload)
    except Exception:
        _emit_worker(
            progress_callback,
            msg_type="info",
            content="Architecture to Profile Agent output was invalid; using the approved deployment profile.",
            worker_id="architecture-profile-agent",
            worker_role="Architecture to Profile Agent",
            worker_status="completed",
        )
        refined_profile = approved_profile
    profile_payload = refined_profile.model_dump(exclude_none=True)
    manifest, dag_order = build_profile_manifest(profile_payload)
    compute = profile_payload.get("compute") if isinstance(profile_payload.get("compute"), dict) else {}
    compute_strategy = str(compute.get("strategy") or "unknown").strip() or "unknown"
    service_count = len(compute.get("services") or []) if isinstance(compute.get("services"), list) else 0

    if terraform_llm_enabled:
        try:
            structure_plan = _run_terraform_json_worker(
                workspace=workspace,
                stage="terraform_structure",
                model=str((terraform_llm or {}).get("model") or TERRAFORM_STRUCTURE_MODEL),
                llm_config=terraform_llm or {},
                system_prompt=_terraform_structure_system_prompt(),
                prompt_payload={
                    "project_name": project_name,
                    "workspace": workspace,
                    "aws_region": aws_region,
                    "refined_deployment_profile": profile_payload,
                    "repo_context_document": repo_context_document,
                    "manifest": manifest,
                    "dag_order": dag_order,
                },
                worker_id="terraform-structure-agent",
                worker_role="Terraform Structure Agent",
                progress_callback=progress_callback,
                max_tokens=2200,
            )
        except Exception:
            _emit_worker(
                progress_callback,
                msg_type="info",
                content="Terraform Structure Agent is falling back to deterministic bundle planning.",
                worker_id="terraform-structure-agent",
                worker_role="Terraform Structure Agent",
                worker_status="running",
            )
            structure_plan = _fallback_structure_plan(profile_payload)
            _emit_worker(
                progress_callback,
                msg_type="success",
                content="Terraform Structure Agent completed with deterministic fallback.",
                worker_id="terraform-structure-agent",
                worker_role="Terraform Structure Agent",
                worker_status="completed",
            )
    else:
        _emit_worker(
            progress_callback,
            msg_type="info",
            content="Terraform Structure Agent is using deterministic bundle planning.",
            worker_id="terraform-structure-agent",
            worker_role="Terraform Structure Agent",
            worker_status="started",
        )
        structure_plan = _fallback_structure_plan(profile_payload)
        _emit_worker(
            progress_callback,
            msg_type="success",
            content="Terraform Structure Agent completed with deterministic fallback.",
            worker_id="terraform-structure-agent",
            worker_role="Terraform Structure Agent",
            worker_status="completed",
        )

    _emit_worker(
        progress_callback,
        msg_type="info",
        content=f"Rendering deterministic Terraform bundle for compute strategy '{compute_strategy}'.",
        worker_id="terraform-orchestrator",
        worker_role="Terraform Orchestrator",
        worker_status="running",
        extra={"compute_strategy": compute_strategy, "service_count": service_count},
    )
    files, warnings = build_profile_bundle(
        payload=profile_payload,
        provider_version=DEFAULT_PROVIDER_CONSTRAINT,
        state_bucket="",
        lock_table="",
        aws_region=aws_region,
        context_summary=qa_summary,
        website_index_html=website_index_html,
    )
    ordered_files = [
        {"path": path, "content": content}
        for path, content in files.items()
        if path == "README.md" or path.startswith("terraform/")
    ]
    preferred_order = [str(item) for item in list(structure_plan.get("ordering") or []) if str(item).strip()]
    ordered_files = _sort_surface_files(ordered_files, preferred_order)
    ordered_paths = [str(item.get("path") or "") for item in ordered_files]

    if terraform_llm_enabled:
        try:
            validation_report = _run_terraform_json_worker(
                workspace=workspace,
                stage="terraform_validation",
                model=str((terraform_llm or {}).get("model") or TERRAFORM_VALIDATOR_MODEL),
                llm_config=terraform_llm or {},
                system_prompt=_terraform_validation_system_prompt(),
                prompt_payload={
                    "project_name": project_name,
                    "workspace": workspace,
                    "refined_deployment_profile": profile_payload,
                    "structure_plan": structure_plan,
                    "rendered_surface_files": [{"path": item["path"]} for item in ordered_files],
                    "render_warnings": warnings,
                },
                worker_id="validation-remediation-agent",
                worker_role="Validation and Remediation Agent",
                progress_callback=progress_callback,
                max_tokens=1800,
            )
        except Exception:
            _emit_worker(
                progress_callback,
                msg_type="info",
                content="Validation and Remediation Agent is falling back to deterministic bundle validation.",
                worker_id="validation-remediation-agent",
                worker_role="Validation and Remediation Agent",
                worker_status="running",
            )
            validation_report = _fallback_validation_report(ordered_paths=ordered_paths, structure_plan=structure_plan)
            _emit_worker(
                progress_callback,
                msg_type="success",
                content="Validation and Remediation Agent completed with deterministic fallback.",
                worker_id="validation-remediation-agent",
                worker_role="Validation and Remediation Agent",
                worker_status="completed",
            )
    else:
        _emit_worker(
            progress_callback,
            msg_type="info",
            content="Validation and Remediation Agent is running deterministic output checks.",
            worker_id="validation-remediation-agent",
            worker_role="Validation and Remediation Agent",
            worker_status="started",
        )
        validation_report = _fallback_validation_report(ordered_paths=ordered_paths, structure_plan=structure_plan)
        _emit_worker(
            progress_callback,
            msg_type="success",
            content="Validation and Remediation Agent completed with deterministic fallback.",
            worker_id="validation-remediation-agent",
            worker_role="Validation and Remediation Agent",
            worker_status="completed",
        )

    validation_missing = [str(item) for item in list(validation_report.get("missing_files") or []) if str(item).strip()]
    validation_order = [str(item) for item in list(validation_report.get("ordering_confirmed") or []) if str(item).strip()]
    if validation_order:
        ordered_files = _sort_surface_files(ordered_files, validation_order)
    resolved_workspace = str(profile_payload.get("workspace") or workspace or "default").strip() or "default"

    _emit_worker(
        progress_callback,
        msg_type="success",
        content=f"Terraform orchestrator completed with {len(ordered_files)} surfaced file(s).",
        worker_id="terraform-orchestrator",
        worker_role="Terraform Orchestrator",
        worker_status="completed",
        extra={"compute_strategy": compute_strategy, "service_count": service_count},
    )

    all_warnings = [
        "Generated through a true multi-worker Terraform pipeline with deterministic HCL rendering.",
        *[str(item) for item in list(profile_payload.get("warnings") or []) if str(item).strip()],
        *[str(item) for item in list(warnings or []) if str(item).strip()],
        *[str(item) for item in list(validation_report.get("warnings") or []) if str(item).strip()],
    ]
    if validation_missing:
        all_warnings.append(f"Validation worker reported missing surfaced files: {', '.join(validation_missing)}")

    return {
        "success": True,
        "provider": "aws",
        "project_name": project_name,
        "run_id": None,
        "workspace": resolved_workspace,
        "provider_version": DEFAULT_PROVIDER_CONSTRAINT,
        "state_bucket": None,
        "lock_table": None,
        "manifest": manifest,
        "dag_order": dag_order,
        "warnings": all_warnings,
        "files": ordered_files,
        "readme": files.get("README.md"),
        "source": "terraform_agent_multi_worker",
        "details": {
            "workers": [
                {
                    "id": "repo-context-agent",
                    "role": "Repository Context Agent",
                    "model": str((terraform_llm or {}).get("model") or "deterministic-fallback"),
                    "status": "completed",
                    "output_summary": str(repo_context_document.get("summary") or "").strip(),
                },
                {
                    "id": "architecture-profile-agent",
                    "role": "Architecture to Profile Agent",
                    "model": str((terraform_llm or {}).get("model") or "deterministic-fallback"),
                    "status": "completed",
                    "output_summary": f"Selected compute strategy '{compute_strategy}' with {service_count} service(s).",
                },
                {
                    "id": "terraform-structure-agent",
                    "role": "Terraform Structure Agent",
                    "model": str((terraform_llm or {}).get("model") or "deterministic-fallback"),
                    "status": "completed",
                    "output_summary": str(structure_plan.get("summary") or "").strip(),
                },
                {
                    "id": "validation-remediation-agent",
                    "role": "Validation and Remediation Agent",
                    "model": str((terraform_llm or {}).get("model") or "deterministic-fallback"),
                    "status": "completed",
                    "output_summary": str(validation_report.get("summary") or "").strip(),
                },
            ],
            "repo_context_document": repo_context_document,
            "structure_plan": structure_plan,
            "validation_report": validation_report,
            "compute_strategy": compute_strategy,
            "service_count": service_count,
            "resolved_workspace": resolved_workspace,
            "llm_workers_enabled": terraform_llm_enabled,
            "requested_iac_mode": resolved_iac_mode,
            "llm_provider": str((terraform_llm or {}).get("provider") or "deterministic"),
        },
    }


def generate_terraform_bundle(
    *,
    architecture_json: dict[str, Any],
    project_name: str,
    workspace: str,
    aws_region: str,
    iac_mode: str | None = None,
    qa_summary: str = "",
    website_index_html: str = "",
    repository_context_json: dict[str, Any] | None = None,
    deployment_profile_json: dict[str, Any] | None = None,
    approval_payload_json: dict[str, Any] | None = None,
    security_context_json: dict[str, Any] | None = None,
    website_asset_stats_json: dict[str, Any] | None = None,
    frontend_entrypoint_detection_json: dict[str, Any] | None = None,
    llm_provider: str | None = None,
    llm_api_key: str | None = None,
    llm_model: str | None = None,
    llm_api_base_url: str | None = None,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    resolved_iac_mode = "llm" if str(iac_mode or "").strip().lower() == "llm" else "deterministic"
    terraform_llm = _resolve_terraform_llm_config(
        llm_provider=llm_provider,
        llm_api_key=llm_api_key,
        llm_model=llm_model,
        llm_api_base_url=llm_api_base_url,
    ) if resolved_iac_mode == "llm" else None
    terraform_llm_enabled = _terraform_llm_available(terraform_llm)
    worker_model = str((terraform_llm or {}).get("model") or "deterministic-fallback")
    _emit_worker(
        progress_callback,
        msg_type="info",
        content="Terraform orchestrator accepted the approved deployment profile.",
        worker_id="terraform-orchestrator",
        worker_role="Terraform Orchestrator",
        worker_status="started",
        extra={"workspace": workspace, "aws_region": aws_region, "model": worker_model},
    )

    approved_source = deployment_profile_json if isinstance(deployment_profile_json, dict) and deployment_profile_json else architecture_json
    approved_profile = parse_deployment_profile(approved_source)
    approved_profile_payload = approved_profile.model_dump(exclude_none=True)

    fallback_bundle_cache: dict[str, str] | None = None
    fallback_bundle_warnings: list[str] = []
    fallback_report: dict[str, Any] = {
        "stage_fallbacks": {},
        "file_groups": [],
        "full_bundle_fallback": False,
    }
    worker_details: list[dict[str, Any]] = []

    def load_fallback_bundle(current_payload: dict[str, Any]) -> tuple[dict[str, str], list[str]]:
        nonlocal fallback_bundle_cache, fallback_bundle_warnings
        if fallback_bundle_cache is None:
            fallback_bundle_cache, fallback_bundle_warnings = _render_curated_fallback_bundle(
                payload=current_payload,
                provider_version=DEFAULT_PROVIDER_CONSTRAINT,
                state_bucket="",
                lock_table="",
                aws_region=aws_region,
                context_summary=qa_summary,
                website_index_html=website_index_html,
            )
        return fallback_bundle_cache, fallback_bundle_warnings

    if terraform_llm_enabled:
        try:
            repo_context_document = _run_terraform_json_worker(
                workspace=workspace,
                stage="terraform_repo_context",
                model=str((terraform_llm or {}).get("model") or TERRAFORM_CONTEXT_MODEL),
                llm_config=terraform_llm or {},
                system_prompt=_terraform_repo_context_system_prompt(),
                prompt_payload={
                    "project_name": project_name,
                    "workspace": workspace,
                    "aws_region": aws_region,
                    "operator_qa_summary": qa_summary,
                    "repository_context": repository_context_json or {},
                    "security_context": security_context_json or {},
                    "frontend_entrypoint_detection": frontend_entrypoint_detection_json or {},
                    "website_asset_stats": website_asset_stats_json or {},
                    "approved_deployment_profile": approved_profile_payload,
                },
                worker_id="repo-context-agent",
                worker_role="Repository Context Agent",
                progress_callback=progress_callback,
                max_tokens=2400,
            )
            fallback_report["stage_fallbacks"]["repo_context"] = False
        except Exception:
            repo_context_document = _fallback_repo_context_document(
                project_name=project_name,
                repository_context_json=repository_context_json,
                architecture_json=approved_profile_payload,
                qa_summary=qa_summary,
            )
            fallback_report["stage_fallbacks"]["repo_context"] = True
    else:
        repo_context_document = _fallback_repo_context_document(
            project_name=project_name,
            repository_context_json=repository_context_json,
            architecture_json=approved_profile_payload,
            qa_summary=qa_summary,
        )
        fallback_report["stage_fallbacks"]["repo_context"] = True
    worker_details.append(
        {
            "id": "repo-context-agent",
            "role": "Repository Context Agent",
            "model": worker_model,
            "status": "completed",
            "fallback_used": bool(fallback_report["stage_fallbacks"]["repo_context"]),
            "output_summary": str(repo_context_document.get("summary") or "").strip(),
        }
    )

    if terraform_llm_enabled:
        try:
            refined_profile_payload = _run_terraform_json_worker(
                workspace=workspace,
                stage="terraform_architecture_profile",
                model=str((terraform_llm or {}).get("model") or TERRAFORM_PROFILE_MODEL),
                llm_config=terraform_llm or {},
                system_prompt=_terraform_architecture_profile_system_prompt(),
                prompt_payload={
                    "project_name": project_name,
                    "workspace": workspace,
                    "aws_region": aws_region,
                    "approved_deployment_profile": approved_profile_payload,
                    "repo_context_document": repo_context_document,
                    "approval_payload": approval_payload_json or {},
                    "operator_qa_summary": qa_summary,
                },
                worker_id="architecture-profile-agent",
                worker_role="Architecture to Profile Agent",
                progress_callback=progress_callback,
                max_tokens=3600,
            )
            fallback_report["stage_fallbacks"]["architecture_profile"] = False
        except Exception:
            refined_profile_payload = dict(approved_profile_payload)
            refined_profile_payload["warnings"] = [
                *[str(item) for item in list(refined_profile_payload.get("warnings") or []) if str(item).strip()],
                "Architecture-to-profile worker fell back to the approved deployment profile after LLM failure.",
            ]
            fallback_report["stage_fallbacks"]["architecture_profile"] = True
    else:
        refined_profile_payload = dict(approved_profile_payload)
        refined_profile_payload["warnings"] = [
            *[str(item) for item in list(refined_profile_payload.get("warnings") or []) if str(item).strip()],
            "Architecture-to-profile worker used deterministic fallback because no Terraform worker LLM was available.",
        ]
        fallback_report["stage_fallbacks"]["architecture_profile"] = True

    try:
        refined_profile = parse_deployment_profile(refined_profile_payload)
    except Exception:
        refined_profile = approved_profile
        fallback_report["stage_fallbacks"]["architecture_profile"] = True
    profile_payload = refined_profile.model_dump(exclude_none=True)
    manifest, dag_order = build_profile_manifest(profile_payload)
    compute = profile_payload.get("compute") if isinstance(profile_payload.get("compute"), dict) else {}
    compute_strategy = str(compute.get("strategy") or "unknown").strip() or "unknown"
    service_count = len(compute.get("services") or []) if isinstance(compute.get("services"), list) else 0
    worker_details.append(
        {
            "id": "architecture-profile-agent",
            "role": "Architecture to Profile Agent",
            "model": worker_model,
            "status": "completed",
            "fallback_used": bool(fallback_report["stage_fallbacks"]["architecture_profile"]),
            "output_summary": f"Selected compute strategy '{compute_strategy}' with {service_count} service(s).",
        }
    )

    if terraform_llm_enabled:
        try:
            structure_plan_raw = _run_terraform_json_worker(
                workspace=workspace,
                stage="terraform_structure",
                model=str((terraform_llm or {}).get("model") or TERRAFORM_STRUCTURE_MODEL),
                llm_config=terraform_llm or {},
                system_prompt=_terraform_structure_system_prompt(),
                prompt_payload={
                    "project_name": project_name,
                    "workspace": workspace,
                    "aws_region": aws_region,
                    "refined_deployment_profile": profile_payload,
                    "repo_context_document": repo_context_document,
                    "approval_payload": approval_payload_json or {},
                    "manifest": manifest,
                    "dag_order": dag_order,
                },
                worker_id="terraform-structure-agent",
                worker_role="Terraform Structure Agent",
                progress_callback=progress_callback,
                max_tokens=2600,
            )
            fallback_report["stage_fallbacks"]["structure_plan"] = False
        except Exception:
            structure_plan_raw = _fallback_structure_plan(profile_payload)
            fallback_report["stage_fallbacks"]["structure_plan"] = True
    else:
        structure_plan_raw = _fallback_structure_plan(profile_payload)
        fallback_report["stage_fallbacks"]["structure_plan"] = True
    bundle_plan = _coerce_structure_plan(structure_plan_raw, profile_payload)
    worker_details.append(
        {
            "id": "terraform-structure-agent",
            "role": "Terraform Structure Agent",
            "model": worker_model,
            "status": "completed",
            "fallback_used": bool(fallback_report["stage_fallbacks"]["structure_plan"]),
            "output_summary": str(bundle_plan.get("summary") or "").strip(),
        }
    )
    worker_details.append(
        {
            "id": "bundle-planner",
            "role": "Bundle Planner",
            "model": "curated-plan",
            "status": "completed",
            "fallback_used": False,
            "output_summary": str(bundle_plan.get("summary") or "").strip(),
        }
    )

    render_warnings: list[str] = []
    generated_groups: list[dict[str, Any]] = []
    for group_plan in list(bundle_plan.get("file_groups") or []):
        if not isinstance(group_plan, dict):
            continue
        group_id = str(group_plan.get("id") or "group").strip() or "group"
        worker_id = f"file-generator-{group_id}"
        worker_role = f"File Generator ({group_id})"
        fallback_used = False
        fallback_reason = ""
        if terraform_llm_enabled:
            try:
                raw_group = _run_terraform_json_worker(
                    workspace=workspace,
                    stage="terraform_file_generation",
                    model=str((terraform_llm or {}).get("model") or TERRAFORM_PROFILE_MODEL),
                    llm_config=terraform_llm or {},
                    system_prompt=_terraform_file_generation_system_prompt(),
                    prompt_payload={
                        "project_name": project_name,
                        "workspace": workspace,
                        "aws_region": aws_region,
                        "approved_deployment_profile": approved_profile_payload,
                        "refined_deployment_profile": profile_payload,
                        "repo_context_document": repo_context_document,
                        "approval_payload": approval_payload_json or {},
                        "security_context": security_context_json or {},
                        "website_asset_stats": website_asset_stats_json or {},
                        "frontend_entrypoint_detection": frontend_entrypoint_detection_json or {},
                        "structure_plan": {
                            "bundle_strategy": bundle_plan.get("bundle_strategy"),
                            "resource_focus": bundle_plan.get("resource_focus"),
                            "symbol_requirements": bundle_plan.get("symbol_requirements"),
                            "cross_file_dependencies": bundle_plan.get("cross_file_dependencies"),
                        },
                        "current_group": group_plan,
                    },
                    worker_id=worker_id,
                    worker_role=worker_role,
                    progress_callback=progress_callback,
                    max_tokens=5200,
                )
                group_result = _normalize_generated_group(raw_group, group_plan)
                if not group_result["files"]:
                    raise RuntimeError("worker returned no usable files")
                if group_result["missing_owned_files"]:
                    fallback_used = True
                    fallback_reason = f"worker omitted {len(group_result['missing_owned_files'])} owned file(s)"
                    fallback_bundle, bundle_warnings = load_fallback_bundle(profile_payload)
                    fallback_bundle_warnings = bundle_warnings
                    rescued = {
                        item["path"]: item
                        for item in _select_group_files(fallback_bundle, group_plan)
                        if item["path"] in set(group_result["missing_owned_files"])
                    }
                    for item in rescued.values():
                        group_result["files"].append(item)
                    group_result["missing_owned_files"] = [path for path in group_result["missing_owned_files"] if path not in rescued]
                    if group_result["missing_owned_files"]:
                        group_result["unresolved_dependencies"].extend(
                            [f"deterministic rescue missing file {path}" for path in group_result["missing_owned_files"]]
                        )
            except Exception as exc:
                fallback_used = True
                fallback_reason = str(exc)
                fallback_bundle, bundle_warnings = load_fallback_bundle(profile_payload)
                fallback_bundle_warnings = bundle_warnings
                group_result = {
                    "group_id": group_id,
                    "files": _select_group_files(fallback_bundle, group_plan),
                    "unresolved_dependencies": [],
                    "summary": f"Deterministic rescue for {group_id}.",
                    "missing_owned_files": [],
                }
        else:
            fallback_used = True
            fallback_reason = "worker LLM unavailable"
            fallback_bundle, bundle_warnings = load_fallback_bundle(profile_payload)
            fallback_bundle_warnings = bundle_warnings
            group_result = {
                "group_id": group_id,
                "files": _select_group_files(fallback_bundle, group_plan),
                "unresolved_dependencies": [],
                "summary": f"Deterministic rescue for {group_id}.",
                "missing_owned_files": [],
            }

        group_result["used_fallback"] = fallback_used
        if fallback_used:
            fallback_report["file_groups"].append(
                {
                    "group_id": group_id,
                    "reason": fallback_reason or "deterministic rescue used",
                    "owned_files": _string_list(group_plan.get("owned_files")),
                }
            )
            render_warnings.append(f"Terraform file group '{group_id}' used deterministic rescue: {fallback_reason or 'worker LLM unavailable'}.")
        generated_groups.append(group_result)
        worker_details.append(
            {
                "id": worker_id,
                "role": worker_role,
                "model": worker_model,
                "status": "completed",
                "fallback_used": fallback_used,
                "output_summary": str(group_result.get("summary") or "").strip() or f"Generated {len(list(group_result.get('files') or []))} file(s).",
            }
        )

    ordered_files, assembly_report = _assemble_generated_files(
        generated_groups=generated_groups,
        structure_plan=bundle_plan,
    )
    ordered_paths = list(assembly_report.get("ordered_paths") or [])
    critical_paths = {"terraform/main.tf", "terraform/providers.tf", "terraform/outputs.tf", "terraform/variables.tf"}
    critical_missing = [path for path in critical_paths if path not in ordered_paths]
    if not ordered_files or critical_missing:
        fallback_bundle, bundle_warnings = load_fallback_bundle(profile_payload)
        fallback_bundle_warnings = bundle_warnings
        fallback_report["full_bundle_fallback"] = True
        fallback_report["full_bundle_reason"] = (
            f"assembly missing critical file(s): {', '.join(critical_missing)}" if critical_missing else "assembly produced no surfaced files"
        )
        ordered_files = [
            {"path": path, "content": content}
            for path, content in fallback_bundle.items()
            if path == "README.md" or path.startswith("terraform/")
        ]
        ordered_files = _sort_surface_files(ordered_files, _string_list(bundle_plan.get("ordering")))
        ordered_paths = [str(item.get("path") or "") for item in ordered_files]
        assembly_report = {
            "ordered_paths": ordered_paths,
            "missing_files": [],
            "unresolved_references": [],
            "duplicate_paths": [],
            "profile_mismatches": [],
            "generated_file_count": len(ordered_files),
            "fallback_file_count": len(ordered_files),
        }
        render_warnings.append(f"Full curated fallback bundle was used because assembly failed: {fallback_report['full_bundle_reason']}.")

    if terraform_llm_enabled:
        try:
            validation_report = _run_terraform_json_worker(
                workspace=workspace,
                stage="terraform_validation",
                model=str((terraform_llm or {}).get("model") or TERRAFORM_VALIDATOR_MODEL),
                llm_config=terraform_llm or {},
                system_prompt=_terraform_validation_system_prompt(),
                prompt_payload={
                    "project_name": project_name,
                    "workspace": workspace,
                    "refined_deployment_profile": profile_payload,
                    "structure_plan": bundle_plan,
                    "rendered_surface_files": [{"path": item["path"]} for item in ordered_files],
                    "assembly_report": assembly_report,
                    "render_warnings": render_warnings,
                },
                worker_id="validation-remediation-agent",
                worker_role="Validation and Remediation Agent",
                progress_callback=progress_callback,
                max_tokens=2200,
            )
            fallback_report["stage_fallbacks"]["validation"] = False
        except Exception:
            validation_report = _fallback_validation_report(
                ordered_paths=ordered_paths,
                structure_plan=bundle_plan,
                assembly_report=assembly_report,
            )
            fallback_report["stage_fallbacks"]["validation"] = True
    else:
        validation_report = _fallback_validation_report(
            ordered_paths=ordered_paths,
            structure_plan=bundle_plan,
            assembly_report=assembly_report,
        )
        fallback_report["stage_fallbacks"]["validation"] = True

    validation_missing = _string_list(validation_report.get("missing_files"))
    validation_order = _string_list(validation_report.get("ordering_confirmed"))
    if validation_order:
        ordered_files = _sort_surface_files(ordered_files, validation_order)
    worker_details.append(
        {
            "id": "validation-remediation-agent",
            "role": "Validation and Remediation Agent",
            "model": worker_model,
            "status": "completed",
            "fallback_used": bool(fallback_report["stage_fallbacks"]["validation"]),
            "output_summary": str(validation_report.get("summary") or "").strip(),
        }
    )

    resolved_workspace = str(profile_payload.get("workspace") or workspace or "default").strip() or "default"
    any_stage_fallback = any(bool(value) for value in dict(fallback_report.get("stage_fallbacks") or {}).values())
    partial_fallback = bool(fallback_report["file_groups"]) or any_stage_fallback
    if fallback_report["full_bundle_fallback"]:
        source = "terraform_agent_full_fallback"
    elif partial_fallback:
        source = "terraform_agent_multi_worker_partial_fallback"
    else:
        source = "terraform_agent_multi_worker_dynamic"

    _emit_worker(
        progress_callback,
        msg_type="success",
        content=f"Terraform orchestrator completed with {len(ordered_files)} surfaced file(s).",
        worker_id="terraform-orchestrator",
        worker_role="Terraform Orchestrator",
        worker_status="completed",
        extra={"compute_strategy": compute_strategy, "service_count": service_count},
    )

    all_warnings = [
        *[str(item) for item in list(profile_payload.get("warnings") or []) if str(item).strip()],
        *[str(item) for item in render_warnings if str(item).strip()],
        *[str(item) for item in fallback_bundle_warnings if str(item).strip()],
        *[str(item) for item in list(validation_report.get("warnings") or []) if str(item).strip()],
    ]
    if validation_missing:
        all_warnings.append(f"Validation worker reported missing surfaced files: {', '.join(validation_missing)}")

    files_by_path = {str(item.get("path") or ""): str(item.get("content") or "") for item in ordered_files}
    fallback_report["generated_file_count"] = int(assembly_report.get("generated_file_count") or 0)
    fallback_report["fallback_file_count"] = int(assembly_report.get("fallback_file_count") or 0)

    return {
        "success": True,
        "provider": "aws",
        "project_name": project_name,
        "run_id": None,
        "workspace": resolved_workspace,
        "provider_version": DEFAULT_PROVIDER_CONSTRAINT,
        "state_bucket": None,
        "lock_table": None,
        "manifest": manifest,
        "dag_order": dag_order,
        "warnings": all_warnings,
        "files": ordered_files,
        "readme": files_by_path.get("README.md"),
        "source": source,
        "details": {
            "bundle_strategy": str(bundle_plan.get("bundle_strategy") or ""),
            "file_tree": _string_list(bundle_plan.get("file_tree")),
            "workers": worker_details,
            "fallback_report": fallback_report,
            "repo_context_document": repo_context_document,
            "structure_plan": bundle_plan,
            "validation_report": validation_report,
            "assembly_report": assembly_report,
            "compute_strategy": compute_strategy,
            "service_count": service_count,
            "resolved_workspace": resolved_workspace,
            "llm_workers_enabled": terraform_llm_enabled,
            "requested_iac_mode": resolved_iac_mode,
            "llm_provider": str((terraform_llm or {}).get("provider") or "deterministic"),
        },
    }
