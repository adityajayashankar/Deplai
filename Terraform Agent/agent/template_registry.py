from pathlib import Path

# Base directory — resolved relative to this file's location
TEMPLATES_DIR = Path(__file__).parent / "templates"

SERVICE_TEMPLATE_MAP: dict[str, Path] = {
    "ec2": TEMPLATES_DIR / "ec2",
    "s3": TEMPLATES_DIR / "s3",
    "rds": TEMPLATES_DIR / "rds",
    "vpc": TEMPLATES_DIR / "vpc",
    "ecs": TEMPLATES_DIR / "ecs",
    "lambda": TEMPLATES_DIR / "lambda",
    "elasticache": TEMPLATES_DIR / "elasticache",
    "alb": TEMPLATES_DIR / "alb",
}

PARAM_SCHEMA: dict[str, list[dict]] = {
    "ec2": [
        {"name": "instance_name", "type": "string", "required": True},
        {"name": "instance_type", "type": "string", "default": "t3.micro"},
        {"name": "aws_region", "type": "string", "default": "us-east-1"},
        {"name": "ami_id", "type": "string", "default": ""},
        {"name": "key_pair_name", "type": "string", "default": "deplai-keypair"},
        {"name": "root_volume_size_gb", "type": "number", "default": 20},
        {"name": "environment", "type": "string", "default": "production"},
        {"name": "project_id", "type": "string", "required": True},
        {"name": "user_data", "type": "string", "default": ""},
    ],
    "s3": [
        {"name": "bucket_name", "type": "string", "required": True},
        {"name": "aws_region", "type": "string", "default": "us-east-1"},
        {"name": "versioning", "type": "bool", "default": False},
        {"name": "force_destroy", "type": "bool", "default": True},
        {"name": "environment", "type": "string", "default": "production"},
        {"name": "project_id", "type": "string", "required": True},
    ],
    "rds": [
        {"name": "db_name", "type": "string", "required": True},
        {"name": "db_username", "type": "string", "required": True},
        {"name": "db_password", "type": "string", "required": True, "sensitive": True},
        {"name": "instance_class", "type": "string", "default": "db.t3.micro"},
        {"name": "engine", "type": "string", "default": "mysql"},
        {"name": "engine_version", "type": "string", "default": "8.0"},
        {"name": "aws_region", "type": "string", "default": "us-east-1"},
        {"name": "project_id", "type": "string", "required": True},
    ],
    "vpc": [
        {"name": "vpc_name", "type": "string", "required": True},
        {"name": "cidr", "type": "string", "default": "10.0.0.0/16"},
        {"name": "aws_region", "type": "string", "default": "us-east-1"},
        {"name": "azs", "type": "list", "default": ["us-east-1a", "us-east-1b"]},
        {"name": "private_subnets", "type": "list", "default": ["10.0.1.0/24", "10.0.2.0/24"]},
        {"name": "public_subnets", "type": "list", "default": ["10.0.101.0/24", "10.0.102.0/24"]},
        {"name": "project_id", "type": "string", "required": True},
    ],
    "ecs": [
        {"name": "cluster_name", "type": "string", "required": True},
        {"name": "container_image", "type": "string", "required": True},
        {"name": "container_port", "type": "number", "default": 80},
        {"name": "cpu", "type": "number", "default": 256},
        {"name": "memory", "type": "number", "default": 512},
        {"name": "aws_region", "type": "string", "default": "us-east-1"},
        {"name": "project_id", "type": "string", "required": True},
    ],
    "lambda": [
        {"name": "function_name", "type": "string", "required": True},
        {"name": "runtime", "type": "string", "default": "python3.12"},
        {"name": "handler", "type": "string", "default": "index.handler"},
        {"name": "memory_size", "type": "number", "default": 128},
        {"name": "timeout", "type": "number", "default": 30},
        {"name": "aws_region", "type": "string", "default": "us-east-1"},
        {"name": "project_id", "type": "string", "required": True},
    ],
    "elasticache": [
        {"name": "cluster_id", "type": "string", "required": True},
        {"name": "engine", "type": "string", "default": "redis"},
        {"name": "node_type", "type": "string", "default": "cache.t3.micro"},
        {"name": "num_cache_nodes", "type": "number", "default": 1},
        {"name": "aws_region", "type": "string", "default": "us-east-1"},
        {"name": "project_id", "type": "string", "required": True},
    ],
    "alb": [
        {"name": "alb_name", "type": "string", "required": True},
        {"name": "internal", "type": "bool", "default": False},
        {"name": "target_port", "type": "number", "default": 80},
        {"name": "aws_region", "type": "string", "default": "us-east-1"},
        {"name": "project_id", "type": "string", "required": True},
    ],
}

SUPPORTED_SERVICES = list(SERVICE_TEMPLATE_MAP.keys())

def get_template_path(service_type: str) -> Path:
    if service_type not in SERVICE_TEMPLATE_MAP:
        raise ValueError(f"Unsupported service type: {service_type}. Supported: {SUPPORTED_SERVICES}")
    return SERVICE_TEMPLATE_MAP[service_type]

def get_param_schema(service_type: str) -> list[dict]:
    return PARAM_SCHEMA.get(service_type, [])
