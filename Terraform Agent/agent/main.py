"""main.py – Entry point for the LangGraph Terraform agent.

Usage
-----
  # Point at a real repository:
  python main.py --repo /path/to/your/project

  # Use the built-in example fixture (original behaviour):
  python main.py --example
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from dotenv import load_dotenv

from graph import build_graph
from state import AgentState


# ──────────────────────────────────────────────────────────────────────────────
# State builders
# ──────────────────────────────────────────────────────────────────────────────

def _empty_state(repo_path: str) -> AgentState:
    """Minimal initial state that points the agent at a real repo on disk.

    The repo_parser node will call ``tools.repo_reader.read_repo`` to populate
    ``raw_file_tree`` and ``raw_file_contents`` from disk.
    """
    return {
        "repo_path": repo_path,
        "raw_file_tree": "",
        "raw_file_contents": {},
        "tech_stack": {},
        "detected_signals": [],
        "infra_plan": {},
        "terraform_files": {},
        "validation_result": False,
        "validation_errors": [],
        "retry_count": 0,
        "output_path": None,
    }


def _example_state() -> AgentState:
    """Pre-populated fixture for offline smoke-testing (no real repo needed)."""
    raw_tree = """\
repo/
├── Dockerfile
├── docker-compose.yml
├── requirements.txt          # fastapi, uvicorn, sqlalchemy, psycopg2, redis, celery
├── src/
│   ├── main.py               # FastAPI app, exposes :8000
│   ├── worker.py             # Celery worker consuming a Redis queue
│   └── models.py             # SQLAlchemy ORM, PostgreSQL dialect
└── .env.example              # DATABASE_URL, REDIS_URL, SECRET_KEY
"""
    raw_file_contents = {
        "Dockerfile": (
            "FROM python:3.11-slim\n"
            "WORKDIR /app\n"
            "COPY . .\n"
            "RUN pip install -r requirements.txt\n"
            'CMD ["uvicorn","src.main:app","--host","0.0.0.0","--port","8000"]\n'
        ),
        "docker-compose.yml": (
            "services:\n"
            "  api:\n"
            "    build: .\n"
            '    ports: ["8000:8000"]\n'
            "  worker:\n"
            "    build: .\n"
            "    command: celery -A src.worker worker -l info\n"
        ),
        "requirements.txt": "fastapi\nuvicorn\nsqlalchemy\npsycopg2\nredis\ncelery\n",
        "src/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
        "src/worker.py": "from celery import Celery\ncelery = Celery(__name__)\n",
        "src/models.py": (
            "from sqlalchemy import create_engine\n"
            "engine = create_engine('postgresql+psycopg2://')\n"
        ),
        ".env.example": "DATABASE_URL=\nREDIS_URL=\nSECRET_KEY=\n",
    }

    return {
        "repo_path": None,
        "raw_file_tree": raw_tree,
        "raw_file_contents": raw_file_contents,
        "tech_stack": {},
        "detected_signals": [],
        "infra_plan": {},
        "terraform_files": {},
        "validation_result": False,
        "validation_errors": [],
        "retry_count": 0,
        "output_path": None,
    }


# ──────────────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────────────

def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="LangGraph Terraform agent – generate IaC from a codebase."
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--repo",
        metavar="PATH",
        help="Filesystem path to the repository to scan.",
    )
    group.add_argument(
        "--example",
        action="store_true",
        help="Run against the built-in FastAPI/Celery/Postgres example fixture.",
    )
    return parser.parse_args()


def main() -> None:
    load_dotenv()
    args = _parse_args()

    if args.example:
        initial_state = _example_state()
        print("Running against built-in example fixture …")
    else:
        repo_path = str(Path(args.repo).resolve())
        if not Path(repo_path).is_dir():
            print(f"ERROR: repo path does not exist or is not a directory: {repo_path}", file=sys.stderr)
            sys.exit(1)
        initial_state = _empty_state(repo_path)
        print(f"Scanning repository: {repo_path}")

    graph = build_graph()
    final_state = graph.invoke(initial_state)

    print("\n=== Tech Stack ===")
    print(json.dumps(final_state.get("tech_stack", {}), indent=2))
    print("\n=== Detected Signals ===")
    print(json.dumps(final_state.get("detected_signals", []), indent=2))
    print("\n=== Infra Plan ===")
    print(json.dumps(final_state.get("infra_plan", {}), indent=2))
    print("\n=== Validation ===")
    print("PASSED" if final_state.get("validation_result") else "FAILED")
    if final_state.get("validation_errors"):
        print(json.dumps(final_state["validation_errors"], indent=2))

    output_path = final_state.get("output_path")
    print("\n=== Output Path ===")
    print(output_path or "(none)")

    if output_path:
        root = Path(output_path)
        print("\n=== Generated Files ===")
        for file_path in sorted(root.rglob("*")):
            if file_path.is_file():
                print(" ", file_path.relative_to(root).as_posix())


if __name__ == "__main__":
    main()