"""Infrastructure consultant: chat intake → structured planner decision."""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.request
from copy import deepcopy
from typing import Any

from planning_runtime import (
    consult_decision_path,
    consult_state_path,
    consult_transcript_path,
    read_json_optional,
    slugify,
    write_json,
)

logger = logging.getLogger(__name__)

_INSTANCE_TYPES = {
    "t3.micro",
    "t3.small",
    "t3.medium",
    "t3.large",
    "t3.xlarge",
    "t2.micro",
    "t2.small",
    "t2.medium",
    "m5.large",
    "m5.xlarge",
    "c5.large",
    "c5.xlarge",
}

_AWS_REGIONS = {
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
    "eu-west-1",
    "eu-west-2",
    "eu-central-1",
    "eu-north-1",
    "ap-south-1",
    "ap-southeast-1",
    "ap-northeast-1",
    "ca-central-1",
    "sa-east-1",
}


def _as_record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_records(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _text(value: Any) -> str:
    return str(value or "").strip()


def _boolish(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    text = _text(value).lower()
    if text in {"true", "yes", "y", "1", "on"}:
        return True
    if text in {"false", "no", "n", "0", "off"}:
        return False
    return None


def _parse_number(raw: str) -> float | None:
    cleaned = raw.strip().lower().replace(",", "")
    multiplier = 1.0
    if cleaned.endswith("k"):
        multiplier = 1_000.0
        cleaned = cleaned[:-1]
    elif cleaned.endswith("m"):
        multiplier = 1_000_000.0
        cleaned = cleaned[:-1]
    try:
        return float(cleaned) * multiplier
    except ValueError:
        return None


def _conversation_corpus(history: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for item in history or []:
        if not isinstance(item, dict):
            continue
        role = _text(item.get("role")).lower() or "user"
        content = _text(item.get("content"))
        if content:
            parts.append(f"{role}: {content}")
    return "\n".join(parts)


def _user_messages(history: list[dict[str, Any]]) -> list[str]:
    messages: list[str] = []
    for item in history or []:
        if not isinstance(item, dict):
            continue
        if _text(item.get("role")).lower() != "user":
            continue
        content = _text(item.get("content"))
        if content:
            messages.append(content)
    return messages


def _latest_user_message(history: list[dict[str, Any]]) -> str:
    messages = _user_messages(history)
    return messages[-1] if messages else ""


def parse_message_deltas(message: str) -> dict[str, Any]:
    """Parse the latest operator message as high-priority plan overrides."""
    text = _text(message)
    if not text:
        return {}
    search = text.lower()
    deltas: dict[str, Any] = {}

    if re.search(r"\b(?:no|without|don'?t\s+need|do\s+not\s+need|remove|disable|skip)\b.{0,24}\b(?:alb|load\s*balanc)", search, re.I):
        deltas["need_alb"] = False
    elif re.search(r"\b(?:add|enable|include|need|want|with)\b.{0,24}\b(?:alb|application\s+load\s*balanc|load\s*balanc(?:er|ing)?)\b", search, re.I):
        deltas["need_alb"] = True

    if re.search(r"\b(?:no|without|don'?t\s+need|do\s+not\s+need|remove|disable|skip)\b.{0,24}\b(?:eip|elastic\s*ip)", search, re.I):
        deltas["need_eip"] = False
    elif re.search(r"\b(?:add|enable|include|need|want|with)\b.{0,24}\b(?:eip|elastic\s*ip|static\s*(?:public\s*)?ip)\b", search, re.I):
        deltas["need_eip"] = True

    if re.search(r"\b(?:no|without|don'?t\s+(?:need|want)|remove|disable|skip)\b.{0,20}\b(?:rds|database|postgres|mysql)\b", search, re.I):
        deltas["need_rds"] = False
    elif re.search(r"\b(?:add|enable|include|need|want|with)\b.{0,20}\b(?:rds|managed\s+database|postgres|mysql)\b", search, re.I):
        deltas["need_rds"] = True

    if re.search(r"\b(?:no|without|don'?t\s+(?:need|want)|remove|disable|skip)\b.{0,20}\b(?:redis|elasticache|cache)\b", search, re.I):
        deltas["need_redis"] = False
    elif re.search(r"\b(?:add|enable|include|need|want|with)\b.{0,20}\b(?:redis|elasticache|cache)\b", search, re.I):
        deltas["need_redis"] = True

    region_match = re.search(r"\b((?:us|eu|ap|ca|sa|me|af)-(?:east|west|north|south|central|northeast|southeast)-\d)\b", search, re.I)
    if region_match:
        region = region_match.group(1).lower()
        if region in _AWS_REGIONS:
            deltas["region"] = region

    instance_match = re.search(r"\b((?:t2|t3|t3a|m5|m6i|c5|c6i|r5)\.(?:nano|micro|small|medium|large|xlarge|2xlarge))\b", search, re.I)
    if instance_match:
        deltas["instance_type"] = instance_match.group(1).lower()

    disk_match = re.search(r"\b(?:disk|volume|root(?:\s+volume)?)\D{0,16}(\d{1,3})\s*(?:gb|gib)?\b", search, re.I)
    if disk_match:
        deltas["root_volume_size_gb"] = int(disk_match.group(1))

    # "disable 3000 port routing" / "stop routing on port 3000" / "no public :3000"
    disable_port = re.search(
        r"\b(?:disable|remove|stop|no|don'?t|do\s+not)\b.{0,40}?"
        r"(?:(?:port|routing|expose|exposure|ingress|public).{0,16})?(\d{2,5})"
        r"(?:.{0,16}(?:port|routing|expose|exposure|ingress|public))?",
        search,
        re.I,
    )
    disable_port_alt = re.search(
        r"\b(?:disable|remove|stop)\b.{0,12}(\d{2,5})\s*port(?:\s*routing)?\b",
        search,
        re.I,
    )
    if disable_port or disable_port_alt:
        deltas["direct_port_routing"] = False
        port_value = int((disable_port or disable_port_alt).group(1))
        deltas["disabled_public_port"] = port_value

    # Explicit app-port changes win over disable parsing for the target port value.
    change_port = re.search(
        r"\b(?:use|set|change(?:\s+to)?|switch(?:\s+to)?|app\s+port|listen(?:\s+on)?)\b.{0,16}(?:port\s*)?(\d{2,5})\b",
        search,
        re.I,
    )
    port_first = re.search(r"\bport\s*[:=]?\s*(\d{2,5})\b", search, re.I)
    if change_port and "disable" not in search and "remove" not in search:
        deltas["app_port"] = int(change_port.group(1))
        deltas.pop("disabled_public_port", None)
    elif port_first and "disable" not in search and "routing" not in search:
        deltas["app_port"] = int(port_first.group(1))

    peak = None
    for pattern in (
        r"(?:peak(?:\s+concurrent)?(?:\s+users?)?|concurrent\s+users?|peak\s+traffic)\D{0,24}(\d+(?:\.\d+)?\s*[km]?)",
        r"(\d+(?:\.\d+)?\s*[km]?)\s*(?:peak(?:\s+concurrent)?(?:\s+users?)?|concurrent\s+users?)",
    ):
        match = re.search(pattern, search, re.I)
        if match:
            peak = _parse_number(match.group(1))
            if peak is not None:
                break
    if peak is not None:
        deltas["peak_traffic"] = int(peak)
        deltas["peak_concurrent_users"] = int(peak)

    return deltas


def parse_chat_intakes(conversation_history: list[dict[str, Any]], user_answers: dict[str, Any] | None = None) -> dict[str, Any]:
    """Extract operator infra intents from free-text chat + structured answers."""
    answers = _as_record(user_answers)
    corpus = _conversation_corpus(conversation_history).lower()
    user_blob = "\n".join(_user_messages(conversation_history)).lower()
    search = f"{user_blob}\n{corpus}"

    intakes: dict[str, Any] = {}

    monthly = None
    for pattern in (
        r"(?:monthly|per\s*month|/\s*mo|month)\D{0,24}(\d+(?:\.\d+)?\s*[km]?)\s*(?:requests?|hits?|visits?|users?|req)?",
        r"(\d+(?:\.\d+)?\s*[km]?)\s*(?:requests?|hits?|visits?)\s*(?:per|/)\s*month",
        r"(\d+(?:\.\d+)?\s*[km]?)\s*(?:monthly)\s*(?:requests?|traffic|users?)?",
    ):
        match = re.search(pattern, search, re.I)
        if match:
            monthly = _parse_number(match.group(1))
            if monthly is not None:
                break
    if monthly is None and answers.get("monthly_traffic") is not None:
        monthly = _parse_number(str(answers.get("monthly_traffic")))
    if monthly is not None:
        intakes["monthly_traffic"] = int(monthly)

    peak = None
    for pattern in (
        r"(?:peak(?:\s+concurrent)?(?:\s+users?)?|concurrent\s+users?|peak\s+traffic)\D{0,24}(\d+(?:\.\d+)?\s*[km]?)",
        r"(\d+(?:\.\d+)?\s*[km]?)\s*(?:peak(?:\s+concurrent)?(?:\s+users?)?|concurrent\s+users?)",
        r"(?:rps|req(?:uests?)?\s*/\s*s(?:ec)?)\D{0,12}(\d+(?:\.\d+)?\s*[km]?)",
        r"(\d+(?:\.\d+)?\s*[km]?)\s*(?:rps|req(?:uests?)?\s*/\s*s(?:ec)?)",
    ):
        match = re.search(pattern, search, re.I)
        if match:
            peak = _parse_number(match.group(1))
            if peak is not None:
                break
    if peak is None:
        for key in ("peak_traffic", "peak_concurrent_users", "peak_users"):
            if answers.get(key) is not None:
                peak = _parse_number(str(answers.get(key)))
                if peak is not None:
                    break
    if peak is not None:
        intakes["peak_traffic"] = int(peak)
        intakes["peak_concurrent_users"] = int(peak)

    need_alb = None
    if re.search(r"\b(?:no|without|don'?t\s+need|do\s+not\s+need)\b.{0,24}\b(?:alb|load\s*balanc)", search, re.I):
        need_alb = False
    elif re.search(r"\b(?:alb|application\s+load\s*balanc|load\s*balanc(?:er|ing)?)\b", search, re.I):
        need_alb = True
    elif _boolish(answers.get("need_alb")) is not None:
        need_alb = _boolish(answers.get("need_alb"))
    if need_alb is not None:
        intakes["need_alb"] = need_alb

    need_eip = None
    if re.search(r"\b(?:no|without|don'?t\s+need|do\s+not\s+need)\b.{0,24}\b(?:eip|elastic\s*ip)", search, re.I):
        need_eip = False
    elif re.search(r"\b(?:eip|elastic\s*ip|static\s*(?:public\s*)?ip)\b", search, re.I):
        need_eip = True
    elif _boolish(answers.get("need_eip")) is not None:
        need_eip = _boolish(answers.get("need_eip"))
    if need_eip is not None:
        intakes["need_eip"] = need_eip

    ha = None
    if re.search(r"\b(?:no|without|don'?t\s+need|single[\s-]?az)\b.{0,20}\b(?:ha|high\s*avail|multi[\s-]?az)\b", search, re.I):
        ha = False
    elif re.search(r"\b(?:ha|high\s*availability|multi[\s-]?az|highly\s*available)\b", search, re.I):
        ha = True
    elif _boolish(answers.get("ha")) is not None:
        ha = _boolish(answers.get("ha"))
    elif _boolish(answers.get("high_availability")) is not None:
        ha = _boolish(answers.get("high_availability"))
    if ha is not None:
        intakes["ha"] = ha

    region_match = re.search(r"\b((?:us|eu|ap|ca|sa|me|af)-(?:east|west|north|south|central|northeast|southeast)-\d)\b", search, re.I)
    if region_match:
        region = region_match.group(1).lower()
        if region in _AWS_REGIONS:
            intakes["region"] = region
    elif _text(answers.get("aws_region") or answers.get("region")):
        region = _text(answers.get("aws_region") or answers.get("region")).lower()
        if region in _AWS_REGIONS:
            intakes["region"] = region

    instance_match = re.search(r"\b((?:t2|t3|t3a|m5|m6i|c5|c6i|r5)\.(?:nano|micro|small|medium|large|xlarge|2xlarge))\b", search, re.I)
    if instance_match:
        intakes["instance_type"] = instance_match.group(1).lower()
    elif _text(answers.get("instance_type")):
        intakes["instance_type"] = _text(answers.get("instance_type")).lower()

    if re.search(r"\b(?:no|without|don'?t\s+(?:need|want)|skip|disable)\b.{0,20}\b(?:rds|database|postgres|mysql)\b", search, re.I):
        intakes["need_rds"] = False
    elif re.search(r"\b(?:need|want|include|add|with)\b.{0,20}\b(?:rds|managed\s+database|postgres|mysql)\b", search, re.I):
        intakes["need_rds"] = True
    elif _boolish(answers.get("need_rds")) is not None:
        intakes["need_rds"] = _boolish(answers.get("need_rds"))

    if re.search(r"\b(?:no|without|don'?t\s+(?:need|want)|skip|disable)\b.{0,20}\b(?:redis|elasticache|cache)\b", search, re.I):
        intakes["need_redis"] = False
    elif re.search(r"\b(?:need|want|include|add|with)\b.{0,20}\b(?:redis|elasticache|cache)\b", search, re.I):
        intakes["need_redis"] = True
    elif _boolish(answers.get("need_redis")) is not None:
        intakes["need_redis"] = _boolish(answers.get("need_redis"))

    disk_match = re.search(r"\b(?:disk|volume|root(?:\s+volume)?)\D{0,16}(\d{1,3})\s*(?:gb|gib)?\b", search, re.I)
    if disk_match:
        intakes["root_volume_size_gb"] = int(disk_match.group(1))

    port_match = re.search(r"\b(?:port|app\s+port)\D{0,10}(\d{1,5})\b", search, re.I)
    if port_match and "disable" not in search:
        intakes["app_port"] = int(port_match.group(1))

    # Latest user turn always wins so refinements actually move the plan.
    latest_deltas = parse_message_deltas(_latest_user_message(conversation_history))
    intakes.update(latest_deltas)
    return intakes


def infer_detected_signals(
    *,
    architecture_json: dict[str, Any] | None,
    repository_context: dict[str, Any] | None,
    deployment_profile: dict[str, Any] | None,
    detected: dict[str, Any] | None,
) -> dict[str, Any]:
    base = _as_record(detected)
    architecture = _as_record(architecture_json)
    repo = _as_record(repository_context)
    profile = _as_record(deployment_profile)

    language = _as_record(repo.get("language"))
    frameworks = _as_records(repo.get("frameworks"))
    build = _as_record(repo.get("build"))
    frontend = _as_record(repo.get("frontend"))
    data_stores = _as_records(repo.get("data_stores"))
    profile_data = _as_records(profile.get("data_layer") or architecture.get("data_layer"))
    compute = _as_record(profile.get("compute") or architecture.get("compute"))
    services = _as_records(compute.get("services"))

    data_types = [
        _text(item.get("type")).lower()
        for item in [*data_stores, *profile_data]
        if _text(item.get("type"))
    ]
    corpus = json.dumps({"repo": repo, "architecture": architecture, "profile": profile}, default=str).lower()

    has_redis = bool(base.get("has_redis")) or "redis" in data_types or "redis" in corpus or "elasticache" in corpus
    db_type = _text(base.get("database_type")).lower()
    if not db_type or db_type == "unknown":
        for candidate in ("postgres", "postgresql", "mysql", "mariadb", "mongodb", "dynamodb"):
            if candidate in data_types or candidate in corpus:
                db_type = "postgres" if candidate == "postgresql" else candidate
                break
        else:
            db_type = "unknown"
    has_database = bool(base.get("has_database")) or db_type != "unknown"

    has_dockerfile = bool(base.get("has_dockerfile")) or _boolish(build.get("has_dockerfile")) is True
    has_web = bool(base.get("has_web_server")) or any(
        _text(service.get("process_type")).lower() == "web" for service in services
    ) or bool(_as_records(repo.get("processes")))
    has_workers = bool(base.get("has_workers")) or "worker" in corpus or "celery" in corpus
    has_static = bool(base.get("has_static_assets")) or bool(frontend.get("static_site_candidate")) or bool(build.get("output_dir"))

    return {
        "language": _text(base.get("language") or language.get("primary") or language.get("detected") or "unknown").lower(),
        "framework": _text(
            base.get("framework")
            or (frameworks[0].get("name") if frameworks else "")
            or frontend.get("framework")
            or "unknown"
        ).lower(),
        "has_database": has_database,
        "database_type": db_type,
        "has_web_server": has_web,
        "has_workers": has_workers,
        "has_static_assets": has_static,
        "has_dockerfile": has_dockerfile,
        "has_redis": has_redis,
        "has_queue": bool(base.get("has_queue")) or any(token in corpus for token in ("sqs", "rabbitmq", "kafka")),
    }


def build_repo_detection_summary(detected: dict[str, Any]) -> str:
    database = f"{detected.get('database_type') or 'database'} required" if detected.get("has_database") else "not detected"
    compute_strategy = (
        "s3-cloudfront"
        if detected.get("has_static_assets") and not detected.get("has_web_server")
        else "ecs-fargate"
        if detected.get("has_dockerfile")
        else "ec2-instance"
    )
    return "\n".join(
        [
            f"Language: {detected.get('language') or 'unknown'}",
            f"Framework: {detected.get('framework') or 'unknown'}",
            f"Compute strategy: {compute_strategy}",
            f"Database: {database}",
            f"Redis/cache: {'required' if detected.get('has_redis') else 'not detected'}",
            f"Workers: {'detected' if detected.get('has_workers') else 'not detected'}",
            f"Static assets: {'detected' if detected.get('has_static_assets') else 'not detected'}",
            f"Dockerfile: {'detected' if detected.get('has_dockerfile') else 'not detected'}",
            f"Queue: {'detected' if detected.get('has_queue') else 'not detected'}",
        ]
    )


def _default_ec2(intakes: dict[str, Any], aws_region: str, profile: dict[str, Any]) -> dict[str, Any]:
    compute = _as_record(profile.get("compute"))
    services = _as_records(compute.get("services"))
    primary = services[0] if services else {}
    instance_type = _text(intakes.get("instance_type")).lower() or "t3.micro"
    if instance_type not in _INSTANCE_TYPES:
        instance_type = "t3.micro"
    app_port = int(intakes.get("app_port") or primary.get("port") or 3000)
    root_gb = int(intakes.get("root_volume_size_gb") or 35)
    return {
        "instance_type": instance_type,
        "root_volume_size_gb": max(20, min(root_gb, 200)),
        "app_port": max(1, min(app_port, 65535)),
        "ssh_ingress_cidr_blocks": [],
        "aws_region": aws_region,
        "public_http": True,
        "desired_count": 2 if intakes.get("ha") or intakes.get("need_alb") else 1,
    }


def _traffic_suggests_alb(intakes: dict[str, Any]) -> bool:
    monthly = intakes.get("monthly_traffic")
    peak = intakes.get("peak_traffic") or intakes.get("peak_concurrent_users")
    if isinstance(monthly, (int, float)) and monthly >= 100_000:
        return True
    if isinstance(peak, (int, float)) and peak >= 50:
        return True
    return False


def build_heuristic_decision(
    *,
    detected: dict[str, Any],
    intakes: dict[str, Any],
    deployment_profile: dict[str, Any] | None,
    aws_region: str,
    prior_decision: dict[str, Any] | None = None,
) -> dict[str, Any]:
    profile = _as_record(deployment_profile)
    prior = _as_record(prior_decision)
    prior_stack = _as_record(prior.get("stack_config"))

    region = _text(intakes.get("region") or aws_region) or "eu-north-1"
    need_rds = intakes.get("need_rds")
    if need_rds is None:
        need_rds = bool(detected.get("has_database"))
    need_redis = intakes.get("need_redis")
    if need_redis is None:
        need_redis = bool(detected.get("has_redis"))

    need_alb = intakes.get("need_alb")
    if need_alb is None:
        need_alb = bool(intakes.get("ha")) or _traffic_suggests_alb(intakes)

    need_eip = intakes.get("need_eip")
    if need_eip is None:
        # Single-instance public front door prefers EIP; ALB stacks usually do not.
        need_eip = not bool(need_alb)

    ha = bool(intakes.get("ha") or need_alb)

    components = ["vpc", "ec2"]
    if need_alb:
        components.append("alb")
    if need_eip:
        components.append("eip")
    if need_rds:
        components.append("rds")
    if need_redis:
        components.append("elasticache")

    ec2 = {
        **_default_ec2(intakes, region, profile),
        **_as_record(prior_stack.get("ec2")),
        **_as_record(prior_stack.get("ec2-instance")),
    }
    if intakes.get("instance_type"):
        ec2["instance_type"] = intakes["instance_type"] if intakes["instance_type"] in _INSTANCE_TYPES else ec2.get("instance_type")
    if intakes.get("root_volume_size_gb"):
        ec2["root_volume_size_gb"] = intakes["root_volume_size_gb"]
    if intakes.get("app_port"):
        ec2["app_port"] = intakes["app_port"]
    ec2["aws_region"] = region
    ec2["desired_count"] = 2 if ha else 1
    if need_alb:
        ec2["behind_alb"] = True
        ec2["public_http"] = False
    if intakes.get("direct_port_routing") is False:
        ec2["public_http"] = False
        ec2["direct_port_routing"] = False
    if need_eip:
        ec2["associate_eip"] = True

    app_port = int(ec2.get("app_port") or 3000)
    if need_alb or intakes.get("direct_port_routing") is False:
        ports_exposed = [80, 443]
    else:
        ports_exposed = [app_port]

    stack_config: dict[str, Any] = {
        "ec2": ec2,
        "networking": {
            **_as_record(prior_stack.get("networking")),
            "vpc": "new",
            "public_subnets": True,
            "private_subnets": bool(need_rds or need_redis or need_alb),
            "nat_gateway": bool(need_alb and (need_rds or need_redis)),
            "load_balancer": {"public": True, "type": "application"} if need_alb else {},
            "ports_exposed": ports_exposed,
        },
    }

    if need_alb:
        stack_config["alb"] = {
            **_as_record(prior_stack.get("alb")),
            "enabled": True,
            "scheme": "internet-facing",
            "listeners": ["http", "https"],
            "health_check_path": "/",
            "target_port": app_port,
            "need_alb": True,
        }
    if need_eip:
        stack_config["eip"] = {
            **_as_record(prior_stack.get("eip")),
            "enabled": True,
            "associate_with": "ec2",
            "need_eip": True,
        }

    if need_rds:
        db_type = _text(detected.get("database_type")).lower()
        engine = "mysql" if db_type in {"mysql", "mariadb"} else "postgres"
        stack_config["rds"] = {
            **_as_record(prior_stack.get("rds")),
            "engine": engine,
            "engine_version": "8.0" if engine == "mysql" else "15.10" if engine == "postgres" else "10.11",
            "instance_class": "db.t3.micro",
            "allocated_storage": 20,
            "multi_az": bool(ha),
            "backup_retention_period": 7,
            "deletion_protection": False,
            "publicly_accessible": False,
        }

    if need_redis:
        stack_config["elasticache"] = {
            **_as_record(prior_stack.get("elasticache")),
            "engine": "redis",
            "node_type": "cache.t4g.micro",
        }

    notes: list[str] = []
    if intakes.get("monthly_traffic") is not None:
        notes.append(f"Monthly traffic sized for {intakes['monthly_traffic']}.")
    if intakes.get("peak_traffic") is not None:
        notes.append(f"Peak traffic sized for {intakes['peak_traffic']}.")
    if need_alb:
        notes.append("ALB is the public HTTP front door.")
    if need_eip:
        notes.append("Elastic IP kept for a stable address.")
    if need_alb and need_eip:
        notes.append("ALB handles HTTP; EIP stays attached for a stable address.")
    if intakes.get("direct_port_routing") is False:
        disabled = intakes.get("disabled_public_port") or app_port
        notes.append(f"Direct :{disabled} public routing disabled; traffic enters via {'ALB 80/443' if need_alb else 'non-public app port only'}.")
    if intakes.get("app_port"):
        notes.append(f"App listens on port {intakes['app_port']}.")
    if not notes:
        notes.append("Plan reflects repository detection and your chat requests.")

    outputs = ["ec2_instance_id", "ec2_public_ip", "ec2_public_dns", "app_url"]
    if need_alb:
        outputs.extend(["alb_dns_name", "load_balancer_dns_name"])
    if need_eip:
        outputs.append("elastic_ip")
    if need_rds:
        outputs.append("rds_endpoint")
    if need_redis:
        outputs.append("redis_endpoint")

    return {
        "provider": "aws",
        "region": region,
        "components": components,
        "deploy_sequence": list(components),
        "stack_config": stack_config,
        "outputs_to_capture": outputs,
        "consultant_notes": notes,
        "intakes": intakes,
        "need_alb": bool(need_alb),
        "need_eip": bool(need_eip),
        "open_questions": [],
    }


def compute_open_questions(
    *,
    intakes: dict[str, Any],
    detected: dict[str, Any],
    turn_count: int,
    force_decision: bool,
) -> list[str]:
    # Keep the chat open for several turns so operators can actually answer intake questions.
    if force_decision or turn_count >= 8:
        return []
    questions: list[str] = []
    if intakes.get("need_alb") is None and not _traffic_suggests_alb(intakes) and not intakes.get("ha"):
        questions.append("Do you need an Application Load Balancer (ALB), or is a single EC2 public endpoint enough?")
    if intakes.get("need_eip") is None and intakes.get("need_alb") is not True:
        questions.append("Do you want a stable Elastic IP for this app?")
    if intakes.get("monthly_traffic") is None and intakes.get("peak_traffic") is None:
        questions.append("What monthly request volume or peak concurrent users should we size for?")
    if detected.get("has_database") and intakes.get("need_rds") is None:
        questions.append("Should I include managed RDS for the detected database dependency?")
    if detected.get("has_redis") and intakes.get("need_redis") is None:
        questions.append("Should I include ElastiCache Redis for the detected cache dependency?")
    return questions[:3]


def summarize_decision(decision: dict[str, Any], detected: dict[str, Any], aws_region: str) -> str:
    components = [str(item) for item in (decision.get("components") or []) if str(item).strip()]
    stack = _as_record(decision.get("stack_config"))
    lines = [
        f"AWS region: {_text(decision.get('region') or aws_region) or 'unknown'}",
        f"Components: {', '.join(components) or 'none'}",
        f"Deploy order: {' -> '.join(str(item) for item in (decision.get('deploy_sequence') or components))}",
    ]
    ec2 = _as_record(stack.get("ec2"))
    if ec2:
        lines.append(
            f"EC2: {_text(ec2.get('instance_type')) or '?'}, "
            f"root={ec2.get('root_volume_size_gb') or '?'}GB, "
            f"app_port={ec2.get('app_port') or '?'}"
        )
    alb = _as_record(stack.get("alb"))
    if alb or decision.get("need_alb"):
        lines.append(f"ALB: enabled (target_port={alb.get('target_port') or ec2.get('app_port') or '?'})")
    eip = _as_record(stack.get("eip"))
    if eip or decision.get("need_eip"):
        lines.append("Elastic IP: enabled")
    networking = _as_record(stack.get("networking"))
    ports_exposed = networking.get("ports_exposed")
    if isinstance(ports_exposed, list) and ports_exposed:
        lines.append(f"Public listeners: {', '.join(str(item) for item in ports_exposed)}")
    if ec2.get("direct_port_routing") is False or ec2.get("public_http") is False:
        lines.append("Direct public app-port routing: off")
    rds = _as_record(stack.get("rds"))
    if rds:
        lines.append(
            f"RDS: {_text(rds.get('engine')) or 'db'} {_text(rds.get('instance_class'))}, "
            f"multi-AZ={bool(rds.get('multi_az'))}"
        )
    elif detected.get("has_database"):
        lines.append("Database: repo indicates a datastore, but no DB component was selected.")
    cache = _as_record(stack.get("elasticache"))
    if cache:
        lines.append(f"Cache: {_text(cache.get('engine') or 'redis')} {_text(cache.get('node_type'))}")
    intakes = _as_record(decision.get("intakes"))
    if intakes.get("monthly_traffic") is not None:
        lines.append(f"Monthly traffic: {intakes['monthly_traffic']}")
    if intakes.get("peak_traffic") is not None:
        lines.append(f"Peak traffic/users: {intakes['peak_traffic']}")
    notes = [str(item).strip() for item in (decision.get("consultant_notes") or []) if str(item).strip()]
    if notes:
        lines.append(f"Notes: {' | '.join(notes)}")
    return "\n".join(lines)


def describe_decision_deltas(prior: dict[str, Any] | None, current: dict[str, Any]) -> list[str]:
    """Human-readable summary of what changed vs the previous plan."""
    before = _as_record(prior)
    if not before:
        return []
    changes: list[str] = []
    before_components = {str(item).lower() for item in (before.get("components") or [])}
    after_components = {str(item).lower() for item in (current.get("components") or [])}
    added = sorted(after_components - before_components)
    removed = sorted(before_components - after_components)
    if added:
        changes.append(f"Added: {', '.join(added)}.")
    if removed:
        changes.append(f"Removed: {', '.join(removed)}.")

    before_stack = _as_record(before.get("stack_config"))
    after_stack = _as_record(current.get("stack_config"))
    before_ec2 = _as_record(before_stack.get("ec2"))
    after_ec2 = _as_record(after_stack.get("ec2"))
    if before_ec2.get("app_port") != after_ec2.get("app_port") and after_ec2.get("app_port") is not None:
        changes.append(f"App port is now {after_ec2.get('app_port')}.")
    if before_ec2.get("instance_type") != after_ec2.get("instance_type") and after_ec2.get("instance_type"):
        changes.append(f"Instance type is now {after_ec2.get('instance_type')}.")
    if before_ec2.get("public_http") is True and after_ec2.get("public_http") is False:
        changes.append("Direct public app-port routing is off.")
    if after_ec2.get("direct_port_routing") is False and before_ec2.get("direct_port_routing") is not False:
        changes.append("Direct public port routing disabled.")

    before_net = _as_record(before_stack.get("networking"))
    after_net = _as_record(after_stack.get("networking"))
    if before_net.get("ports_exposed") != after_net.get("ports_exposed") and after_net.get("ports_exposed") is not None:
        changes.append(f"Public listeners: {', '.join(str(item) for item in after_net.get('ports_exposed') or [])}.")

    if _text(before.get("region")) and _text(current.get("region")) and _text(before.get("region")) != _text(current.get("region")):
        changes.append(f"Region is now {_text(current.get('region'))}.")
    return changes[:5]


def build_assistant_message(
    *,
    decision: dict[str, Any],
    detected: dict[str, Any],
    aws_region: str,
    open_questions: list[str],
    ready: bool,
    source: str,
    fallback_reason: str | None = None,
    change_notes: list[str] | None = None,
) -> str:
    parts: list[str] = []
    if change_notes:
        parts.append("Updated the plan from your latest message:")
        for note in change_notes:
            parts.append(f"- {note}")
        parts.append("")
    elif source == "llm":
        parts.append("Updated plan from your chat and repository analysis.")
        parts.append("")
    else:
        parts.append("Updated plan from your chat and repository analysis.")
        parts.append("")

    parts.append(summarize_decision(decision, detected, aws_region))

    if open_questions and not ready:
        parts.append("")
        parts.append("Before we lock this in:")
        for index, question in enumerate(open_questions, start=1):
            parts.append(f"{index}. {question}")
        parts.append("")
        parts.append('Reply with those details, or say "use this plan" to continue.')
    else:
        parts.append("")
        parts.append("Ready for review — approve to continue, or ask for another change.")
    return "\n".join(parts)


def _llm_available(
    *,
    llm_provider: str | None = None,
    llm_api_key: str | None = None,
    llm_api_base_url: str | None = None,
) -> tuple[bool, str]:
    if _text(llm_api_key) or _text(os.getenv("GROQ_API_KEY")) or _text(os.getenv("OPENROUTER_API_KEY")) or _text(os.getenv("OPENAI_API_KEY")):
        return True, ""
    if _text(llm_api_base_url) or _text(os.getenv("OLLAMA_BASE_URL")):
        return True, ""
    if _text(os.getenv("ANTHROPIC_API_KEY")) or _text(os.getenv("CLAUDE_API_KEY")):
        return True, ""
    if _text(llm_provider).lower() == "ollama":
        return True, ""
    return False, "no_llm_api_keys"


def _resolve_openai_compatible() -> dict[str, str] | None:
    if _text(os.getenv("GROQ_API_KEY")):
        return {
            "provider": "groq",
            "api_key": os.getenv("GROQ_API_KEY", "").strip(),
            "model": os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile").strip(),
            "base_url": os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1").strip().rstrip("/"),
        }
    if _text(os.getenv("OPENROUTER_API_KEY")):
        return {
            "provider": "openrouter",
            "api_key": os.getenv("OPENROUTER_API_KEY", "").strip(),
            "model": os.getenv("OPENROUTER_MODEL", "openrouter/auto").strip(),
            "base_url": os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").strip().rstrip("/"),
        }
    if _text(os.getenv("OPENAI_API_KEY")):
        return {
            "provider": "openai",
            "api_key": os.getenv("OPENAI_API_KEY", "").strip(),
            "model": os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip(),
            "base_url": os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").strip().rstrip("/"),
        }
    ollama_base = _text(os.getenv("OLLAMA_BASE_URL") or "http://127.0.0.1:11434/v1")
    if ollama_base:
        return {
            "provider": "ollama",
            "api_key": _text(os.getenv("OLLAMA_API_KEY")) or "ollama",
            "model": os.getenv("OLLAMA_MODEL", "llama3.2").strip(),
            "base_url": ollama_base.rstrip("/"),
        }
    return None


def _call_llm_decision_overlay(
    *,
    detected: dict[str, Any],
    intakes: dict[str, Any],
    heuristic: dict[str, Any],
    conversation_history: list[dict[str, Any]],
    llm_provider: str | None,
    llm_api_key: str | None,
    llm_model: str | None,
    llm_api_base_url: str | None,
) -> dict[str, Any] | None:
    config = None
    if _text(llm_api_key) and _text(llm_api_base_url):
        config = {
            "provider": _text(llm_provider) or "custom",
            "api_key": _text(llm_api_key),
            "model": _text(llm_model) or "gpt-4o-mini",
            "base_url": _text(llm_api_base_url).rstrip("/"),
        }
    else:
        config = _resolve_openai_compatible()
    if not config:
        return None

    system_prompt = (
        "You are DeplAI's infrastructure consultant. "
        "Return exactly one JSON object with keys: "
        "assistant_message (string), ready (boolean), open_questions (string array), "
        "decision (object with components, deploy_sequence, stack_config, outputs_to_capture, "
        "consultant_notes, need_alb, need_eip, region). "
        "Honor user chat intakes for ALB, Elastic IP, traffic, HA, region, instance type, RDS, and Redis. "
        "Do not silently drop ALB/EIP when the user asked for them. "
        "Prefer EC2 + optional ALB/EIP/RDS/ElastiCache for this vertical slice."
    )
    user_prompt = json.dumps(
        {
            "detected": detected,
            "intakes": intakes,
            "heuristic_decision": heuristic,
            "conversation_history": conversation_history[-12:],
        },
        ensure_ascii=True,
        default=str,
    )
    endpoint = f"{config['base_url']}/chat/completions"
    payload = {
        "model": config["model"],
        "temperature": 0.1,
        "max_tokens": 1800,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config['api_key']}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            body = json.loads(response.read().decode("utf-8"))
        content = body["choices"][0]["message"]["content"]
        parsed = json.loads(content if isinstance(content, str) else json.dumps(content))
        return parsed if isinstance(parsed, dict) else None
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, KeyError, IndexError, json.JSONDecodeError, TypeError) as exc:
        logger.warning("terraform consult LLM overlay failed: %s", exc)
        return None


def _merge_llm_overlay(heuristic: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    decision = deepcopy(heuristic)
    raw = _as_record(overlay.get("decision"))
    if not raw:
        return decision

    components = [str(item).strip().lower() for item in (raw.get("components") or []) if str(item).strip()]
    if components:
        # Preserve operator-critical ALB/EIP flags from heuristic intakes.
        if decision.get("need_alb") and "alb" not in components:
            components.append("alb")
        if decision.get("need_eip") and "eip" not in components:
            components.append("eip")
        decision["components"] = components
        decision["deploy_sequence"] = [
            str(item).strip().lower() for item in (raw.get("deploy_sequence") or components) if str(item).strip()
        ]

    stack = _as_record(raw.get("stack_config"))
    merged_stack = deepcopy(_as_record(decision.get("stack_config")))
    for key, value in stack.items():
        if isinstance(value, dict):
            merged_stack[key] = {**_as_record(merged_stack.get(key)), **value}
        else:
            merged_stack[key] = value
    if decision.get("need_alb"):
        merged_stack["alb"] = {**_as_record(merged_stack.get("alb")), "enabled": True, "need_alb": True}
    if decision.get("need_eip"):
        merged_stack["eip"] = {**_as_record(merged_stack.get("eip")), "enabled": True, "need_eip": True}
    decision["stack_config"] = merged_stack

    if raw.get("outputs_to_capture"):
        decision["outputs_to_capture"] = [str(item) for item in raw.get("outputs_to_capture") if str(item).strip()]
    if raw.get("consultant_notes"):
        decision["consultant_notes"] = [str(item) for item in raw.get("consultant_notes") if str(item).strip()]
    if _text(raw.get("region")):
        decision["region"] = _text(raw.get("region"))
    if isinstance(raw.get("need_alb"), bool):
        decision["need_alb"] = raw["need_alb"] or bool(decision.get("need_alb"))
    if isinstance(raw.get("need_eip"), bool):
        decision["need_eip"] = raw["need_eip"] or bool(decision.get("need_eip"))
    return decision


def _persist_consult_state(
    *,
    workspace: str,
    transcript: list[dict[str, Any]],
    decision: dict[str, Any],
    turn_count: int,
    ready: bool,
    open_questions: list[str],
    repo_detection_summary: str,
    source: str,
    fallback_reason: str | None,
) -> None:
    key = slugify(workspace)
    write_json(
        consult_transcript_path(key),
        {
            "workspace": key,
            "messages": transcript,
            "turn_count": turn_count,
        },
    )
    write_json(consult_decision_path(key), decision)
    write_json(
        consult_state_path(key),
        {
            "workspace": key,
            "turn_count": turn_count,
            "ready": ready,
            "open_questions": open_questions,
            "repo_detection_summary": repo_detection_summary,
            "source": source,
            "fallback_reason": fallback_reason,
            "decision": decision,
        },
    )


def run_terraform_consult(
    *,
    architecture_json: dict[str, Any],
    repository_context: dict[str, Any] | None = None,
    deployment_profile: dict[str, Any] | None = None,
    detected: dict[str, Any] | None = None,
    aws_region: str = "eu-north-1",
    conversation_history: list[dict[str, Any]] | None = None,
    turn_count: int = 0,
    force_decision: bool = False,
    workspace: str | None = None,
    project_id: str | None = None,
    project_name: str | None = None,
    user_answers: dict[str, Any] | None = None,
    prior_decision: dict[str, Any] | None = None,
    llm_provider: str | None = None,
    llm_api_key: str | None = None,
    llm_model: str | None = None,
    llm_api_base_url: str | None = None,
) -> dict[str, Any]:
    history = [item for item in (conversation_history or []) if isinstance(item, dict)]
    workspace_key = slugify(workspace or project_name or project_id or "default")

    persisted = read_json_optional(consult_state_path(workspace_key)) or {}
    if not prior_decision:
        prior_decision = _as_record(persisted.get("decision"))
    if not history:
        persisted_transcript = read_json_optional(consult_transcript_path(workspace_key)) or {}
        history = [
            item
            for item in (persisted_transcript.get("messages") or [])
            if isinstance(item, dict)
        ]

    detected_signals = infer_detected_signals(
        architecture_json=architecture_json,
        repository_context=repository_context,
        deployment_profile=deployment_profile,
        detected=detected,
    )
    intakes = parse_chat_intakes(history, user_answers)
    heuristic = build_heuristic_decision(
        detected=detected_signals,
        intakes=intakes,
        deployment_profile=deployment_profile,
        aws_region=aws_region,
        prior_decision=prior_decision,
    )
    change_notes = describe_decision_deltas(prior_decision, heuristic)

    next_turn = max(int(turn_count or 0), int(persisted.get("turn_count") or 0)) + 1
    open_questions = compute_open_questions(
        intakes=intakes,
        detected=detected_signals,
        turn_count=next_turn,
        force_decision=force_decision,
    )

    source = "heuristic"
    fallback_reason: str | None = None
    assistant_override: str | None = None
    decision = heuristic

    llm_ok, llm_reason = _llm_available(
        llm_provider=llm_provider,
        llm_api_key=llm_api_key,
        llm_api_base_url=llm_api_base_url,
    )
    if llm_ok and not force_decision:
        overlay = _call_llm_decision_overlay(
            detected=detected_signals,
            intakes=intakes,
            heuristic=heuristic,
            conversation_history=history,
            llm_provider=llm_provider,
            llm_api_key=llm_api_key,
            llm_model=llm_model,
            llm_api_base_url=llm_api_base_url,
        )
        if overlay:
            decision = _merge_llm_overlay(heuristic, overlay)
            source = "llm"
            change_notes = describe_decision_deltas(prior_decision, decision) or change_notes
            if isinstance(overlay.get("open_questions"), list):
                open_questions = [str(item).strip() for item in overlay["open_questions"] if str(item).strip()]
            if _text(overlay.get("assistant_message")):
                assistant_override = _text(overlay.get("assistant_message"))
            if isinstance(overlay.get("ready"), bool) and overlay.get("ready"):
                open_questions = []
        else:
            # Keep serving the heuristic plan; do not block chat on LLM outages.
            fallback_reason = "llm_call_failed"
            source = "heuristic"
    else:
        fallback_reason = llm_reason or "llm_unavailable"
        source = "heuristic"

    # Force / long threads eventually produce a ready decision; otherwise stay in Q&A.
    # Follow-up refinements should publish an updated ready plan immediately.
    latest_deltas = parse_message_deltas(_latest_user_message(history))
    follow_up_change = bool(latest_deltas) and bool(prior_decision)
    ready = force_decision or next_turn >= 8 or not open_questions or follow_up_change
    if ready:
        open_questions = []
    decision["open_questions"] = list(open_questions)
    decision["ready"] = ready

    repo_summary = build_repo_detection_summary(detected_signals)
    decision_summary = summarize_decision(decision, detected_signals, aws_region)
    assistant_message = assistant_override or build_assistant_message(
        decision=decision,
        detected=detected_signals,
        aws_region=_text(decision.get("region") or aws_region),
        open_questions=open_questions,
        ready=ready,
        source=source,
        fallback_reason=None,  # never surface internal LLM failure strings to the operator
        change_notes=change_notes,
    )

    transcript = list(history)
    transcript.append({"role": "assistant", "content": assistant_message})
    _persist_consult_state(
        workspace=workspace_key,
        transcript=transcript,
        decision=decision,
        turn_count=next_turn,
        ready=ready,
        open_questions=open_questions,
        repo_detection_summary=repo_summary,
        source=source,
        fallback_reason=fallback_reason,
    )

    return {
        "success": True,
        "assistant_message": assistant_message,
        "ready": ready,
        "decision": decision,
        "open_questions": open_questions,
        "repo_detection_summary": repo_summary,
        "turn_count": next_turn,
        "decision_summary": decision_summary,
        "source": source,
        "fallback_reason": fallback_reason,
        "error": None,
    }
