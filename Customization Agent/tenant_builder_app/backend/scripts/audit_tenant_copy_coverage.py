#!/usr/bin/env python3
"""Audit migrated frontend routes for hardcoded user-facing copy.

Usage:
  python scripts/audit_tenant_copy_coverage.py
  python scripts/audit_tenant_copy_coverage.py --root /path/to/CulturePlace-main/frontend

Exit codes:
  0 -> no candidate hardcoded literals found
  1 -> candidate literals found
  2 -> invalid input/path
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

MIGRATED_ROUTE_FILES = [
    "pages/allSessions/index.jsx",
    "pages/allSessions/liveClasses.jsx",
    "pages/allSessions/videos.jsx",
    "pages/contact.jsx",
    "pages/home/index.jsx",
    "pages/mySchedule/index.jsx",
    "pages/myCommunities/index.jsx",
    "pages/search/index.jsx",
    "pages/browseClasses/index.jsx",
    "pages/cart.jsx",
    "pages/classDetails/[id].jsx",
    "pages/communityDetails/[id].jsx",
    "pages/settings/[id].jsx",
    "pages/comHome/[id].jsx",
    "pages/comThreads/[id].jsx",
    "pages/comThreads/asks/[id].jsx",
    "pages/comThreads/polls/[id].jsx",
    "pages/comThreads/greetings/[id].jsx",
    "pages/communitySub/[id].jsx",
    "pages/commerce/[id].jsx",
    "pages/catSessions/[id].jsx",
    "pages/playVideo/[id].jsx",
    "pages/trainorBio/[id].jsx",
    "pages/studentRegistration/index.jsx",
    "pages/user/index.js",
    "pages/session/index.js",
    "pages/session/create/index.js",
    "pages/session/create/[id].js",
    "pages/catchup/[id].jsx",
    "pages/room/[id].js",
    "pages/aboutus/index.jsx",
    "pages/privacyPolicy/index.jsx",
    "pages/termsOfService/index.jsx",
    "pages/termsAndConditions/index.jsx",
]

LONGFORM_ROUTE_FILES = {
    "pages/privacyPolicy/index.jsx",
    "pages/termsOfService/index.jsx",
    "pages/termsAndConditions/index.jsx",
}

TEXT_NODE_RE = re.compile(r">\s*([^<{][^<{]*[A-Za-z][^<{]*)\s*<")
PLACEHOLDER_RE = re.compile(r"\b(placeholder|title)\s*=\s*\"([^\"]*[A-Za-z][^\"]*)\"")
TOAST_RE = re.compile(r"\btoast\.(?:success|error|warn|info)?\s*\(\s*\"([^\"]*[A-Za-z][^\"]*)\"")

IGNORE_CONTAINS = (
    "http://",
    "https://",
    "xmlns",
    "className=",
    "import ",
    "from ",
)


def _line_is_ignored(line: str) -> bool:
    stripped = line.strip()
    if not stripped or stripped.startswith("//"):
        return True
    return any(token in stripped for token in IGNORE_CONTAINS)


def _looks_tenantized(line: str) -> bool:
    return "getTenantText(" in line or "copy(" in line


def _collect_findings(path: Path, rel_path: str) -> list[tuple[int, str, str]]:
    findings: list[tuple[int, str, str]] = []
    lines = path.read_text(encoding="utf-8").splitlines()
    in_block_comment = False

    for idx, line in enumerate(lines, start=1):
        stripped = line.strip()

        # Ignore C/JS block comments and JSX comment blocks.
        if in_block_comment:
            if "*/" in stripped:
                in_block_comment = False
            continue
        if stripped.startswith("/*") or stripped.startswith("{/*"):
            if "*/" not in stripped and "*/}" not in stripped:
                in_block_comment = True
            continue
        if stripped.startswith("*") or stripped.endswith("*/") or stripped.endswith("*/}"):
            continue

        if _line_is_ignored(line) or _looks_tenantized(line):
            continue

        if rel_path not in LONGFORM_ROUTE_FILES:
            for match in TEXT_NODE_RE.finditer(line):
                literal = match.group(1).strip()
                if literal and "{" not in literal and "}" not in literal:
                    findings.append((idx, "text-node", literal))

        for match in PLACEHOLDER_RE.finditer(line):
            literal = match.group(2).strip()
            findings.append((idx, "attr", literal))

        for match in TOAST_RE.finditer(line):
            literal = match.group(1).strip()
            findings.append((idx, "toast", literal))

    return findings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root",
        default=str(Path(__file__).resolve().parents[3] / "CulturePlace-main" / "frontend"),
        help="Path to CulturePlace frontend root",
    )
    args = parser.parse_args()

    root = Path(args.root).resolve()
    if not root.exists() or not root.is_dir():
        print(f"Invalid frontend root: {root}", file=sys.stderr)
        return 2

    any_findings = False
    checked = 0

    for rel in MIGRATED_ROUTE_FILES:
        file_path = root / rel
        if not file_path.exists():
            print(f"[skip] missing file: {rel}")
            continue
        checked += 1
        findings = _collect_findings(file_path, rel)
        if not findings:
            continue

        any_findings = True
        print(f"\n{rel}")
        for line_no, kind, literal in findings:
            print(f"  L{line_no:>4}  [{kind}]  {literal}")

    print(f"\nChecked {checked} migrated route files.")
    if any_findings:
        print("Result: FAIL (candidate hardcoded UI copy found)")
        return 1

    print("Result: PASS (no candidate hardcoded UI copy found)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
