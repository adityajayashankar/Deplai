from __future__ import annotations

import os
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from repository_sources import (
    RepositorySourceResolutionError,
    resolve_repository_source,
    resolve_snapshot_source_override,
)


class RepositorySourceResolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = Path(tempfile.mkdtemp(prefix="deplai-repo-src-"))
        self.addCleanup(lambda: shutil.rmtree(self.temp_dir, ignore_errors=True))
        self.old_local_root = os.environ.get("DEPLAI_LOCAL_PROJECTS_ROOT")
        self.old_repo_root = os.environ.get("DEPLAI_GITHUB_REPOS_ROOT")

    def tearDown(self) -> None:
        if self.old_local_root is None:
            os.environ.pop("DEPLAI_LOCAL_PROJECTS_ROOT", None)
        else:
            os.environ["DEPLAI_LOCAL_PROJECTS_ROOT"] = self.old_local_root

        if self.old_repo_root is None:
            os.environ.pop("DEPLAI_GITHUB_REPOS_ROOT", None)
        else:
            os.environ["DEPLAI_GITHUB_REPOS_ROOT"] = self.old_repo_root

    def test_resolves_local_project_from_configured_root(self) -> None:
        root = self.temp_dir / "local-projects"
        project_path = root / "user-123" / "proj-456"
        project_path.mkdir(parents=True)
        os.environ["DEPLAI_LOCAL_PROJECTS_ROOT"] = str(root)

        resolved = resolve_repository_source(
            project_id="proj-456",
            project_type="local",
            user_id="user-123",
        )

        self.assertEqual(resolved, project_path)

    def test_resolves_github_repo_from_configured_root(self) -> None:
        root = self.temp_dir / "repos"
        repo_path = root / "octo" / "sample-repo"
        repo_path.mkdir(parents=True)
        os.environ["DEPLAI_GITHUB_REPOS_ROOT"] = str(root)

        resolved = resolve_repository_source(
            project_id="ignored",
            project_type="github",
            repo_full_name="octo/sample-repo",
        )

        self.assertEqual(resolved, repo_path)

    def test_lists_attempted_paths_when_repo_is_missing(self) -> None:
        root = self.temp_dir / "repos"
        root.mkdir(parents=True)
        os.environ["DEPLAI_GITHUB_REPOS_ROOT"] = str(root)

        with self.assertRaises(RepositorySourceResolutionError) as ctx:
            resolve_repository_source(
                project_id="ignored",
                project_type="github",
                repo_full_name="octo/missing-repo",
            )

        self.assertIn("Attempted:", str(ctx.exception))
        self.assertIn("missing-repo", str(ctx.exception))

    def test_validates_immutable_snapshot_override(self) -> None:
        root = self.temp_dir / "local-projects"
        snapshot_id = "snap-123"
        tenant_id = "tenant-abc"
        source = root / "user-123" / ".deplai-snapshots" / tenant_id / snapshot_id
        source.mkdir(parents=True)
        (source / "snapshot.metadata.json").write_text(
            json.dumps(
                {
                    "snapshot_id": snapshot_id,
                    "tenant_id": tenant_id,
                    "status": "immutable",
                    "source_tree_hash": "sha256:test",
                }
            ),
            encoding="utf-8",
        )
        os.environ["DEPLAI_LOCAL_PROJECTS_ROOT"] = str(root)

        resolved = resolve_snapshot_source_override(
            {
                "kind": "customization_snapshot",
                "project_id": "proj-456",
                "snapshot_id": snapshot_id,
                "tenant_id": tenant_id,
                "source_root": str(source),
                "source_tree_hash": "sha256:test",
            },
            project_id="proj-456",
        )

        self.assertEqual(resolved, source)

    def test_rejects_tampered_snapshot_metadata(self) -> None:
        root = self.temp_dir / "repos"
        source = root / "owner" / ".deplai-snapshots" / "tenant-abc" / "snap-123"
        source.mkdir(parents=True)
        (source / "snapshot.metadata.json").write_text(
            json.dumps(
                {
                    "snapshot_id": "snap-123",
                    "tenant_id": "tenant-abc",
                    "status": "immutable",
                    "source_tree_hash": "different-hash",
                }
            ),
            encoding="utf-8",
        )
        os.environ["DEPLAI_GITHUB_REPOS_ROOT"] = str(root)

        with self.assertRaises(RepositorySourceResolutionError):
            resolve_snapshot_source_override(
                {
                    "kind": "customization_snapshot",
                    "project_id": "proj-456",
                    "snapshot_id": "snap-123",
                    "tenant_id": "tenant-abc",
                    "source_root": str(source),
                    "source_tree_hash": "expected-hash",
                },
                project_id="proj-456",
            )
