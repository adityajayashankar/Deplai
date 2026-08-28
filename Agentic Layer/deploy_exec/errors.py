from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from deploy_exec.codes import CODES, retryable as code_retryable


@dataclass
class DeployError(Exception):
    code: str
    user_message: str = ""
    technical_message: str = ""
    recommended_action: str = ""
    rollback_recommended: bool = False
    severity: str = "error"
    details: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.code = str(self.code or "TIMEOUT").strip().upper()
        if not self.user_message:
            self.user_message = CODES.get(self.code, "Deployment failed.")
        if not self.technical_message:
            self.technical_message = self.user_message
        super().__init__(self.user_message)

    @property
    def retryable(self) -> bool:
        return code_retryable(self.code)

    @property
    def category(self) -> str:
        if self.code.startswith("SSM"):
            return "connectivity"
        if self.code.startswith("ARTIFACT") or self.code.startswith("ECR") or "IMAGE" in self.code:
            return "artifact"
        if "HEALTH" in self.code or "SMOKE" in self.code:
            return "verification"
        if "LOCK" in self.code or "UNAUTHORIZED" in self.code:
            return "policy"
        return "execution"

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "category": self.category,
            "retryable": self.retryable,
            "severity": self.severity,
            "user_message": self.user_message,
            "technical_message": self.technical_message,
            "recommended_action": self.recommended_action,
            "rollback_recommended": self.rollback_recommended,
            "details": self.details,
        }
