from __future__ import annotations

import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent
EXTRA_PATHS = (
    REPO_ROOT / "Agentic Layer",
    REPO_ROOT / "Terraform Agent",
)

for candidate in EXTRA_PATHS:
    if candidate.exists():
        candidate_str = str(candidate)
        if candidate_str not in sys.path:
            sys.path.insert(0, candidate_str)
