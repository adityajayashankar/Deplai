from __future__ import annotations

import json
from pathlib import Path

from dotenv import load_dotenv

from graph import build_graph
from state import AgentState


def build_example_input() -> AgentState:
    # Ground-truth fixture requested in the system prompt.
    raw_tree = """repo/
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
        "Dockerfile": "FROM python:3.11-slim\nWORKDIR /app\nCOPY . .\nRUN pip install -r requirements.txt\nCMD [\"uvicorn\",\"src.main:app\",\"--host\",\"0.0.0.0\",\"--port\",\"8000\"]\n",
        "docker-compose.yml": "services:\n  api:\n    build: .\n    ports: [\"8000:8000\"]\n  worker:\n    build: .\n    command: celery -A src.worker worker -l info\n",
        "requirements.txt": "fastapi\nuvicorn\nsqlalchemy\npsycopg2\nredis\ncelery\n",
        "src/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
        "src/worker.py": "from celery import Celery\ncelery = Celery(__name__)\n",
        "src/models.py": "from sqlalchemy import create_engine\nengine = create_engine('postgresql+psycopg2://')\n",
        ".env.example": "DATABASE_URL=\nREDIS_URL=\nSECRET_KEY=\n",
    }

    return {
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


def main() -> None:
    load_dotenv()

    graph = build_graph()
    initial_state = build_example_input()
    final_state = graph.invoke(initial_state)

    print("=== Infra Plan ===")
    print(json.dumps(final_state.get("infra_plan", {}), indent=2))
    print("\n=== Validation ===")
    print(final_state.get("validation_result"))
    if final_state.get("validation_errors"):
        print(json.dumps(final_state["validation_errors"], indent=2))

    output_path = final_state.get("output_path")
    print("\n=== Output Path ===")
    print(output_path)

    if output_path:
        root = Path(output_path)
        for file_path in sorted(root.rglob("*")):
            if file_path.is_file():
                print(file_path.relative_to(root).as_posix())


if __name__ == "__main__":
    main()
