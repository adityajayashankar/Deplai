"""Local import compatibility for the Terraform Agent package.

Docker mounts this directory as `/app/terraform_agent`, so production imports
resolve naturally. Local test runs add `Terraform Agent` to `PYTHONPATH`; this
shim exposes the sibling `agent` package under the same import name.
"""

from __future__ import annotations

from pathlib import Path

__path__.append(str(Path(__file__).resolve().parents[1]))
