from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class ExecutionResult:
    ok: bool
    stdout: str = ""
    stderr: str = ""
    exit_code: int = 0
    duration_ms: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)
    execution_id: str = ""
    started_at: str = ""
    completed_at: str = ""


class ExecutionAdapter(Protocol):
    name: str

    def ping(self, instance_id: str) -> bool:
        ...

    def execute(
        self,
        instance_id: str,
        commands: list[str],
        *,
        timeout_seconds: int,
        metadata: dict[str, Any] | None = None,
    ) -> ExecutionResult:
        ...
