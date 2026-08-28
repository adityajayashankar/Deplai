import os
from typing import Any, Callable

from dast_agent.scanner import ZAP_IMAGE
from dast_agent.service import execute_dast_scan
from dast_agent.ssrf import validate_outbound_target as validate_dast_target

SCANNER_TIMEOUT_SECONDS = int(os.getenv("DAST_TIMEOUT_SECONDS", os.getenv("SCANNER_TIMEOUT_SECONDS", "900")))
DAST_SPIDER_MINUTES = int(os.getenv("DAST_SPIDER_MINUTES", "5"))

__all__ = [
    "DAST_SPIDER_MINUTES",
    "SCANNER_TIMEOUT_SECONDS",
    "ZAP_IMAGE",
    "dast_should_run",
    "is_dast_only_run",
    "is_module_only_run",
    "run_dast_scan",
    "validate_dast_target",
]


def dast_should_run(dast_url: str | None) -> bool:
    """Run DAST whenever an authorized target URL is present."""
    return bool(str(dast_url or "").strip())


def is_module_only_run(requested: list[str] | None, module: str) -> bool:
    """True when the pipeline request contains exactly one named module."""
    names = [str(item or "").strip().lower() for item in (requested or []) if str(item or "").strip()]
    return names == [str(module or "").strip().lower()]


def is_dast_only_run(requested: list[str] | None, dast_url: str | None) -> bool:
    """True when this pipeline should test the URL without re-running other modules."""
    return dast_should_run(dast_url) and is_module_only_run(requested, "dast")


def run_dast_scan(
    project_name: str,
    project_id: str,
    target_url: str,
    context: Any = None,
    cancelled_check: Callable[[], bool] | None = None,
) -> tuple[bool, str]:
    """Run authorized dynamic testing. Never starts ZAP without server-side authorization."""
    return execute_dast_scan(
        project_name,
        project_id,
        target_url,
        context=context,
        cancelled_check=cancelled_check,
    )
