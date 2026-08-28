"""Git patch tool — isolated worktree + patch-based diffing.

Never overwrites files directly.  All changes go through:
1. Create/reuse a git worktree for isolation.
2. Apply patches within the worktree.
3. Run validation against the patched worktree.
4. On success: generate a clean unified diff for review/merge.
5. On failure: rollback the worktree to the pre-patch state.

This is both a safety mechanism (atomic rollback on validation failure) and
a quality mechanism (every change is reviewable as a diff, never a full-file
regeneration).
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any


@dataclass
class PatchResult:
    """Result of applying a patch to the worktree."""

    success: bool
    component_name: str
    file_path: str
    diff: str = ""  # Unified diff of the changes.
    error: str = ""
    lines_added: int = 0
    lines_removed: int = 0
    lines_modified: int = 0


@dataclass
class WorktreeManager:
    """Manages a git worktree for isolated refactoring changes.

    All patch operations happen in the worktree, never in the main working
    tree.  This prevents partial/broken changes from affecting the repo if
    validation fails.
    """

    repo_root: Path
    worktree_path: Path | None = None
    branch_name: str = "uiux-refactor-wip"
    _initialized: bool = False

    def setup(self) -> Path:
        """Create (or reuse) a git worktree for refactoring.

        Returns the path to the worktree.
        """
        if self.worktree_path and self.worktree_path.exists() and self._initialized:
            return self.worktree_path

        # Create a temporary directory for the worktree.
        worktree_dir = self.repo_root / "tmp" / "uiux-worktree"
        worktree_dir.parent.mkdir(parents=True, exist_ok=True)

        # Check if a worktree already exists at this path.
        if worktree_dir.exists():
            # Verify it's a valid worktree.
            try:
                result = subprocess.run(
                    ["git", "worktree", "list", "--porcelain"],
                    cwd=str(self.repo_root),
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                if str(worktree_dir) in result.stdout:
                    self.worktree_path = worktree_dir
                    self._initialized = True
                    return self.worktree_path
            except (subprocess.TimeoutExpired, FileNotFoundError):
                pass

            # Not a valid worktree — remove and recreate.
            _remove_worktree(self.repo_root, worktree_dir)

        # Create a fresh branch from HEAD.
        try:
            subprocess.run(
                ["git", "branch", "-D", self.branch_name],
                cwd=str(self.repo_root),
                capture_output=True,
                timeout=30,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass

        subprocess.run(
            ["git", "worktree", "add", "-b", self.branch_name,
             str(worktree_dir), "HEAD"],
            cwd=str(self.repo_root),
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )

        self.worktree_path = worktree_dir
        self._initialized = True
        return self.worktree_path

    def apply_patch_string(
        self,
        component_name: str,
        file_rel_path: str,
        patch_content: str,
    ) -> PatchResult:
        """Apply a unified diff patch to a file in the worktree.

        The patch is applied using ``git apply`` for safety — it will reject
        patches that don't apply cleanly rather than corrupting the file.
        """
        if not self.worktree_path or not self._initialized:
            self.setup()

        assert self.worktree_path is not None
        target_file = self.worktree_path / file_rel_path

        if not target_file.exists():
            return PatchResult(
                success=False,
                component_name=component_name,
                file_path=file_rel_path,
                error=f"Target file does not exist in worktree: {file_rel_path}",
            )

        # Write the patch to a temp file.
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".patch", delete=False, dir=str(self.worktree_path)
        ) as f:
            f.write(patch_content)
            patch_file = f.name

        try:
            # Try to apply the patch.
            result = subprocess.run(
                ["git", "apply", "--check", patch_file],
                cwd=str(self.worktree_path),
                capture_output=True,
                text=True,
                timeout=30,
            )
            if result.returncode != 0:
                return PatchResult(
                    success=False,
                    component_name=component_name,
                    file_path=file_rel_path,
                    error=f"Patch does not apply cleanly: {result.stderr}",
                )

            # Actually apply.
            subprocess.run(
                ["git", "apply", patch_file],
                cwd=str(self.worktree_path),
                check=True,
                capture_output=True,
                text=True,
                timeout=30,
            )

            # Generate a diff for the result.
            diff_result = subprocess.run(
                ["git", "diff", "--", file_rel_path],
                cwd=str(self.worktree_path),
                capture_output=True,
                text=True,
                timeout=30,
            )

            diff_text = diff_result.stdout
            added = diff_text.count("\n+") - diff_text.count("\n+++")
            removed = diff_text.count("\n-") - diff_text.count("\n---")

            return PatchResult(
                success=True,
                component_name=component_name,
                file_path=file_rel_path,
                diff=diff_text,
                lines_added=max(0, added),
                lines_removed=max(0, removed),
            )

        finally:
            try:
                os.unlink(patch_file)
            except OSError:
                pass

    def rollback_file(self, file_rel_path: str) -> None:
        """Reset a single file in the worktree to its pre-patch state."""
        if not self.worktree_path:
            return
        subprocess.run(
            ["git", "checkout", "--", file_rel_path],
            cwd=str(self.worktree_path),
            capture_output=True,
            timeout=30,
        )

    def rollback_all(self) -> None:
        """Reset the entire worktree to clean state."""
        if not self.worktree_path:
            return
        subprocess.run(
            ["git", "checkout", "--", "."],
            cwd=str(self.worktree_path),
            capture_output=True,
            timeout=30,
        )
        subprocess.run(
            ["git", "clean", "-fd"],
            cwd=str(self.worktree_path),
            capture_output=True,
            timeout=30,
        )

    def commit_changes(self, message: str) -> str:
        """Stage and commit all changes in the worktree.

        Returns the commit SHA.
        """
        if not self.worktree_path:
            raise RuntimeError("Worktree not initialized")
        subprocess.run(
            ["git", "add", "-A"],
            cwd=str(self.worktree_path),
            check=True,
            capture_output=True,
            timeout=30,
        )
        result = subprocess.run(
            ["git", "commit", "-m", message],
            cwd=str(self.worktree_path),
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        sha_result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(self.worktree_path),
            capture_output=True,
            text=True,
            timeout=30,
        )
        return sha_result.stdout.strip()

    def get_full_diff(self) -> str:
        """Return a unified diff of all uncommitted changes in the worktree."""
        if not self.worktree_path:
            return ""
        result = subprocess.run(
            ["git", "diff"],
            cwd=str(self.worktree_path),
            capture_output=True,
            text=True,
            timeout=60,
        )
        return result.stdout

    def cleanup(self) -> None:
        """Remove the worktree and its branch."""
        if self.worktree_path:
            _remove_worktree(self.repo_root, self.worktree_path)
            self.worktree_path = None
            self._initialized = False


def _remove_worktree(repo_root: Path, worktree_path: Path) -> None:
    """Safely remove a git worktree."""
    try:
        subprocess.run(
            ["git", "worktree", "remove", "--force", str(worktree_path)],
            cwd=str(repo_root),
            capture_output=True,
            timeout=30,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    try:
        import shutil
        if worktree_path.exists():
            shutil.rmtree(worktree_path, ignore_errors=True)
    except OSError:
        pass
