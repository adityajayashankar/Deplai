import json
import os
import secrets
import re

import anthropic

if __package__:
    from .template_registry import SUPPORTED_SERVICES, get_param_schema
else:
    from template_registry import SUPPORTED_SERVICES, get_param_schema

MODEL = os.getenv("IAC_PARAM_SELECTOR_MODEL", "claude-sonnet-4-5")
_ANTHROPIC_API_KEY = (
    os.getenv("ANTHROPIC_API_KEY")
    or os.getenv("CLAUDE_API_KEY")
    or ""
).strip()
_client = anthropic.AsyncAnthropic(api_key=_ANTHROPIC_API_KEY) if _ANTHROPIC_API_KEY else None

_SYSTEM_PROMPT = """You are a Terraform parameter selector. Your ONLY output must be a valid JSON object.
No markdown. No explanation. No code fences. No trailing commas. Pure JSON only.

Rules:
- Use ONLY the exact field names listed in the schema. Never invent new fields.
- For instance types, prefer free-tier eligible options (t3.micro, t2.micro) unless the user explicitly requested otherwise.
- bucket_name values must be globally unique - always append a 6-character random hex suffix like: myapp-a3f9c1
- For required fields with no user preference, choose a sensible production default.
- For list-type fields, output a JSON array.
- For bool fields, output true or false (no quotes).
- For number fields, output a number (no quotes)."""


def _build_user_prompt(
    service_type: str,
    param_schema: list[dict],
    repo_context: dict,
    user_customizations: dict,
) -> str:
    schema_lines = json.dumps(param_schema, indent=2)
    repo_summary = json.dumps(repo_context, indent=2)
    custom_summary = json.dumps(user_customizations, indent=2)
    return f"""Fill the following parameters for a {service_type.upper()} deployment.

PARAMETER SCHEMA (fill every field):
{schema_lines}

APPLICATION CONTEXT (use this to make smart choices):
{repo_summary}

USER CUSTOMIZATION PREFERENCES (these override defaults):
{custom_summary}

Return a single flat JSON object with all parameter names as keys."""


def _apply_defaults(params: dict, schema: list[dict]) -> dict:
    """Fill in any missing optional fields with schema defaults."""
    result = dict(params)
    for field in schema:
        if field["name"] not in result:
            if "default" in field:
                result[field["name"]] = field["default"]
    return result


def _slug(value: str, fallback: str = "deplai") -> str:
    normalized = re.sub(r"[^a-z0-9-]+", "-", str(value or "").strip().lower())
    normalized = re.sub(r"-{2,}", "-", normalized).strip("-")
    return normalized[:40] or fallback


def _generate_key_pair_name(project_name: str, project_id: str) -> str:
    base = f"{project_name[:20]}-{_slug(project_id, 'proj')[:8]}".strip("-")
    return f"{base}-{secrets.token_hex(3)}-key"


def _collect_string_candidates(payload: dict) -> dict[str, str]:
    flat: dict[str, str] = {}

    def walk(node: object, prefix: str = "") -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                next_prefix = f"{prefix}.{key}" if prefix else str(key)
                walk(value, next_prefix)
        elif isinstance(node, list):
            for index, value in enumerate(node):
                walk(value, f"{prefix}[{index}]")
        elif node is not None:
            flat[prefix] = str(node).strip()

    walk(payload)
    return flat


def _lookup_value(candidates: dict[str, str], *needles: str) -> str:
    lowered_needles = [needle.lower() for needle in needles]
    for key, value in candidates.items():
        lowered_key = key.lower()
        if any(needle in lowered_key for needle in lowered_needles) and value:
            return value
    return ""


def _coerce_value(value: object, field_type: str) -> object:
    if field_type == "number":
        try:
            return int(value) if str(value).isdigit() else float(value)
        except Exception:
            return value
    if field_type == "bool":
        normalized = str(value).strip().lower()
        if normalized in {"true", "1", "yes", "y", "on"}:
            return True
        if normalized in {"false", "0", "no", "n", "off"}:
            return False
    if field_type == "list":
        if isinstance(value, list):
            return value
        if isinstance(value, str) and value.strip():
            return [item.strip() for item in value.split(",") if item.strip()]
    return value


def _free_tier_instance_types() -> list[str]:
    raw = os.getenv("DEPLAI_FREE_TIER_EC2_TYPES", "t3.micro,t2.micro")
    return [item.strip() for item in raw.split(",") if item.strip()]


def _normalize_ec2_instance_type(value: object) -> str:
    raw = str(value or "").strip().lower()
    free_tier = _free_tier_instance_types()
    default_type = free_tier[0] if free_tier else "t3.micro"

    semantic_sizes = {
        "nano": default_type,
        "micro": default_type,
        "small": "t3.small",
        "medium": "t3.medium",
        "large": "t3.large",
        "xlarge": "t3.xlarge",
        "free": default_type,
        "free-tier": default_type,
        "starter": default_type,
        "basic": default_type,
        "cheap": default_type,
    }

    if raw in semantic_sizes:
        return semantic_sizes[raw]

    if re.fullmatch(r"[a-z0-9]+\.[a-z0-9]+", raw):
        return raw

    return default_type


def _sanitize_params(service_type: str, params: dict) -> dict:
    sanitized = dict(params)

    if service_type == "ec2":
        sanitized["instance_type"] = _normalize_ec2_instance_type(
            sanitized.get("instance_type")
        )
        key_name = str(sanitized.get("key_pair_name") or "").strip()
        if not key_name:
            project_name = _slug(
                str(sanitized.get("instance_name") or sanitized.get("project_id") or "deplai")
            )
            sanitized["key_pair_name"] = _generate_key_pair_name(
                project_name,
                str(sanitized.get("project_id") or "proj"),
            )

    return sanitized


def _deterministic_params(
    service_type: str,
    schema: list[dict],
    repo_context: dict,
    user_customizations: dict,
    aws_region: str,
    project_id: str,
) -> dict:
    project_name = _slug(str(repo_context.get("project_name") or project_id or "deplai"))
    flat = _collect_string_candidates(user_customizations)
    params: dict[str, object] = {}

    for field in schema:
        name = field["name"]
        field_type = field.get("type", "string")

        if name in user_customizations:
            value = _coerce_value(user_customizations[name], field_type)
            if service_type == "ec2" and name == "instance_type":
                value = _normalize_ec2_instance_type(value)
            params[name] = value
            continue

        alias_value = ""
        if name == "instance_name":
            alias_value = _lookup_value(flat, "instance_name", "project_name", "service_name", "name")
        elif name == "instance_type":
            alias_value = _lookup_value(flat, "instance_type", "ec2_instance_type", "size")
        elif name == "bucket_name":
            alias_value = _lookup_value(flat, "bucket_name", "name")
        elif name == "db_name":
            alias_value = _lookup_value(flat, "db_name", "database_name", "name")
        elif name == "db_username":
            alias_value = _lookup_value(flat, "db_username", "database_user", "username")
        elif name == "db_password":
            alias_value = _lookup_value(flat, "db_password", "database_password", "password")
        elif name == "cluster_name":
            alias_value = _lookup_value(flat, "cluster_name", "service_name", "name")
        elif name == "container_image":
            alias_value = _lookup_value(flat, "container_image", "docker_image", "image")
        elif name == "container_port":
            alias_value = _lookup_value(flat, "container_port", "port", "app_port")
        elif name == "function_name":
            alias_value = _lookup_value(flat, "function_name", "lambda_name", "name")
        elif name == "cluster_id":
            alias_value = _lookup_value(flat, "cluster_id", "redis_cluster", "name")
        elif name == "alb_name":
            alias_value = _lookup_value(flat, "alb_name", "load_balancer_name", "name")
        elif name == "vpc_name":
            alias_value = _lookup_value(flat, "vpc_name", "name")
        elif name == "user_data":
            alias_value = _lookup_value(flat, "user_data", "build_script", "script", "startup_script")

        if alias_value:
            value = _coerce_value(alias_value, field_type)
            if service_type == "ec2" and name == "instance_type":
                value = _normalize_ec2_instance_type(value)
            params[name] = value
            continue

        if name == "project_id":
            params[name] = project_id
        elif name == "aws_region":
            params[name] = aws_region
        elif name == "environment":
            params[name] = "production"
        elif name == "instance_name":
            params[name] = project_name
        elif name == "key_pair_name":
            params[name] = _generate_key_pair_name(project_name, project_id)
        elif name == "bucket_name":
            params[name] = f"{project_name}-{secrets.token_hex(3)}"
        elif name == "db_name":
            params[name] = re.sub(r"[^a-z0-9]", "", project_name)[:16] or "deplaidb"
        elif name == "db_username":
            params[name] = "deplaiadmin"
        elif name == "db_password":
            params[name] = secrets.token_urlsafe(18)
        elif name == "vpc_name":
            params[name] = f"{project_name}-vpc"
        elif name == "cluster_name":
            params[name] = f"{project_name}-cluster"
        elif name == "container_image":
            params[name] = "nginx:stable"
        elif name == "function_name":
            params[name] = f"{project_name}-lambda"
        elif name == "cluster_id":
            params[name] = f"{project_name}-redis"
        elif name == "alb_name":
            params[name] = f"{project_name}-alb"

    params = _sanitize_params(service_type, _apply_defaults(params, schema))
    _validate_required(params, schema, service_type)
    return params


async def _call_llm(prompt: str) -> dict:
    if _client is None:
        raise RuntimeError("Anthropic client not configured")
    response = await _client.messages.create(
        model=MODEL,
        max_tokens=1000,
        system=_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": prompt}],
    )
    raw_text = response.content[0].text.strip()
    return json.loads(raw_text)


def _validate_required(params: dict, schema: list[dict], service_type: str) -> None:
    """Raise ValueError if any required field is missing."""
    missing = [
        f["name"] for f in schema
        if f.get("required") and f["name"] not in params
    ]
    if missing:
        raise ValueError(
            f"LLM response missing required fields for {service_type}: {missing}"
        )


async def select_params(
    service_type: str,
    repo_context: dict,
    user_customizations: dict,
    aws_region: str,
    project_id: str,
) -> dict:
    """
    Main entry point. Calls Claude to fill in terraform params for the given service.
    Returns a validated, default-filled params dict ready to write as terraform.tfvars.json.
    """
    if service_type not in SUPPORTED_SERVICES:
        raise ValueError(f"Unknown service type: {service_type}")

    schema = get_param_schema(service_type)

    # Inject known values so LLM doesn't need to guess them
    forced_values = {
        "aws_region": aws_region,
        "project_id": project_id,
    }
    enriched_customizations = {**user_customizations, **forced_values}

    # Append random suffix to bucket names to ensure global uniqueness
    if service_type == "s3" and "bucket_name" not in enriched_customizations:
        suffix = secrets.token_hex(3)  # 6 hex chars
        base = repo_context.get("project_name", "deplai-bucket")
        enriched_customizations["bucket_name"] = f"{base}-{suffix}"

    try:
        user_prompt = _build_user_prompt(
            service_type, schema, repo_context, enriched_customizations
        )
        params = await _call_llm(user_prompt)
    except Exception as exc:
        print(f"[param_selector] Falling back to deterministic params for {service_type}: {exc}")
        params = _deterministic_params(
            service_type=service_type,
            schema=schema,
            repo_context=repo_context,
            user_customizations=enriched_customizations,
            aws_region=aws_region,
            project_id=project_id,
        )

    params = _sanitize_params(service_type, _apply_defaults(params, schema))
    _validate_required(params, schema, service_type)

    return params


async def correct_params(
    service_type: str,
    current_params: dict,
    validation_errors: list[str],
) -> dict:
    """
    Called by the validation retry loop when terraform validate fails.
    Sends current params + exact error messages back to Claude for targeted correction.
    Returns corrected params dict.
    """
    schema = get_param_schema(service_type)
    errors_text = "\n".join(validation_errors)

    correction_prompt = f"""The following Terraform validation errors occurred for a {service_type.upper()} deployment.

CURRENT PARAMS (the ones that failed):
{json.dumps(current_params, indent=2)}

VALIDATION ERRORS (fix only what caused these):
{errors_text}

PARAMETER SCHEMA (for reference):
{json.dumps(schema, indent=2)}

Return the complete corrected params JSON object. Same format, all fields, errors fixed."""

    try:
        corrected = await _call_llm(correction_prompt)
    except Exception as exc:
        print(f"[param_selector] Falling back to current params during correction for {service_type}: {exc}")
        corrected = dict(current_params)

    corrected = _sanitize_params(service_type, _apply_defaults(corrected, schema))
    _validate_required(corrected, schema, service_type)

    return corrected
