import os
from pathlib import Path

from dotenv import load_dotenv


def _to_int(value: str | None, default: int) -> int:
    try:
        return int(value) if value is not None else default
    except (TypeError, ValueError):
        return default


PROJECT_ROOT = Path(__file__).resolve().parent
ROOT_ENV_PATH = PROJECT_ROOT / ".env"
RAG_ENV_PATH = PROJECT_ROOT / "terraform_rag_agent" / ".env"

# Load root env first (source of truth), then optional RAG env as fallback.
if ROOT_ENV_PATH.exists():
    load_dotenv(dotenv_path=ROOT_ENV_PATH, override=False)
if RAG_ENV_PATH.exists():
    load_dotenv(dotenv_path=RAG_ENV_PATH, override=False)

# RabbitMQ Configuration
MQ_HOST = os.getenv("MQ_HOST", "localhost")
MQ_PORT = _to_int(os.getenv("MQ_PORT"), 5672)
MQ_USERNAME = os.getenv("MQ_USERNAME", "guest")
MQ_PASSWORD = os.getenv("MQ_PASSWORD", "guest")

# OpenAI Configuration
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

# Hugging Face Configuration
HUGGING_FACE_HUB_TOKEN = os.getenv("HUGGING_FACE_HUB_TOKEN")

# Tavily Configuration
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY")

# AWS Configuration
AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID")
AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")
AWS_REGION = os.getenv("AWS_REGION")

# Redis Configuration
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = _to_int(os.getenv("REDIS_PORT"), 6379)
