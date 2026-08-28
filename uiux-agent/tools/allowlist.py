"""File-path allowlist — the mechanical safety boundary.

Every file read or write in the pipeline passes through this module.
The allowlist is enforced **inside** the tool functions, not in the system
prompt, making it structurally impossible for the LLM to bypass.

The allowlist is defined relative to the target repo root.
"""

from __future__ import annotations

import fnmatch
import os
from pathlib import Path, PurePosixPath


# ── Default allowlist for DeplAI Connector ───────────────────────────────
# These are the ONLY paths the agent may read or write.
# Everything else — API routes, lib/, backend — is excluded by default.

DEFAULT_ALLOWED_PATTERNS: list[str] = [
    "components/**",
    "features/**",
    "app/globals.css",
    "app/layout.tsx",
    "app/page.tsx",
]

# Paths explicitly forbidden even if they match an allowed pattern.
# This is the defense-in-depth layer — the patterns above shouldn't match
# these, but if someone modifies the allowlist, these still block.
DEFAULT_DENIED_PATTERNS: list[str] = [
    "app/api/**",
    "lib/**",
    "chat-agent/**",
    # Backend directories (relative to workspace root, not repo root)
    "**/Agentic Layer/**",
    "**/remediation_pipeline/**",
    "**/Terraform Agent/**",
    "**/Customization Agent/**",
    "**/KGagent/**",
]

# File extensions the agent is allowed to modify.
ALLOWED_EXTENSIONS: set[str] = {
    ".tsx",
    ".ts",
    ".css",
    ".module.css",
    ".json",  # package.json for deps only
}

# Extensions that are read-only (can be read for context, never written).
READ_ONLY_EXTENSIONS: set[str] = {
    ".js",
    ".mjs",
    ".d.ts",
}


class Allowlist:
    """Enforces file-path restrictions for the refactoring pipeline.

    Instantiated once at pipeline startup and injected into every tool that
    touches the filesystem.  All checks are case-insensitive on Windows.
    """

    def __init__(
        self,
        repo_root: str | Path,
        allowed_patterns: list[str] | None = None,
        denied_patterns: list[str] | None = None,
    ) -> None:
        self.repo_root = Path(repo_root).resolve()
        self.allowed = allowed_patterns or list(DEFAULT_ALLOWED_PATTERNS)
        self.denied = denied_patterns or list(DEFAULT_DENIED_PATTERNS)

    def _relative(self, path: str | Path) -> str:
        """Resolve *path* relative to repo_root, using forward slashes."""
        abs_path = Path(path).resolve()
        try:
            rel = abs_path.relative_to(self.repo_root)
        except ValueError:
            # Path is outside the repo root entirely — always denied.
            return ""
        # Normalize to forward slashes for consistent glob matching.
        return PurePosixPath(rel).as_posix()

    def _matches_any(self, rel_path: str, patterns: list[str]) -> bool:
        """Check if *rel_path* matches any of the glob *patterns*."""
        for pattern in patterns:
            if fnmatch.fnmatch(rel_path, pattern):
                return True
            # Also check with a leading slash stripped (for robustness).
            if fnmatch.fnmatch(rel_path.lstrip("/"), pattern):
                return True
        return False

    def is_readable(self, path: str | Path) -> bool:
        """Can the agent read this file?

        Readable if it matches the allowlist AND does not match the denylist.
        Read-only extensions are also permitted for reading.
        """
        rel = self._relative(path)
        if not rel:
            return False
        if self._matches_any(rel, self.denied):
            return False
        if self._matches_any(rel, self.allowed):
            return True
        return False

    def is_writable(self, path: str | Path) -> bool:
        """Can the agent write to this file?

        Writable only if readable AND the extension is in ALLOWED_EXTENSIONS
        (not in READ_ONLY_EXTENSIONS).
        """
        if not self.is_readable(path):
            return False
        ext = Path(path).suffix.lower()
        if ext in READ_ONLY_EXTENSIONS:
            return False
        if ext not in ALLOWED_EXTENSIONS:
            return False
        return True

    def check_read(self, path: str | Path) -> None:
        """Raise ``PermissionError`` if the path is not readable."""
        if not self.is_readable(path):
            raise PermissionError(
                f"Allowlist violation: read access denied for {path!s}\n"
                f"  Resolved relative path: {self._relative(path)!r}\n"
                f"  Repo root: {self.repo_root}"
            )

    def check_write(self, path: str | Path) -> None:
        """Raise ``PermissionError`` if the path is not writable."""
        if not self.is_writable(path):
            raise PermissionError(
                f"Allowlist violation: write access denied for {path!s}\n"
                f"  Resolved relative path: {self._relative(path)!r}\n"
                f"  Repo root: {self.repo_root}"
            )

    def filter_readable(self, paths: list[str | Path]) -> list[Path]:
        """Return only the paths from *paths* that are readable."""
        return [Path(p) for p in paths if self.is_readable(p)]

    def filter_writable(self, paths: list[str | Path]) -> list[Path]:
        """Return only the paths from *paths* that are writable."""
        return [Path(p) for p in paths if self.is_writable(p)]

    def __repr__(self) -> str:
        return (
            f"Allowlist(repo_root={self.repo_root!s}, "
            f"allowed={self.allowed}, denied={self.denied})"
        )
