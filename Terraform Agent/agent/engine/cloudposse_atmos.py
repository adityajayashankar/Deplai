from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from .runtime import slugify


SUPPORTED_RENDERERS = {"auto", "cloudposse_atmos", "deplai_deterministic"}
CATALOG_PATH = Path(__file__).resolve().with_name("cloudposse_component_catalog.json")
DEFAULT_SUBNET_TYPE_TAG_KEY = "deplai.io/subnet/type"
GLOBAL_COMPONENT_VARS = {"region", "namespace", "stage", "name", "tags"}
INTERNAL_TRACKING_VARS = {"workspace", "tenant", "secrets_manager_prefix", "required_secret_names"}
COMPONENT_VERSIONS = {
    "vpc": "1.6.0",
    "ec2-instance": "0.47.1",
    "rds": "v1.535.1",
    "elasticache": "v1.535.1",
    "account-map": "v1.535.1",
}
VPC_VERSION_FALLBACK_ORDER = ["1.6.0", "1.5.0", "1.4.0", "1.3.0"]
REGION_AZ_MAP = {
    "eu-north-1": ["eu-north-1a", "eu-north-1b", "eu-north-1c"],
    "us-east-1": ["us-east-1a", "us-east-1b", "us-east-1c"],
    "us-east-2": ["us-east-2a", "us-east-2b", "us-east-2c"],
    "us-west-1": ["us-west-1a", "us-west-1b"],
    "us-west-2": ["us-west-2a", "us-west-2b", "us-west-2c"],
    "ap-south-1": ["ap-south-1a", "ap-south-1b", "ap-south-1c"],
    "ap-southeast-1": ["ap-southeast-1a", "ap-southeast-1b", "ap-southeast-1c"],
    "ap-southeast-2": ["ap-southeast-2a", "ap-southeast-2b", "ap-southeast-2c"],
    "ap-northeast-1": ["ap-northeast-1a", "ap-northeast-1b", "ap-northeast-1c"],
    "eu-west-1": ["eu-west-1a", "eu-west-1b", "eu-west-1c"],
    "eu-west-2": ["eu-west-2a", "eu-west-2b", "eu-west-2c"],
    "eu-central-1": ["eu-central-1a", "eu-central-1b", "eu-central-1c"],
    "ca-central-1": ["ca-central-1a", "ca-central-1b"],
    "sa-east-1": ["sa-east-1a", "sa-east-1b", "sa-east-1c"],
}

# Ubuntu 22.04 LTS AMI IDs by region (Canonical official, updated 2024)
# These are stable AMI IDs that work reliably without data source lookups
UBUNTU_2204_AMI_MAP = {
    "eu-north-1": "ami-0989fb15ce71ba39e",
    "us-east-1": "ami-0261755bbcb8c4a84",
    "us-east-2": "ami-0430580de6244e02e",
    "us-west-1": "ami-04669a22aad391419",
    "us-west-2": "ami-03f65b8614a860c29",
    "eu-west-1": "ami-0694d931cee176e7d",
    "eu-west-2": "ami-0505148b3591e4c07",
    "eu-central-1": "ami-04e601abe3e1a910f",
    "ap-southeast-1": "ami-078c1149d8ad719a7",
    "ap-southeast-2": "ami-0df4b2961410d4cff",
    "ap-northeast-1": "ami-07c589821f2b353aa",
    "ap-south-1": "ami-0f58b397bc5c1f2e8",
    "ca-central-1": "ami-0ea18256de20ecdfc",
    "sa-east-1": "ami-0af6e9042ea5a4e3e",
}

CLOUDPOSSE_NATIVE = [
    "ec2-instance",
    "rds",
    "elasticache",
    "s3-bucket",
    "acm",
    "route53-zone",
    "secrets-manager",
    "cloudwatch-logs",
]
CLOUDPOSSE_COMPONENT_OVERRIDES: dict[str, dict[str, Any]] = {
    "ec2-instance": {
        "source": "github.com/cloudposse/terraform-aws-ec2-instance.git//",
        "version": COMPONENT_VERSIONS["ec2-instance"],
        "append_src": False,
    },
    "rds": {
        "source": "github.com/cloudposse-terraform-components/aws-rds.git",
        "version": COMPONENT_VERSIONS["rds"],
        "append_src": True,
    },
    "elasticache": {
        "source": "github.com/cloudposse-terraform-components/aws-elasticache-redis.git",
        "version": COMPONENT_VERSIONS["elasticache"],
        "append_src": True,
    },
}
COMPONENT_ID_ALIASES = {
    "cloudfront": "s3-bucket",
    "s3_cloudfront": "s3-bucket",
    "ec2_instance": "ec2-instance",
    "ecs": "ec2-instance",
    "ecs-cluster": "ec2-instance",
    "ecs-service": "ec2-instance",
}
DEPLOY_SEQUENCE_ORDER = ["ec2-instance", "rds", "elasticache", "s3-bucket", "acm", "route53-zone", "secrets-manager", "cloudwatch-logs"]
DEFAULT_OUTPUTS_TO_CAPTURE = ["ec2_instance_id", "ec2_public_ip", "ec2_public_dns", "rds_endpoint"]
DECISION_MARKER = "@@DECISION@@"
MAX_CONSULTANT_TURNS = 20


def normalize_terraform_renderer(value: Any) -> str:
    renderer = str(value or "auto").strip().lower()
    return renderer if renderer in SUPPORTED_RENDERERS else "auto"


def load_component_catalog() -> dict[str, Any]:
    payload = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        payload = {}

    raw_components = payload.get("components") if isinstance(payload.get("components"), dict) else {}
    components: dict[str, Any] = {
        str(key): value
        for key, value in raw_components.items()
        if str(key) in set(CLOUDPOSSE_NATIVE)
    }
    for component_id in list(components.keys()):
        pinned_version = COMPONENT_VERSIONS.get(component_id)
        if pinned_version:
            component_entry = _record(components.get(component_id))
            component_entry["version"] = pinned_version
            components[component_id] = component_entry
    for component_id in CLOUDPOSSE_NATIVE:
        override = dict(CLOUDPOSSE_COMPONENT_OVERRIDES.get(component_id) or {})
        existing = _record(components.get(component_id))
        if existing or override:
            components[component_id] = {
                **existing,
                **override,
            }
    payload["components"] = components

    deploy_sequences = payload.get("deploy_sequences") if isinstance(payload.get("deploy_sequences"), dict) else {}
    deploy_sequences["ec2_instance"] = ["ec2-instance", "rds", "elasticache"]
    payload["deploy_sequences"] = deploy_sequences
    return payload


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _string_list(value: Any) -> list[str]:
    return [str(item).strip() for item in _list(value) if str(item).strip()]


def _to_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    normalized = str(value or "").strip().lower()
    if normalized in {"true", "yes", "y", "1"}:
        return True
    if normalized in {"false", "no", "n", "0"}:
        return False
    return bool(default)


def _to_int(value: Any, default: int) -> int:
    try:
        parsed = int(value)
    except Exception:
        return int(default)
    return parsed if parsed > 0 else int(default)


def _normalize_component_id(component_id: str) -> str:
    normalized = str(component_id or "").strip().lower()
    return COMPONENT_ID_ALIASES.get(normalized, normalized)


def _enforce_deploy_sequence_order(sequence: list[str]) -> list[str]:
    deduped: list[str] = []
    seen: set[str] = set()
    for item in sequence:
        normalized = _normalize_component_id(item)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(normalized)

    ordered: list[str] = []
    for required in DEPLOY_SEQUENCE_ORDER:
        if required in deduped:
            ordered.append(required)

    for item in deduped:
        if item not in ordered:
            ordered.append(item)
    return ordered


def get_azs_for_region(region: str) -> list[str]:
    normalized = str(region or "").strip()
    azs = REGION_AZ_MAP.get(normalized)
    if not azs:
        raise ValueError(f"Unknown region: {normalized}. Add it to REGION_AZ_MAP.")
    return [str(item) for item in azs]


def _availability_zones(region: str) -> list[str]:
    return get_azs_for_region(region)


def _resolve_repo_url(payload: dict[str, Any], *, project_slug: str) -> str:
    repository_context = _record(payload.get("repository_context"))
    user_answers = _record(payload.get("user_answers"))
    candidates = [
        payload.get("repo_url"),
        payload.get("repository_url"),
        payload.get("repo_full_name"),
        user_answers.get("repo_url"),
        user_answers.get("repository_url"),
        user_answers.get("repo_full_name"),
        repository_context.get("repo_url"),
        repository_context.get("repository_url"),
        repository_context.get("repo_full_name"),
        repository_context.get("project_name"),
    ]
    for candidate in candidates:
        text = str(candidate or "").strip()
        if not text:
            continue
        if text.startswith("http://") or text.startswith("https://"):
            return text[:-4] if text.endswith(".git") else text
        if re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", text):
            return f"https://github.com/{text}"
    return f"https://github.com/adityajayashankar/{project_slug}"


def _ec2_user_data_template() -> str:
    return (
        "#!/bin/bash\n"
        "set -e\n\n"
        "# System deps\n"
        "apt-get update -y\n"
        "apt-get install -y nodejs npm git curl\n\n"
        "# Install PM2 for process management\n"
        "npm install -g pm2\n\n"
        "# Clone repo\n"
        "cd /opt\n"
        "if [ -d app ]; then rm -rf app; fi\n"
        "git clone \"${repo_url}\" app\n"
        "cd /opt/app\n\n"
        "# Install dependencies\n"
        "npm install\n\n"
        "# Set environment variables\n"
        "cat > /opt/app/.env << 'ENVEOF'\n"
        "NODE_ENV=production\n"
        "PORT=${app_port}\n"
        "DATABASE_URL=${db_endpoint}\n"
        "REDIS_URL=${redis_endpoint}\n"
        "ENVEOF\n\n"
        "# Build Next.js\n"
        "npm run build\n\n"
        "# Start with PM2\n"
        "pm2 start npm --name \"app\" -- start\n"
        "pm2 startup systemd -u root --hp /root\n"
        "pm2 save\n\n"
        "# Health check\n"
        "curl -f http://localhost:${app_port}${health_check_path} || exit 1\n"
    )


def _comment_lines(lines: list[str]) -> str:
    commented: list[str] = []
    for line in lines:
        normalized = str(line or "").strip()
        if not normalized:
            continue
        for part in normalized.splitlines():
            commented.append(f"# {part}".rstrip())
    return "\n".join(commented).strip()


def _build_repo_detection_summary(payload: dict[str, Any], *, aws_region: str) -> str:
    detected = _record(payload.get("detected"))
    repository_context = _record(payload.get("repository_context"))
    deployment_profile = _record(payload.get("deployment_profile")) or payload
    compute = _record(deployment_profile.get("compute"))
    networking = _record(deployment_profile.get("networking"))
    build = _record(repository_context.get("build"))
    frontend = _record(repository_context.get("frontend"))
    health = _record(repository_context.get("health"))
    environment_variables = _record(repository_context.get("environment_variables"))
    frameworks = _list(repository_context.get("frameworks"))
    data_stores = _list(repository_context.get("data_stores")) or _list(deployment_profile.get("data_layer"))
    processes = _list(repository_context.get("processes"))

    framework_names = [str(_record(item).get("name") or "").strip() for item in frameworks if str(_record(item).get("name") or "").strip()]
    datastore_names = [str(_record(item).get("type") or "").strip() for item in data_stores if str(_record(item).get("type") or "").strip()]
    process_names = []
    for item in processes:
        process = _record(item)
        process_type = str(process.get("type") or process.get("process_type") or "").strip()
        command = str(process.get("command") or process.get("source") or "").strip()
        if process_type or command:
            process_names.append(f"{process_type or 'process'}:{command or 'detected'}")

    raw_compute_strategy = str(compute.get("strategy") or "").strip().lower()
    compute_strategy_display = "ec2-instance" if raw_compute_strategy in {"ecs", "ecs_fargate", "ec2", "ec2_instance"} else (raw_compute_strategy or "unknown")

    service_descriptions = []
    for service in _list(compute.get("services")):
        item = _record(service)
        service_id = str(item.get("id") or "service").strip()
        process_type = str(item.get("process_type") or "").strip()
        port = str(item.get("port") or "").strip()
        details = ", ".join([value for value in [process_type, f"port {port}" if port else ""] if value])
        service_descriptions.append(f"{service_id} ({details})" if details else service_id)

    lines = [
        f"Workspace: {str(payload.get('workspace') or repository_context.get('workspace') or '').strip() or 'unknown'}",
        f"AWS region target: {aws_region or 'unknown'}",
        f"Repository summary: {str(repository_context.get('summary') or payload.get('qa_summary') or '').strip() or 'not available'}",
        f"Primary language/runtime: {str(_record(repository_context.get('language')).get('runtime') or _record(repository_context.get('language')).get('primary') or detected.get('language') or 'unknown')}",
        f"Frameworks: {', '.join(framework_names) if framework_names else str(detected.get('framework') or 'unknown')}",
        f"Compute strategy: {compute_strategy_display}",
        f"Services: {', '.join(service_descriptions) if service_descriptions else 'none detected'}",
        f"Data stores: {', '.join(datastore_names) if datastore_names else str(detected.get('database_type') or 'none detected')}",
        f"Processes: {' | '.join(process_names) if process_names else 'none detected'}",
        f"Has database: {str(bool(detected.get('has_database'))).lower()}",
        f"Has Redis: {str(bool(detected.get('has_redis'))).lower()}",
        f"Has queue: {str(bool(detected.get('has_queue'))).lower()}",
        f"Has web server: {str(bool(detected.get('has_web_server'))).lower()}",
        f"Has workers: {str(bool(detected.get('has_workers'))).lower()}",
        f"Has static assets: {str(bool(detected.get('has_static_assets'))).lower()}",
        f"Has Dockerfile: {str(bool(detected.get('has_dockerfile') or build.get('has_dockerfile'))).lower()}",
        f"Frontend static candidate: {str(bool(frontend.get('static_site_candidate'))).lower()}",
        f"Build command: {str(build.get('build_command') or '').strip() or 'not detected'}",
        f"Start command: {str(build.get('start_command') or '').strip() or 'not detected'}",
        f"Health endpoint: {str(health.get('endpoint') or '').strip() or 'not detected'}",
        f"Required secrets: {', '.join(_string_list(environment_variables.get('required_secrets'))) or 'none detected'}",
    ]
    return "\n".join(lines)


def _consultant_system_prompt(repo_detection_summary: str) -> str:
    return (
        "You are a senior AWS infrastructure consultant reviewing a deployment request. You have already analyzed the user's repo and know:\n\n"
        f"{repo_detection_summary}\n\n"
        "Your job is to have a CONVERSATION with the user to gather everything needed to deploy their app to production on AWS with zero issues.\n\n"
        "Rules you follow:\n\n"
        "QUESTIONING:\n"
        "- Treat the analyzer summary above as the source of truth for detected repo signals\n"
        "- Ask only what you cannot infer from the analyzer summary or the user's prior answers\n"
        "- Do not re-ask fields that are already present in analyzer output unless user input conflicts with them\n"
        "- Ask ONE question at a time, never a list\n"
        "- Follow up on vague answers - \"a lot of users\" is not useful\n"
        "- If an answer changes your understanding, ask a follow-up\n"
        "- Ask about things that will affect cost, reliability, or security\n\n"
        "SUGGESTIVE:\n"
        "- If you spot something the user hasn't mentioned that will matter, bring it up even if they didn't ask\n"
        "- Examples:\n"
        "  * \"Analyzer did not detect a Dockerfile. I can proceed with a standard runtime container assumption and flag it in notes.\"\n"
        "  * \"You said single region - your DB will have no failover. For a paid product that's a risk. Want multi-AZ for +$50/mo?\"\n"
        "  * \"You're using JWT but I don't see secret rotation - want me to add Secrets Manager for that?\"\n\n"
        "ASSUMPTIONS:\n"
        "- Do not block component planning on Dockerfile or process entrypoint details\n"
        "- If start/build command is missing, proceed with a best-guess deployment decision and capture assumptions in consultant_notes\n"
        "- Ask about start command at most once, and only if absolutely required for runtime packaging details\n"
        "- If user asks you to assume or proceed, do so immediately and output a decision with explicit assumptions\n"
        "- Never claim file-level certainty like \"I don't see any Python files\"; reference analyzer output instead\n\n"
        "CRITICAL:\n"
        "- If a user's answer will lead to a bad deployment, say so directly\n"
        "- Do not just accept bad inputs to be polite\n"
        "- Examples of when to push back:\n"
        "  * User says \"no backups needed\" for a production DB -> tell them why that's dangerous, ask if they're sure\n"
        "  * User says \"1 instance is fine\" for a web app -> explain single point of failure, offer the minimum HA setup\n"
        "  * User says \"make it as cheap as possible\" for an app that requires high availability -> tell them the tradeoff explicitly\n"
        "  * User sets a very low max CPU/memory -> warn them about OOM kills\n"
        "  * User wants to skip staging -> flag deployment risk, ask if sure\n"
        "  * User picks a region far from their users -> flag latency impact\n\n"
        "ADAPTIVE:\n"
        "- Change your line of questioning based on answers\n"
        "- If user says \"this is internal tooling for 20 people\" -> stop asking about CDN, WAF, multi-region. Ask about VPN/SSO instead.\n"
        "- If user says \"this is a consumer fintech app\" -> ask about compliance, encryption at rest, audit logs, WAF\n"
        "- If user says \"we already have a VPC\" -> ask for the VPC ID and stop generating a new one\n"
        "- If user says \"we use RDS already\" -> ask if they want to connect to existing or create new\n\n"
        "RENDERER CONSTRAINTS (CRITICAL):\n"
        "- This system outputs Cloud Posse Atmos component decisions, not raw Terraform resources\n"
        "- Allowed component ids are ONLY: vpc, ec2-instance, rds, elasticache\n"
        "- Never output aws_instance/aws_vpc/aws_subnet/aws_security_group-style resources\n"
        "- ECS Fargate is NOT offered in this catalog\n"
        "- For compute, always choose ec2-instance when the app is non-containerized or user explicitly asks for EC2\n\n"
        "COMPONENT CATALOG:\n"
        "COMPUTE OPTIONS:\n"
        "- ec2-instance: Single or multi-instance EC2 setup\n"
        "  Use for traditional apps, full host-level control, non-containerized repos, or explicit EC2 requests\n"
        "NETWORKING:\n"
        "- vpc: Always included\n"
        "DATA:\n"
        "- rds: PostgreSQL, MySQL, Aurora\n"
        "- elasticache: Redis, Memcached\n\n"
        "INSTANCE SIZING QUESTION:\n"
        "- Ask this exactly when compute sizing is not already provided:\n"
        "  \"What instance type do you need?\n"
        "   t3.micro (1 vCPU, 1GB) - dev/testing\n"
        "   t3.small (2 vCPU, 2GB) - small prod\n"
        "   t3.medium (2 vCPU, 4GB) - medium prod\n"
        "   t3.large (2 vCPU, 8GB) - large prod\"\n\n"
        "TERMINATION:\n"
        "- When you have enough to make a complete, unambiguous component decision, end the conversation by outputting EXACTLY this:\n\n"
        f"  {DECISION_MARKER}\n"
        "  {\n"
        "    \"components\": [...],\n"
        "    \"deploy_sequence\": [...],\n"
        "    \"stack_config\": { ... },\n"
        "    \"outputs_to_capture\": [...],\n"
        "    \"consultant_notes\": [\n"
        "      \"Enabled multi-AZ because user confirmed production traffic\",\n"
        "      \"Added WAF because app handles payments\",\n"
        "      \"Skipped CloudFront because app is internal\"\n"
        "    ]\n"
        "  }\n"
        f"  {DECISION_MARKER}\n\n"
        "- consultant_notes must explain every non-obvious decision you made\n"
        "- Output must be STRICT JSON only (double quotes, no comments, no trailing commas, no markdown)\n"
        "- Do not output @@DECISION@@ until you are confident the config is complete and safe for production deployment\n"
        "- If something is ambiguous and will affect the deploy, ask - do not guess and silently note it\n\n"
        "SPECIAL CASES:\n"
        "- If the user says \"skip\", output the best-guess decision now and flag every assumption or gap in consultant_notes\n"
        "- If the user says \"explain\", explain briefly why the current question matters, then continue the conversation\n"
        "- If the user challenges repeated questioning, stop repeating and output the best-guess decision now with assumptions\n"
        "- If you are told you already have enough context, output the decision now\n\n"
        "TONE:\n"
        "- Direct, not formal\n"
        "- Say \"this will break\" not \"this may present challenges\"\n"
        "- Say \"bad idea because X, here's the better option\" not \"you might want to consider\"\n"
        "- Short messages - no paragraphs unless explaining a tradeoff"
    )


def _extract_marked_decision(content: str) -> tuple[str, dict[str, Any]]:
    text = str(content or "")
    match = re.search(rf"{re.escape(DECISION_MARKER)}\s*(\{{.*\}})\s*{re.escape(DECISION_MARKER)}", text, flags=re.DOTALL)
    if not match:
        return text.strip(), {}
    decision_text = match.group(1).strip()
    cleaned = (text[:match.start()] + text[match.end():]).strip()

    def _parse_json_blob(blob: str) -> dict[str, Any]:
        try:
            parsed = json.loads(blob)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            pass

        # Recovery path for common LLM slips: inline comments and trailing commas.
        sanitized = re.sub(r"//.*?$", "", blob, flags=re.MULTILINE)
        sanitized = re.sub(r",\s*([}\]])", r"\1", sanitized)
        try:
            parsed = json.loads(sanitized)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}

    decision = _parse_json_blob(decision_text)
    if not decision:
        return text.strip(), {}
    return cleaned, decision


def _should_force_best_guess_decision(conversation_history: list[dict[str, str]] | None) -> bool:
    history = conversation_history or []
    if not history:
        return False

    user_messages = [str(item.get("content") or "").strip().lower() for item in history if str(item.get("role") or "").strip().lower() == "user"]
    assistant_messages = [str(item.get("content") or "").strip().lower() for item in history if str(item.get("role") or "").strip().lower() == "assistant"]
    if not user_messages:
        return False

    latest_user = user_messages[-1]
    proceed_markers = [
        "skip",
        "assume",
        "self inspect",
        "is it that important",
        "why do u need",
        "why do you need",
        "repo analyzer",
        "already covered",
        "just proceed",
        "continue anyway",
    ]
    if any(marker in latest_user for marker in proceed_markers):
        return True

    loop_markers = [
        "start command",
        "entry point",
        "main python",
        "dockerfile",
        "what command runs",
    ]
    repeated_loop_questions = sum(1 for text in assistant_messages[-4:] if any(marker in text for marker in loop_markers))
    return repeated_loop_questions >= 2


def consultant_conversation_turn(
    payload: dict[str, Any],
    *,
    aws_region: str,
    conversation_history: list[dict[str, str]] | None = None,
    turn_count: int = 0,
    force_decision: bool = False,
) -> dict[str, Any]:
    try:
        from models.llm_config import chat_text, has_llm_credentials  # type: ignore
    except Exception:
        try:
            from terraform_agent.agent.models.llm_config import chat_text, has_llm_credentials  # type: ignore
        except Exception:
            return {"success": False, "error": "Infra consultant LLM helpers are unavailable."}

    if not has_llm_credentials():
        return {"success": False, "error": "Infra consultant requires a configured LLM backend."}

    repo_detection_summary = _build_repo_detection_summary(payload, aws_region=aws_region)
    system_prompt = _consultant_system_prompt(repo_detection_summary)
    messages: list[dict[str, str]] = []
    for item in conversation_history or []:
        role = str(item.get("role") or "").strip().lower()
        content = str(item.get("content") or "").strip()
        if role in {"user", "assistant"} and content:
            messages.append({"role": role, "content": content})
    effective_turn_count = max(0, int(turn_count or 0))
    auto_force_best_guess = _should_force_best_guess_decision(conversation_history)
    if force_decision or auto_force_best_guess or effective_turn_count >= MAX_CONSULTANT_TURNS:
        if auto_force_best_guess and not force_decision:
            messages.append(
                {
                    "role": "user",
                    "content": "Use repository analyzer context, proceed with best-guess assumptions, and output your decision now. Record every assumption in consultant_notes.",
                }
            )
        messages.append({"role": "user", "content": "You have enough context. Output your decision now."})
    response_text = chat_text(system_prompt=system_prompt, messages=messages, temperature=0.2)
    if not response_text:
        return {"success": False, "error": "Infra consultant returned an empty response."}

    assistant_message, decision = _extract_marked_decision(response_text)
    result: dict[str, Any] = {
        "success": True,
        "assistant_message": assistant_message,
        "ready": False,
        "repo_detection_summary": repo_detection_summary,
        "turn_count": effective_turn_count + 1,
    }
    if decision:
        normalized = _normalize_component_decision(decision, catalog=load_component_catalog(), aws_region=aws_region)
        if normalized.get("deploy_sequence"):
            result["ready"] = True
            result["decision"] = normalized
    return result


def _llm_component_decision(input_payload: dict[str, Any]) -> dict[str, Any]:
    if not any(str(os.getenv(name, "")).strip() for name in ("OPENAI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "CLAUDE_API_KEY", "XAI_API_KEY")):
        return {}
    try:
        from models.llm_config import chat_json  # type: ignore
    except Exception:
        try:
            from terraform_agent.agent.models.llm_config import chat_json  # type: ignore
        except Exception:
            return {}

    system_prompt = (
        "You are selecting Cloud Posse Atmos components. "
        "Return ONLY JSON with keys components, deploy_sequence, stack_config, outputs_to_capture. "
        "deploy_sequence must follow vpc -> ec2-instance -> (rds, elasticache). "
        "Do not include prose."
    )
    user_prompt = json.dumps(input_payload, ensure_ascii=True)
    result = chat_json(system_prompt, user_prompt)
    return result if isinstance(result, dict) else {}


def _fallback_component_decision(payload: dict[str, Any], *, aws_region: str) -> dict[str, Any]:
    compute = _record(payload.get("compute"))
    strategy = str(compute.get("strategy") or "").strip().lower()
    data_layer = [_record(item) for item in _list(payload.get("data_layer"))]
    detected = _record(payload.get("detected"))
    user_answers = _record(payload.get("user_answers"))
    repository_context = _record(payload.get("repository_context"))
    compute_services = [_record(item) for item in _list(compute.get("services"))]
    primary_service = compute_services[0] if compute_services else {}
    app_port = _to_int(primary_service.get("port") or user_answers.get("app_port"), 3000)
    health_check_path = str(_record(repository_context.get("health")).get("endpoint") or user_answers.get("health_check_path") or "/status").strip() or "/status"
    if not health_check_path.startswith("/"):
        health_check_path = f"/{health_check_path}"
    project_slug = slugify(str(payload.get("project_name") or payload.get("workspace") or "ifca-"), "ifca-")
    repo_url = _resolve_repo_url(payload, project_slug=project_slug)

    has_rds = any(str(item.get("type") or "").strip().lower() in {"postgresql", "postgres", "mysql", "mariadb"} for item in data_layer)
    has_redis = any(str(item.get("type") or "").strip().lower() == "redis" for item in data_layer)

    if detected:
        has_rds = _to_bool(detected.get("has_database"), has_rds)
        has_redis = _to_bool(detected.get("has_redis"), has_redis)

    if strategy == "s3_cloudfront":
        strategy = "ec2-instance"

    requested_instance_type = str(
        user_answers.get("instance_type")
        or user_answers.get("ec2_instance_type")
        or user_answers.get("compute_instance_type")
        or "t3.micro"
    ).strip().lower() or "t3.micro"
    if requested_instance_type not in {"t3.micro", "t3.small", "t3.medium", "t3.large"}:
        requested_instance_type = "t3.micro"

    components = ["ec2-instance"]
    if has_rds:
        components.append("rds")
    if has_redis:
        components.append("elasticache")

    decision = {
        "components": components,
        "deploy_sequence": components,
        "stack_config": {
            "ec2-instance": {
                "instance_type": requested_instance_type,
                "security_group_rules": [
                    {
                        "type": "ingress",
                        "from_port": 80,
                        "to_port": 80,
                        "protocol": "tcp",
                        "cidr_blocks": ["0.0.0.0/0"],
                    },
                    {
                        "type": "ingress",
                        "from_port": 443,
                        "to_port": 443,
                        "protocol": "tcp",
                        "cidr_blocks": ["0.0.0.0/0"],
                    },
                    {
                        "type": "ingress",
                        "from_port": 22,
                        "to_port": 22,
                        "protocol": "tcp",
                        "cidr_blocks": ["0.0.0.0/0"],
                    },
                    {
                        "type": "egress",
                        "from_port": 0,
                        "to_port": 0,
                        "protocol": "-1",
                        "cidr_blocks": ["0.0.0.0/0"],
                    },
                ],
            },
        },
        "outputs_to_capture": list(DEFAULT_OUTPUTS_TO_CAPTURE),
    }

    if has_rds:
        decision["stack_config"]["rds"] = {
            "instance_class": "db.t3.micro",
            "engine": "postgres",
            "engine_version": "15.3",
            "multi_az": False,
            "backup_retention_period": 7,
            "deletion_protection": False,
            "publicly_accessible": False,
            "vpc_id": "!terraform_remote_state vpc.vpc_id",
            "subnet_ids": "!terraform_remote_state vpc.private_subnets",
        }

    if has_redis:
        decision["stack_config"]["elasticache"] = {
            "engine": "redis",
            "node_type": "cache.t4g.micro",
            "vpc_id": "!terraform_remote_state vpc.vpc_id",
            "subnet_ids": "!terraform_remote_state vpc.private_subnets",
        }

    return decision


def _normalize_component_decision(
    decision: dict[str, Any],
    *,
    catalog: dict[str, Any],
    aws_region: str,
) -> dict[str, Any]:
    raw_components = _string_list(decision.get("components"))
    raw_sequence = _string_list(decision.get("deploy_sequence"))
    stack_config = _record(decision.get("stack_config"))
    outputs_to_capture = _string_list(decision.get("outputs_to_capture")) or list(DEFAULT_OUTPUTS_TO_CAPTURE)
    consultant_notes = _string_list(decision.get("consultant_notes"))

    if not raw_components and raw_sequence:
        raw_components = [*raw_sequence]
    if not raw_sequence and raw_components:
        raw_sequence = [*raw_components]

    sequence = _enforce_deploy_sequence_order(raw_sequence)
    components = _enforce_deploy_sequence_order(raw_components)

    if not sequence:
        sequence = _enforce_deploy_sequence_order([*components])
    if not components:
        components = _enforce_deploy_sequence_order([*sequence])

    supported_components = set(CLOUDPOSSE_NATIVE)
    components = [item for item in components if item in supported_components]
    sequence = [item for item in sequence if item in supported_components]
    if not sequence:
        sequence = [item for item in components if item in supported_components]

    if "vpc" in components and "vpc" not in stack_config:
        stack_config["vpc"] = {
            "cidr_block": "10.0.0.0/16",
            "availability_zones": _default_region_availability_zones(aws_region),
            "nat_gateway_enabled": False,
            "nat_instance_enabled": False,
            "nat_instance_type": "t3.micro",
            "map_public_ip_on_launch": True,
        }
    if "ec2-instance" in components and "ec2-instance" not in stack_config:
        stack_config["ec2-instance"] = {
            "instance_type": "t3.micro",
            "security_group_rules": [
                {
                    "type": "ingress",
                    "from_port": 80,
                    "to_port": 80,
                    "protocol": "tcp",
                    "cidr_blocks": ["0.0.0.0/0"],
                },
                {
                    "type": "ingress",
                    "from_port": 443,
                    "to_port": 443,
                    "protocol": "tcp",
                    "cidr_blocks": ["0.0.0.0/0"],
                },
                {
                    "type": "ingress",
                    "from_port": 22,
                    "to_port": 22,
                    "protocol": "tcp",
                    "cidr_blocks": ["0.0.0.0/0"],
                },
                {
                    "type": "egress",
                    "from_port": 0,
                    "to_port": 0,
                    "protocol": "-1",
                    "cidr_blocks": ["0.0.0.0/0"],
                },
            ],
        }
    if "rds" in components and "rds" not in stack_config:
        stack_config["rds"] = {
            "engine": "postgres",
            "engine_version": "15.3",
            "instance_class": "db.t3.micro",
            "multi_az": False,
            "deletion_protection": False,
            "backup_retention_period": 7,
            "publicly_accessible": False,
            "vpc_id": "!terraform_remote_state vpc.vpc_id",
            "subnet_ids": "!terraform_remote_state vpc.private_subnets",
        }
    if "elasticache" in components and "elasticache" not in stack_config:
        stack_config["elasticache"] = {
            "engine": "redis",
            "node_type": "cache.t4g.micro",
            "vpc_id": "!terraform_remote_state vpc.vpc_id",
            "subnet_ids": "!terraform_remote_state vpc.private_subnets",
        }

    return {
        "components": components,
        "deploy_sequence": sequence,
        "stack_config": stack_config,
        "outputs_to_capture": outputs_to_capture,
        "consultant_notes": consultant_notes,
    }


def _resolve_component_decision(
    payload: dict[str, Any],
    *,
    catalog: dict[str, Any],
    aws_region: str,
) -> tuple[dict[str, Any], str]:
    direct_decision = _record(payload.get("consultant_decision")) or _record(payload.get("component_decision"))
    if direct_decision:
        normalized = _normalize_component_decision(direct_decision, catalog=catalog, aws_region=aws_region)
        if normalized.get("deploy_sequence"):
            return normalized, "consultant"

    llm_input = {
        "detected": _record(payload.get("detected")),
        "user_answers": _record(payload.get("user_answers")),
    }
    llm_decision = _llm_component_decision(llm_input)
    if llm_decision:
        normalized = _normalize_component_decision(llm_decision, catalog=catalog, aws_region=aws_region)
        if normalized.get("deploy_sequence"):
            return normalized, "llm"

    fallback = _fallback_component_decision(payload, aws_region=aws_region)
    normalized = _normalize_component_decision(fallback, catalog=catalog, aws_region=aws_region)
    return normalized, "fallback"


def _has_prior_non_cloudposse_state(payload: dict[str, Any]) -> bool:
    marker = str(
        payload.get("prior_renderer")
        or payload.get("previous_renderer")
        or payload.get("existing_renderer")
        or ""
    ).strip().lower()
    if marker and marker not in {"cloudposse_atmos", "none", "new"}:
        return True
    if bool(payload.get("has_existing_terraform_state")) or bool(payload.get("existing_deployment")):
        return marker != "cloudposse_atmos"
    return False


def classify_cloudposse_support(
    payload: dict[str, Any],
    *,
    workspace_has_prior_state: bool = False,
    aws_region: str = "us-east-1",
) -> dict[str, Any]:
    reasons: list[str] = []
    if not isinstance(payload, dict):
        return {"supported": False, "reasons": ["deployment_profile must be an object"], "deploy_sequence": []}
    if str(payload.get("document_kind") or "").strip() != "deployment_profile":
        reasons.append("cloudposse_atmos only supports deployment_profile input")
    if str(payload.get("provider") or "aws").strip().lower() != "aws":
        reasons.append("cloudposse_atmos only supports AWS deployment profiles")
    if workspace_has_prior_state or _has_prior_non_cloudposse_state(payload):
        reasons.append("existing non-Cloud-Posse workspace state is not migrated in V1")

    compute = _record(payload.get("compute"))
    strategy = str(compute.get("strategy") or "").strip().lower()
    if strategy in {"", "ecs_fargate", "ecs", "ec2", "ec2_instance", "ec2-instance"}:
        strategy = "ec2-instance"
    else:
        reasons.append(f"unsupported compute.strategy '{strategy or 'missing'}'")

    networking = _record(payload.get("networking"))
    allowed_networking_keys = {"vpc", "load_balancer", "nat_gateway", "layout", "ports_exposed"}
    unknown_networking = sorted(set(networking) - allowed_networking_keys)
    if unknown_networking:
        reasons.append(f"unsupported networking fields: {', '.join(unknown_networking)}")
    lb = _record(networking.get("load_balancer"))
    unknown_lb = sorted(set(lb) - {"public"})
    if unknown_lb:
        reasons.append(f"unsupported load_balancer fields: {', '.join(unknown_lb)}")

    for item in _list(payload.get("data_layer")):
        data = _record(item)
        data_type = str(data.get("type") or "").strip()
        if data_type not in {"postgresql", "postgres", "mysql", "mariadb", "aurora", "redis"}:
            reasons.append(f"unsupported data_layer type '{data_type or 'missing'}'")

    dns_tls = _record(payload.get("dns_and_tls"))
    if any(str(v or "").strip() for v in dns_tls.values()):
        reasons.append("custom dns_and_tls is not supported in Cloud Posse V1")
    compliance = _record(payload.get("compliance"))
    unknown_compliance = sorted(set(compliance) - {"requirements", "encryption_at_rest", "encryption_in_transit"})
    if unknown_compliance:
        reasons.append(f"custom compliance fields are not supported in Cloud Posse V1: {', '.join(unknown_compliance)}")

    catalog = load_component_catalog()
    decision, decision_source = _resolve_component_decision(payload, catalog=catalog, aws_region=aws_region)
    deploy_sequence = _string_list(decision.get("deploy_sequence"))
    selected_components = _string_list(decision.get("components"))
    stack_config = _record(decision.get("stack_config"))
    outputs_to_capture = _string_list(decision.get("outputs_to_capture")) or list(DEFAULT_OUTPUTS_TO_CAPTURE)
    consultant_notes = _string_list(decision.get("consultant_notes"))

    deploy_sequence = _enforce_deploy_sequence_order(deploy_sequence)
    if not selected_components:
        selected_components = _enforce_deploy_sequence_order([*deploy_sequence])
    catalog_components = _record(catalog.get("components"))
    catalog_component_ids = {str(component_id) for component_id in catalog_components.keys()}

    decision_candidates = _enforce_deploy_sequence_order([*deploy_sequence, *selected_components])
    omitted_components = [component for component in decision_candidates if component not in catalog_component_ids]

    deploy_sequence = [component for component in deploy_sequence if component in catalog_component_ids]
    selected_components = [component for component in selected_components if component in catalog_component_ids]
    if not selected_components:
        selected_components = _enforce_deploy_sequence_order([*deploy_sequence])
    if not deploy_sequence and selected_components:
        deploy_sequence = _enforce_deploy_sequence_order([*selected_components])

    if not deploy_sequence:
        deploy_sequence = [component for component in ["vpc", "ec2-instance", "rds", "elasticache"] if component in catalog_component_ids]
    if not selected_components:
        selected_components = [*deploy_sequence]
    if not deploy_sequence:
        reasons.append("component catalog has no deployable components for the requested decision")

    stack_config = {
        str(component_id): component_config
        for component_id, component_config in stack_config.items()
        if str(component_id) in catalog_component_ids
    }

    return {
        "supported": not reasons,
        "reasons": reasons,
        "deploy_sequence": deploy_sequence,
        "components": selected_components,
        "stack_config": stack_config,
        "outputs_to_capture": outputs_to_capture,
        "consultant_notes": consultant_notes,
        "omitted_components": omitted_components,
        "decision_source": decision_source,
    }


def should_use_cloudposse_renderer(
    payload: dict[str, Any],
    requested_renderer: str,
    *,
    workspace_has_prior_state: bool = False,
) -> tuple[bool, dict[str, Any]]:
    renderer = normalize_terraform_renderer(requested_renderer)
    support = classify_cloudposse_support(payload, workspace_has_prior_state=workspace_has_prior_state)
    if renderer == "deplai_deterministic":
        return False, support
    if renderer == "cloudposse_atmos":
        return bool(support["supported"]), support
    return bool(support["supported"]), support


def _json_yaml(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=False) + "\n"


def _deep_copy(value: Any) -> Any:
    return json.loads(json.dumps(value))


def _yaml_scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value)
    if text == "":
        return '""'
    if text.startswith("!terraform_remote_state ") or text.startswith("!terraform "):
        return text
    if re.fullmatch(r"[A-Za-z0-9_./:@\-]+", text):
        return text
    return json.dumps(text)


def _yaml_lines(value: Any, *, indent: int = 0) -> list[str]:
    space = " " * indent
    if isinstance(value, dict):
        if not value:
            return [f"{space}{{}}"]
        lines: list[str] = []
        for key, child in value.items():
            key_text = str(key)
            if isinstance(child, dict):
                if not child:
                    lines.append(f"{space}{key_text}: {{}}")
                else:
                    lines.append(f"{space}{key_text}:")
                    lines.extend(_yaml_lines(child, indent=indent + 2))
                continue
            if isinstance(child, list):
                if not child:
                    lines.append(f"{space}{key_text}: []")
                else:
                    lines.append(f"{space}{key_text}:")
                    lines.extend(_yaml_lines(child, indent=indent + 2))
                continue
            lines.append(f"{space}{key_text}: {_yaml_scalar(child)}")
        return lines

    if isinstance(value, list):
        if not value:
            return [f"{space}[]"]
        lines = []
        for child in value:
            if isinstance(child, dict):
                if not child:
                    lines.append(f"{space}- {{}}")
                    continue
                lines.append(f"{space}-")
                lines.extend(_yaml_lines(child, indent=indent + 2))
                continue
            if isinstance(child, list):
                if not child:
                    lines.append(f"{space}- []")
                    continue
                lines.append(f"{space}-")
                lines.extend(_yaml_lines(child, indent=indent + 2))
                continue
            lines.append(f"{space}- {_yaml_scalar(child)}")
        return lines

    return [f"{space}{_yaml_scalar(value)}"]


def _component_note_matches(component_id: str, note: str) -> bool:
    component = str(component_id or "").strip().lower()
    normalized_note = str(note or "").strip().lower()
    if not component or not normalized_note:
        return False
    aliases = {
        component,
        component.replace("_", " "),
        component.replace("-", " "),
    }
    if component == "s3_cloudfront":
        aliases.update({"cloudfront", "s3"})
    if component == "s3-bucket":
        aliases.update({"bucket", "s3"})
    if component == "elasticache":
        aliases.update({"redis", "cache"})
    if component == "ec2-instance":
        aliases.update({"ec2", "instance"})
    return any(alias in normalized_note for alias in aliases)


def _notes_for_component(component_id: str, consultant_notes: list[str]) -> list[str]:
    matched = [note for note in consultant_notes if _component_note_matches(component_id, note)]
    if matched:
        return matched
    return consultant_notes[:1]


def _render_stack_yaml_with_consultant_notes(
    *,
    stack_payload: dict[str, Any],
    consultant_notes: list[str],
) -> str:
    lines: list[str] = []

    imports = list(stack_payload.get("import") or [])
    lines.append("import:")
    lines.extend(_yaml_lines(imports, indent=2) if imports else ["  []"])

    vars_payload = _record(stack_payload.get("vars"))
    lines.append("vars:")
    lines.extend(_yaml_lines(vars_payload, indent=2) if vars_payload else ["  {}"])

    components_payload = _record(_record(stack_payload.get("components")).get("terraform"))
    lines.append("components:")
    lines.append("  terraform:")
    for component_id, payload in components_payload.items():
        component_payload = _record(payload)
        metadata_payload = _record(component_payload.get("metadata"))
        settings_payload = _record(component_payload.get("settings"))
        vars_component_payload = _record(component_payload.get("vars"))
        lines.append(f"    {component_id}:")
        lines.append("      metadata:")
        lines.extend(_yaml_lines(metadata_payload, indent=8) if metadata_payload else ["        {}"])
        if settings_payload:
            lines.append("      settings:")
            lines.extend(_yaml_lines(settings_payload, indent=8))
        lines.append("      vars:")
        notes = _notes_for_component(component_id, consultant_notes)
        for note in notes:
            lines.append(f"        # Consultant: {note}")
        lines.extend(_yaml_lines(vars_component_payload, indent=8) if vars_component_payload else ["        {}"])

    return "\n".join(lines) + "\n"


def _values_match(expected: Any, got: Any) -> bool:
    if isinstance(expected, bool) and isinstance(got, bool):
        return expected == got
    if isinstance(expected, (int, float)) and isinstance(got, (int, float)):
        return float(expected) == float(got)
    if isinstance(expected, list) and isinstance(got, list):
        if len(expected) != len(got):
            return False
        return all(_values_match(exp, actual) for exp, actual in zip(expected, got))
    if isinstance(expected, dict) and isinstance(got, dict):
        expected_map = _record(expected)
        got_map = _record(got)
        if set(expected_map.keys()) != set(got_map.keys()):
            return False
        for key in expected_map:
            if not _values_match(expected_map.get(key), got_map.get(key)):
                return False
        return True
    return str(expected) == str(got)


def _resolved_expected_drift_value(expected_value: Any, actual_value: Any) -> Any:
    if expected_value is None:
        return actual_value
    if isinstance(expected_value, str):
        normalized = expected_value.strip().lower()
        if not normalized:
            return actual_value
        placeholder_markers = (
            "your-",
            "<your",
            "<repo",
            "example",
            "changeme",
            "placeholder",
            "todo",
        )
        if any(marker in normalized for marker in placeholder_markers):
            return actual_value
    return expected_value


def _collect_decision_drift(
    *,
    consultant_components: list[str],
    consultant_stack_config: dict[str, Any],
    rendered_components: dict[str, Any],
) -> list[dict[str, Any]]:
    drift: list[dict[str, Any]] = []
    for component_id in consultant_components:
        expected_vars = _record(consultant_stack_config.get(component_id))
        if not expected_vars:
            continue
        rendered_component = _record(rendered_components.get(component_id))
        rendered_vars = _record(rendered_component.get("vars"))
        if not rendered_vars:
            drift.append({
                "component": component_id,
                "key": "<component>",
                "expected": expected_vars,
                "got": None,
            })
            continue
        for key, expected_value_raw in expected_vars.items():
            got_value = rendered_vars.get(key)
            expected_value = _resolved_expected_drift_value(expected_value_raw, got_value)
            if not _values_match(expected_value, got_value):
                drift.append({
                    "component": component_id,
                    "key": str(key),
                    "expected": expected_value,
                    "got": got_value,
                })
    return drift


def _collect_decision_alignment_drift(
    *,
    consultant_decision_payload: dict[str, Any],
    generated_components: list[str],
    generated_deploy_sequence: list[str],
    rendered_components: dict[str, Any],
    aws_region: str,
) -> list[dict[str, Any]]:
    if not consultant_decision_payload:
        return []

    drift: list[dict[str, Any]] = []
    consultant_components = _enforce_deploy_sequence_order(_string_list(consultant_decision_payload.get("components")))
    consultant_sequence = _enforce_deploy_sequence_order(_string_list(consultant_decision_payload.get("deploy_sequence")))
    consultant_stack_config = _record(consultant_decision_payload.get("stack_config"))

    if not consultant_components:
        drift.append({
            "component": "<decision>",
            "key": "components",
            "expected": "non-empty list",
            "got": consultant_components,
        })
    elif consultant_components != generated_components:
        drift.append({
            "component": "<decision>",
            "key": "components",
            "expected": consultant_components,
            "got": generated_components,
        })

    if not consultant_sequence:
        drift.append({
            "component": "<decision>",
            "key": "deploy_sequence",
            "expected": "non-empty list",
            "got": consultant_sequence,
        })
    elif consultant_sequence != generated_deploy_sequence:
        drift.append({
            "component": "<decision>",
            "key": "deploy_sequence",
            "expected": consultant_sequence,
            "got": generated_deploy_sequence,
        })

    vpc_cfg = _record(consultant_stack_config.get("vpc"))
    region_expected = str(
        consultant_decision_payload.get("aws_region")
        or consultant_decision_payload.get("region")
        or vpc_cfg.get("region")
        or aws_region
    ).strip()
    if region_expected != str(aws_region or "").strip():
        drift.append({
            "component": "<decision>",
            "key": "region",
            "expected": region_expected,
            "got": aws_region,
        })

    for component_id, key in (("ec2-instance", "instance_type"), ("rds", "instance_class"), ("elasticache", "node_type")):
        expected_value_raw = _record(consultant_stack_config.get(component_id)).get(key)
        if expected_value_raw is None or (isinstance(expected_value_raw, str) and not expected_value_raw.strip()):
            if component_id == "ec2-instance" and component_id in consultant_components:
                drift.append({
                    "component": component_id,
                    "key": key,
                    "expected": "non-empty value",
                    "got": expected_value_raw,
                })
            continue
        rendered_component = _record(rendered_components.get(component_id))
        rendered_vars = _record(rendered_component.get("vars"))
        got_value = rendered_vars.get(key)
        expected_value = _resolved_expected_drift_value(expected_value_raw, got_value)
        if not _values_match(expected_value, got_value):
            drift.append({
                "component": component_id,
                "key": key,
                "expected": expected_value,
                "got": got_value,
            })

    drift.extend(
        _collect_decision_drift(
            consultant_components=consultant_components,
            consultant_stack_config=consultant_stack_config,
            rendered_components=rendered_components,
        )
    )
    return drift


def _component_ref(component_id: str, catalog: dict[str, Any]) -> dict[str, str]:
    component = dict(catalog.get("components", {}).get(component_id) or {})
    source = str(component.get("source") or "").strip()
    version = str(component.get("version") or "").strip()
    append_src = bool(component.get("append_src", source.startswith("github.com/cloudposse-terraform-components/")))
    if source.endswith(".git") and append_src:
        source = f"{source}//src"
    return {
        "component": component_id,
        "source": f"{source}?ref={version}" if source and version else source,
        "version": version,
        "target": f"components/terraform/{component_id}",
    }


def _vendor_component_ids(deploy_sequence: list[str]) -> list[str]:
    ordered: list[str] = []
    seen: set[str] = set()
    supported = set(CLOUDPOSSE_NATIVE)

    def add(component_id: str) -> None:
        normalized = _normalize_component_id(component_id)
        if not normalized or normalized in seen or normalized not in supported:
            return
        seen.add(normalized)
        ordered.append(normalized)

    for component_id in deploy_sequence:
        add(component_id)

    return ordered


def _base_vars(payload: dict[str, Any], *, project_slug: str, environment: str, aws_region: str) -> dict[str, Any]:
    return {
        "region": aws_region,
        "namespace": "deplai",
        "stage": environment,
        "name": project_slug,
        "tenant": "deplai",  # Required for VPC flow logs coalesce
        "tags": {
            "managed_by": "deplai",
            "terraform_renderer": "cloudposse_atmos",
            "environment": environment,
        },
    }


def _default_region_availability_zones(aws_region: str) -> list[str]:
    return get_azs_for_region(aws_region)


def build_cloudposse_atmos_bundle(
    *,
    payload: dict[str, Any],
    aws_region: str,
    state_bucket: str,
    lock_table: str,
    context_summary: str,
    website_index_html: str,
    requested_renderer: str = "auto",
) -> tuple[dict[str, str], list[str], dict[str, Any]]:
    support = classify_cloudposse_support(payload, aws_region=aws_region)
    if not bool(support.get("supported")):
        raise ValueError("; ".join([str(item) for item in support.get("reasons") or []]) or "unsupported Cloud Posse profile")

    catalog = load_component_catalog()
    project_name = str(payload.get("project_name") or "deplai-project").strip() or "deplai-project"
    project_slug = slugify(project_name, "deplai-project")[:40]
    environment = str(payload.get("environment") or "dev").strip() or "dev"
    workspace = str(payload.get("workspace") or project_slug).strip() or project_slug
    stack_name = f"{workspace}-{environment}"
    networking = _record(payload.get("networking"))
    data_layer = [_record(item) for item in _list(payload.get("data_layer"))]
    deploy_sequence = [str(item) for item in support.get("deploy_sequence") or []]
    selected_components = _string_list(support.get("components")) or [*deploy_sequence]
    stack_config = _record(support.get("stack_config"))
    outputs_to_capture = _string_list(support.get("outputs_to_capture")) or list(DEFAULT_OUTPUTS_TO_CAPTURE)
    consultant_notes = _string_list(support.get("consultant_notes"))
    omitted_components = _string_list(support.get("omitted_components"))
    decision_source = str(support.get("decision_source") or "fallback")
    if not deploy_sequence:
        deploy_sequence = [*selected_components]
    deploy_sequence = _enforce_deploy_sequence_order(deploy_sequence)
    selected_components = _enforce_deploy_sequence_order(selected_components)
    if not selected_components:
        selected_components = [*deploy_sequence]
    vendored_components = _vendor_component_ids(deploy_sequence or selected_components)

    atmos_config = {
        "base_path": ".",
        "components": {"terraform": {"base_path": "components/terraform", "apply_auto_approve": True}},
        "stacks": {
            "base_path": "stacks",
            "included_paths": ["deploy/**/*.yaml", "catalog/**/*.yaml"],
            "name_template": "{{ .vars.workspace }}-{{ .vars.environment }}",
        },
        "logs": {"file": "/dev/stderr", "level": "Info"},
    }
    vendor = {
        "apiVersion": "atmos/v1",
        "kind": "AtmosVendorConfig",
        "metadata": {"name": "deplai-cloudposse-components"},
        "spec": {
            "sources": [
                {
                    "component": ref["component"],
                    "source": ref["source"],
                    "version": ref["version"],
                    "targets": [ref["target"]],
                }
                for ref in [
                    _component_ref(component_id, catalog)
                    for component_id in vendored_components
                ]
            ]
        },
    }

    components: dict[str, Any] = {}
    consultant_decision_payload = _record(payload.get("consultant_decision"))
    consultant_decision_components = _string_list(consultant_decision_payload.get("components"))
    base_vars = _base_vars(payload, project_slug=project_slug, environment=environment, aws_region=aws_region)
    repository_context = _record(payload.get("repository_context"))
    repository_health = _record(repository_context.get("health"))
    compute_profile = _record(payload.get("compute"))
    compute_services = [_record(item) for item in _list(compute_profile.get("services"))]
    primary_service = compute_services[0] if compute_services else {}
    default_app_port = _to_int(primary_service.get("port"), 3000)
    default_health_check_path = str(repository_health.get("endpoint") or "/status").strip() or "/status"
    if not default_health_check_path.startswith("/"):
        default_health_check_path = f"/{default_health_check_path}"
    default_repo_url = _resolve_repo_url(payload, project_slug=project_slug)
    region_azs = get_azs_for_region(aws_region)
    postgres_profile = next(
        (
            item
            for item in data_layer
            if str(item.get("type") or "").strip().lower() in {"postgres", "postgresql", "mysql", "mariadb"}
        ),
        {},
    )
    redis_profile = next(
        (item for item in data_layer if str(item.get("type") or "").strip().lower() == "redis"),
        {},
    )

    normalized_component_vars: dict[str, dict[str, Any]] = {}
    for component_id in selected_components:
        normalized_component_vars[component_id] = _record(_deep_copy(stack_config.get(component_id)))

    vpc_cfg = normalized_component_vars.get("vpc", {})
    nat_gateway_enabled = _to_bool(vpc_cfg.get("nat_gateway_enabled"), bool(networking.get("nat_gateway")))

    def _component_vars(component_id: str) -> dict[str, Any]:
        decision_vars = {
            key: value
            for key, value in _record(normalized_component_vars.get(component_id)).items()
            if key not in INTERNAL_TRACKING_VARS
        }
        if component_id == "vpc":
            decision_vars = {
                key: value
                for key, value in decision_vars.items()
                if key not in {
                    "availability_zones",
                    "region_availability_zones",
                    "assign_generated_ipv6_cidr_block",
                    "required_secret_names",
                    "secrets_manager_prefix",
                    "workspace",
                }
            }
            base_cidr = str(vpc_cfg.get("cidr_block") or "10.0.0.0/16")
            
            defaults = {
                "cidr_block": base_cidr,
                "availability_zones": [*region_azs],
                "nat_gateway_enabled": nat_gateway_enabled,
                "nat_instance_enabled": _to_bool(vpc_cfg.get("nat_instance_enabled"), False),
                "nat_instance_type": str(vpc_cfg.get("nat_instance_type") or "t3.micro"),
                "map_public_ip_on_launch": _to_bool(vpc_cfg.get("map_public_ip_on_launch"), True),
                "region_availability_zones": [*region_azs],
                "subnet_type_tag_key": DEFAULT_SUBNET_TYPE_TAG_KEY,
                "ipv4_primary_cidr_block_association": {
                    "ipv4_ipam_pool_id": "",
                    "ipv4_netmask_length": 0,  # 0 = disabled, use cidr_block directly (not IPAM)
                    "ipv4_cidr_block": base_cidr,
                },
                "ipv4_additional_cidr_block_associations": [],
                "ipv4_cidr_block_associations_enabled": False,
                "ipv4_ipam_pool_enabled": False,
                "vpc_flow_logs_enabled": False,
                # CloudPosse VPC 1.6.0 + dynamic-subnets 2.0.2 subnet configuration
                # VERIFIED: These variable names exist in terraform-aws-dynamic-subnets/variables.tf
                "public_subnets_per_az_count": 1,  # Creates 1 public subnet per AZ
                "private_subnets_per_az_count": 0,  # No private subnets needed
                "internet_gateway_enabled": True,  # Required for public internet access
            }
            return {
                **{key: value for key, value in base_vars.items() if key in GLOBAL_COMPONENT_VARS},
                **defaults,
                **decision_vars,
            }

        if component_id == "ec2-instance":
            # Get region for AMI lookup
            region = str(base_vars.get("region") or "us-east-1")
            ami_id = UBUNTU_2204_AMI_MAP.get(region, UBUNTU_2204_AMI_MAP["us-east-1"])
            
            # User data script to install and run the application
            user_data_script = """#!/bin/bash
set -e

# Update system
apt-get update -y
apt-get install -y nodejs npm git curl

# Install PM2 for process management
npm install -g pm2

# Clone and setup application
cd /opt
git clone https://github.com/adityajayashankar/ifca- /opt/app
cd /opt/app
npm install
npm run build
pm2 start npm --name "app" -- start
pm2 startup systemd -u root --hp /root
pm2 save

echo "User data script completed" > /var/log/user-data-complete.log
"""
            
            # Simplified defaults using only declared variables from cloudposse/terraform-aws-ec2-instance 0.47.1
            # Using specific AMI ID instead of ami_filter to avoid data source lookup failures
            # NOTE: vpc_id and subnet are NOT included here - they will be injected at runtime via -var flags
            defaults = {
                "instance_type": "t3.micro",
                "ami": ami_id,  # Direct AMI ID - no data source lookup needed
                "associate_public_ip_address": True,  # Required for public access
                "user_data": user_data_script,  # Startup script (Terraform will base64 encode if needed)
                "security_group_rules": [
                    {
                        "type": "ingress",
                        "from_port": 80,
                        "to_port": 80,
                        "protocol": "tcp",
                        "cidr_blocks": ["0.0.0.0/0"],
                    },
                    {
                        "type": "ingress",
                        "from_port": 443,
                        "to_port": 443,
                        "protocol": "tcp",
                        "cidr_blocks": ["0.0.0.0/0"],
                    },
                    {
                        "type": "ingress",
                        "from_port": 22,
                        "to_port": 22,
                        "protocol": "tcp",
                        "cidr_blocks": ["0.0.0.0/0"],
                    },
                    {
                        "type": "egress",
                        "from_port": 0,
                        "to_port": 0,
                        "protocol": "-1",
                        "cidr_blocks": ["0.0.0.0/0"],
                    },
                ],
            }
            return {
                **{key: value for key, value in base_vars.items() if key in GLOBAL_COMPONENT_VARS},
                **defaults,
                **decision_vars,
            }

        if component_id == "rds":
            rds_cfg = _record(stack_config.get("rds"))
            defaults = {
                "instance_class": "db.t3.micro",
                "engine": "postgres",
                "engine_version": "15.3",
                "multi_az": False,
                "backup_retention_period": 7,
                "deletion_protection": False,
                "publicly_accessible": False,
                "vpc_id": "!terraform_remote_state vpc.vpc_id",
                "subnet_ids": "!terraform_remote_state vpc.private_subnets",
            }
            return {
                **{key: value for key, value in base_vars.items() if key in GLOBAL_COMPONENT_VARS},
                **defaults,
                "engine": str(rds_cfg.get("engine") or postgres_profile.get("engine") or defaults["engine"]),
                "engine_version": str(rds_cfg.get("engine_version") or postgres_profile.get("engine_version") or defaults["engine_version"]),
                "instance_class": str(rds_cfg.get("instance_class") or postgres_profile.get("instance_class") or defaults["instance_class"]),
                "allocated_storage": int(postgres_profile.get("storage_gb") or 20),
                "multi_az": _to_bool(rds_cfg.get("multi_az"), defaults["multi_az"]),
                "deletion_protection": _to_bool(rds_cfg.get("deletion_protection"), defaults["deletion_protection"]),
                "backup_retention_period": _to_int(rds_cfg.get("backup_retention_period"), defaults["backup_retention_period"]),
                "publicly_accessible": _to_bool(rds_cfg.get("publicly_accessible"), defaults["publicly_accessible"]),
                "vpc_id": str(rds_cfg.get("vpc_id") or defaults["vpc_id"]),
                "subnet_ids": rds_cfg.get("subnet_ids") or defaults["subnet_ids"],
                **decision_vars,
            }

        if component_id == "elasticache":
            elasticache_cfg = _record(stack_config.get("elasticache"))
            defaults = {
                "engine": "redis",
                "node_type": "cache.t4g.micro",
                "vpc_id": "!terraform_remote_state vpc.vpc_id",
                "subnet_ids": "!terraform_remote_state vpc.private_subnets",
            }
            return {
                **{key: value for key, value in base_vars.items() if key in GLOBAL_COMPONENT_VARS},
                **defaults,
                "engine": str(elasticache_cfg.get("engine") or defaults["engine"]),
                "node_type": str(elasticache_cfg.get("node_type") or redis_profile.get("node_type") or defaults["node_type"]),
                "vpc_id": str(elasticache_cfg.get("vpc_id") or defaults["vpc_id"]),
                "subnet_ids": elasticache_cfg.get("subnet_ids") or defaults["subnet_ids"],
                **decision_vars,
            }

        return {
            **{key: value for key, value in base_vars.items() if key in GLOBAL_COMPONENT_VARS},
            **decision_vars,
        }

    for component_id in selected_components:
        component_payload: dict[str, Any] = {
            "metadata": {"component": component_id},
            "vars": _component_vars(component_id),
        }
        if component_id in {"rds", "elasticache"} and "vpc" in selected_components:
            component_payload["settings"] = {
                "depends_on": {
                    "vpc": {"component": "vpc"}
                }
            }
        components[component_id] = component_payload

    stack_payload = {
        "import": ["../catalog/cloudposse-components"],
        "vars": {
            "environment": environment,
            "workspace": workspace,
            "region": aws_region,
            "tenant": "deplai",
        },
        "components": {"terraform": components},
    }
    decision_drift = _collect_decision_alignment_drift(
        consultant_decision_payload=consultant_decision_payload,
        generated_components=selected_components,
        generated_deploy_sequence=deploy_sequence,
        rendered_components=components,
        aws_region=aws_region,
    )
    decision_applied = not decision_drift

    catalog_payload = {
        "settings": {
            "deplai": {
            "component_catalog_version": catalog.get("catalog_version"),
            "renderer_mapping_version": catalog.get("mapping_version"),
            }
        }
    }
    lock_payload = {
        "renderer": "cloudposse_atmos",
        "source": "cloudposse_atmos",
        "requested_renderer": normalize_terraform_renderer(requested_renderer),
        "actual_renderer": "cloudposse_atmos",
        "component_catalog_version": catalog.get("catalog_version"),
        "mapping_version": catalog.get("mapping_version"),
        "deploy_sequence": deploy_sequence,
        "components_selected": selected_components,
        "vendored_components": vendored_components,
        "stack": stack_name,
        "outputs_to_capture": outputs_to_capture,
        "omitted_components": omitted_components,
        "consultant_notes": consultant_notes,
        "consultant_decision_components": consultant_decision_components,
        "decision_source": decision_source,
        "decision_applied": decision_applied,
        "decision_drift": decision_drift,
        "post_vendor_patches": [
            {
                "name": "replace_iam_roles_provider",
                "description": "Replace component providers.tf with a direct aws provider for single-account deploys.",
                "components": ["vpc", "ec2-instance", "rds", "elasticache"],
                "path_glob": "components/terraform/**/providers.tf",
            }
        ],
        "components": {
            component_id: catalog.get("components", {}).get(component_id)
            for component_id in vendored_components
        },
        "upgrade_policy": catalog.get("upgrade_policy"),
    }
    plan_commands = "\n".join(f"atmos terraform plan {component} -s {stack_name}" for component in deploy_sequence)
    if not plan_commands:
        plan_commands = f"atmos terraform plan vpc -s {stack_name}"
    readme = f"""# Cloud Posse Atmos Bundle - {project_name}

Generated by DeplAI with the deterministic Cloud Posse/Atmos renderer.

## Commands

```sh
atmos vendor pull
sh .deplai/post-vendor-patches/replace_iam_roles_provider.sh
atmos validate stacks
{plan_commands}
```

## Notes

- Component sources are not vendored into this repository.
- `.deplai/cloudposse-component-lock.json` records the pinned component catalog and deploy sequence.
- Secret values are not written to generated files; only names/prefixes are rendered.

{context_summary}
"""

    stack_comments: list[str] = []
    if consultant_notes:
        stack_comments.append("consultant_notes")
        stack_comments.extend(f"- {note}" for note in consultant_notes)
    stack_payload_text = _render_stack_yaml_with_consultant_notes(
        stack_payload=stack_payload,
        consultant_notes=consultant_notes,
    )
    if stack_comments:
        stack_payload_text = f"{_comment_lines(stack_comments)}\n{stack_payload_text}"

    iam_roles_patch_script = """#!/usr/bin/env sh
set -eu

patched_count=0
for component in vpc ec2-instance rds elasticache; do
    target="components/terraform/$component/providers.tf"
    if [ -f "$target" ]; then
        cat > "$target" << 'TFEOF'
provider "aws" {
    region = var.region
}
TFEOF
        patched_count=$((patched_count + 1))
        echo "Patched providers.tf for $component"
  fi
done

if [ "$patched_count" -gt 0 ]; then
    echo "Replaced providers.tf with direct aws provider for $patched_count component(s)"
else
    echo "No providers.tf replacement was required"
fi
"""

    files = {
        "atmos.yaml": _json_yaml(atmos_config),
        "vendor.yaml": _json_yaml(vendor),
        "stacks/catalog/cloudposse-components.yaml": _json_yaml(catalog_payload),
        f"stacks/deploy/{stack_name}.yaml": stack_payload_text,
        ".deplai/cloudposse-component-lock.json": json.dumps(lock_payload, indent=2, sort_keys=True) + "\n",
        ".deplai/post-vendor-patches/replace_iam_roles_provider.sh": iam_roles_patch_script,
        "README.md": readme,
    }
    warnings = [
        "Generated Cloud Posse/Atmos bundle without vendored component source; run atmos vendor pull before plan/apply.",
        "Cloud Posse/Atmos V1 is for new deployments only and does not migrate existing Terraform state.",
    ]
    if decision_source not in {"llm", "consultant"}:
        warnings.append("Cloud Posse component decision used deterministic fallback logic because LLM decision was unavailable or invalid.")
    if omitted_components:
        warnings.append(
            "Omitted consultant-selected components not present in the pinned catalog: "
            + ", ".join(omitted_components)
            + "."
        )
    if decision_drift:
        warnings.append(
            f"Generated stack vars drift from consultant decision for {len(decision_drift)} field(s). Review approval before deploy."
        )
    return files, warnings, lock_payload
