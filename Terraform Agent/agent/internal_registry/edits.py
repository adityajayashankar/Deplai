"""Agent-owned fill of catalog edit_schema.

Operators toggle which services exist (RDS on/off, ALB, EIP). They do not pick
instance types, disk sizes, engine pins, or other allowlisted module knobs —
the Terraform agent fills those from workload facts (runtime, traffic, env).
"""

from __future__ import annotations

from typing import Any

from .catalog import filter_allowlisted_edits, get_edit_schema

_APPROVED_EC2_TYPES = ("t3.micro", "t3.small", "t3.medium")
_POSTGRES_CURRENT = "15.17"
_DATASTORE_PORTS = frozenset({5432, 3306, 6379, 27017, 1433, 1521})
_NODE_WORKSPACE_COMMAND = "deplai-node-workspace"


def _as_record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _as_records(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _canonical_environment(value: str) -> str:
    compact = str(value or "").strip().lower()
    if compact in {"production", "prod"}:
        return "prod"
    if compact in {"development", "dev"}:
        return "dev"
    if compact == "staging":
        return "staging"
    return compact or "dev"


def _canonical_strategy(value: str) -> str:
    compact = str(value or "").strip().lower()
    if compact in {"ec2-instance", "ec2_instance"}:
        return "ec2"
    if compact in {"cloudfront", "s3cloudfront"}:
        return "s3_cloudfront"
    return compact or "ec2"


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _schema_item(service: str, name: str) -> dict[str, Any]:
    for item in get_edit_schema(service):
        if isinstance(item, dict) and str(item.get("name") or "").strip() == name:
            return item
    return {}


def _clamp_number(service: str, name: str, value: Any, default: int) -> int:
    item = _schema_item(service, name)
    number = _int(value, _int(item.get("default"), default))
    minimum = item.get("min")
    maximum = item.get("max")
    if minimum is not None:
        number = max(_int(minimum, number), number)
    if maximum is not None:
        number = min(_int(maximum, number), number)
    return number


def _max_service_resource(services: list[dict[str, Any]], key: str) -> int:
    values = [_int(item.get(key), 0) for item in services]
    return max(values) if values else 0


def _web_port(services: list[dict[str, Any]], default: int = 3000) -> int:
    web = next(
        (item for item in services if str(item.get("process_type") or "").strip().lower() == "web"),
        {},
    )
    port = _int(web.get("port") or (services[0].get("port") if services else 0), 0)
    if port <= 0 or port > 65535 or port in _DATASTORE_PORTS:
        return default
    return port


def _pick_ec2_instance_type(
    *,
    cpu: int,
    memory: int,
    environment: str,
    app_kind: str,
    start_command: str = "",
) -> str:
    if str(start_command or "").strip() == _NODE_WORKSPACE_COMMAND:
        return "t3.medium"
    kind = str(app_kind or "").strip().lower()
    heavy_runtime = kind in {"node", "python", "java", "go", "dotnet", "docker"}
    if environment == "prod" or cpu >= 1024 or memory >= 2048:
        return "t3.medium"
    if heavy_runtime or cpu >= 512 or memory >= 1024:
        return "t3.small"
    return "t3.micro"


def _pick_root_volume_gb(*, app_kind: str, environment: str, start_command: str = "") -> int:
    if str(start_command or "").strip() == _NODE_WORKSPACE_COMMAND:
        return 40
    kind = str(app_kind or "").strip().lower()
    if kind == "docker":
        return 40
    if kind in {"node", "python", "java", "go", "dotnet", "php", "ruby", "rust"}:
        return 35
    if environment == "prod":
        return 20
    return 8


def _pick_rds_instance_class(*, environment: str, cpu: int, memory: int) -> str:
    if environment == "prod" or cpu >= 1024 or memory >= 2048:
        return "db.t4g.small"
    return "db.t4g.micro"


def _pick_cache_node_type(*, environment: str, cpu: int) -> str:
    if environment == "prod" or cpu >= 1024:
        return "cache.t4g.small"
    return "cache.t4g.micro"


def _rds_engine(data_layer: list[dict[str, Any]]) -> str:
    item = next(
        (
            row
            for row in data_layer
            if str(row.get("type") or "").strip().lower() in {"postgresql", "postgres", "mysql", "mariadb", "rds"}
        ),
        {},
    )
    engine = str(item.get("engine") or item.get("type") or "postgres").strip().lower()
    if engine in {"postgresql", "rds"}:
        engine = "postgres"
    if engine not in {"postgres", "mysql", "mariadb"}:
        return "postgres"
    return engine


def _rds_engine_version(engine: str) -> str:
    if engine == "mysql":
        return "8.0"
    if engine == "mariadb":
        return "10.11"
    return _POSTGRES_CURRENT


def select_allowlisted_edits(
    profile: dict[str, Any] | None,
    *,
    app_bootstrap: dict[str, Any] | None = None,
) -> dict[str, dict[str, Any]]:
    """Fill catalog edit_schema from profile facts. Ignore operator stack_config sizing."""
    payload = _as_record(profile)
    bootstrap = _as_record(app_bootstrap)
    compute = _as_record(payload.get("compute"))
    services = _as_records(compute.get("services"))
    data_layer = _as_records(payload.get("data_layer"))
    operational = _as_record(payload.get("operational"))
    static_site = _as_record(payload.get("static_site"))
    environment = _canonical_environment(str(payload.get("environment") or "dev"))
    strategy = _canonical_strategy(str(compute.get("strategy") or "ec2"))
    app_kind = str(bootstrap.get("app_kind") or payload.get("app_kind") or "").strip().lower()
    start_command = str(bootstrap.get("start_command") or "").strip()
    cpu = _max_service_resource(services, "cpu")
    memory = _max_service_resource(services, "memory")
    app_port = _web_port(services, default=3000)
    bootstrap_port = _int(bootstrap.get("app_port"), 0)
    if 1 <= bootstrap_port <= 65535 and bootstrap_port not in _DATASTORE_PORTS:
        app_port = bootstrap_port
    if app_port in _DATASTORE_PORTS:
        app_port = 3000
    health_path = str(operational.get("health_check_path") or "/").strip() or "/"

    has_postgres = any(
        str(item.get("type") or "").strip().lower() in {"postgresql", "postgres", "mysql", "mariadb", "rds"}
        for item in data_layer
    )
    has_redis = any(str(item.get("type") or "").strip().lower() in {"redis", "elasticache"} for item in data_layer)

    edits: dict[str, dict[str, Any]] = {}

    if strategy in {"ec2", "ecs_fargate"}:
        instance_type = _pick_ec2_instance_type(
            cpu=cpu,
            memory=memory,
            environment=environment,
            app_kind=app_kind,
            start_command=start_command,
        )
        if instance_type not in _APPROVED_EC2_TYPES:
            instance_type = "t3.micro"
        edits["ec2_instance"] = filter_allowlisted_edits(
            "ec2_instance",
            {
                "instance_type": instance_type,
                "root_volume_size_gb": _clamp_number(
                    "ec2_instance",
                    "root_volume_size_gb",
                    _pick_root_volume_gb(app_kind=app_kind, environment=environment, start_command=start_command),
                    8,
                ),
                "app_port": app_port,
                "ssh_cidrs": [],
                "ssh_ingress_cidr_blocks": [],
            },
        )
        edits["alb"] = filter_allowlisted_edits(
            "alb",
            {
                "enable_alb": bool(payload.get("need_alb"))
                or bool(_as_record(_as_record(payload.get("networking")).get("load_balancer"))),
                "app_port": app_port,
                "health_path": health_path,
            },
        )

    if has_postgres:
        engine = _rds_engine(data_layer)
        edits["rds"] = filter_allowlisted_edits(
            "rds",
            {
                "engine": engine,
                "engine_version": _rds_engine_version(engine),
                "instance_class": _pick_rds_instance_class(environment=environment, cpu=cpu, memory=memory),
                "allocated_storage": 20,
                "multi_az": environment == "prod",
            },
        )

    if has_redis:
        edits["elasticache"] = filter_allowlisted_edits(
            "elasticache",
            {
                "node_type": _pick_cache_node_type(environment=environment, cpu=cpu),
                "engine_version": "7.0",
            },
        )

    if strategy == "s3_cloudfront":
        price_class = str(static_site.get("price_class") or "PriceClass_100").strip() or "PriceClass_100"
        if price_class not in {"PriceClass_100", "PriceClass_200", "PriceClass_All"}:
            price_class = "PriceClass_100"
        edits["s3_cloudfront"] = filter_allowlisted_edits(
            "s3_cloudfront",
            {
                "price_class": price_class,
                "default_root_object": "index.html",
            },
        )

    return edits
