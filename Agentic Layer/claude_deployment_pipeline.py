from __future__ import annotations

import json
import os
import sys
from math import ceil
from pathlib import Path
from typing import Any

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
from terraform_agent.agent.engine.deployment_profile import build_profile_bundle
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
MAX_CLAUDE_PIPELINE_COST_USD = float(os.getenv("DEPLAI_CLAUDE_MAX_PIPELINE_COST_USD", "3.0") or "3.0")
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


def _pricing_for_model(model: str) -> tuple[float, float]:
    normalized = str(model or "").strip().lower()
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


def generate_terraform_bundle(
    *,
    architecture_json: dict[str, Any],
    project_name: str,
    workspace: str,
    aws_region: str,
    qa_summary: str = "",
    website_index_html: str = "",
) -> dict[str, Any]:
    profile = parse_deployment_profile(architecture_json)
    files, warnings = build_profile_bundle(
        payload=profile.model_dump(exclude_none=True),
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
    ordered_files.sort(key=lambda item: item["path"])
    return {
        "success": True,
        "provider": "aws",
        "project_name": project_name,
        "run_id": None,
        "workspace": None,
        "provider_version": DEFAULT_PROVIDER_CONSTRAINT,
        "state_bucket": None,
        "lock_table": None,
        "manifest": [],
        "dag_order": [],
        "warnings": ["Generated from Claude deployment planning profile with deterministic Terraform rendering.", *warnings],
        "files": ordered_files,
        "readme": files.get("README.md"),
        "source": "claude_deployment_profile",
    }
