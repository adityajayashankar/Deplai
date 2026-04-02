"""Phase-oriented Terraform engine entrypoints."""

from __future__ import annotations

from typing import Any


def generate_terraform_run(*args: Any, **kwargs: Any) -> dict[str, Any]:
    from .service import generate_terraform_run as _generate_terraform_run

    return _generate_terraform_run(*args, **kwargs)


def apply_terraform_run(*args: Any, **kwargs: Any) -> dict[str, Any]:
    from .service import apply_terraform_run as _apply_terraform_run

    return _apply_terraform_run(*args, **kwargs)


__all__ = ["generate_terraform_run", "apply_terraform_run"]
