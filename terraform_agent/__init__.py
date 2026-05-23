"""Compatibility package for the local `Terraform Agent` source tree.

The repository stores the Terraform Agent under a directory with a space in its
name. Python package imports use `terraform_agent`, so expose that package name
by pointing this package's search path at the existing source tree.
"""

from pathlib import Path

_PACKAGE_ROOT = Path(__file__).resolve().parent
_SOURCE_ROOT = _PACKAGE_ROOT.parent / "Terraform Agent"

__path__ = [str(_SOURCE_ROOT)]

