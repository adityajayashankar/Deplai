from __future__ import annotations

from datetime import datetime
from pathlib import Path


LOG_FILE_PATH = Path(__file__).resolve().parents[1] / "logs" / "customization.log"


def log_agent(agent: str, message: str) -> None:
    line = f"[{agent}] {message}"
    print(line)
    LOG_FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE_PATH.open("a", encoding="utf-8") as handle:
        timestamp = datetime.now().isoformat(timespec="seconds")
        handle.write(f"[{timestamp}] {line}\n")