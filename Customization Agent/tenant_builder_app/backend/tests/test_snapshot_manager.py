from __future__ import annotations

import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.snapshot_manager import (
    METADATA_FILE_NAME,
    SnapshotError,
    create_snapshot,
    get_snapshot,
    hash_tree,
)


def _remove_read_only(function, path, _exc_info) -> None:
    os.chmod(path, stat.S_IWRITE | stat.S_IREAD)
    function(path)


class SnapshotManagerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        self.base_repo = self.root / "base"
        self.source_repo = self.root / "SubSpace-acme"
        self.base_repo.mkdir()
        self.source_repo.mkdir()
        (self.base_repo / "app.txt").write_text("base", encoding="utf-8")
        (self.source_repo / "app.txt").write_text("customized", encoding="utf-8")
        (self.source_repo / "new.txt").write_text("new", encoding="utf-8")
        (self.source_repo / "node_modules").mkdir()
        (self.source_repo / "node_modules" / "ignored.js").write_text("ignored", encoding="utf-8")
        self.manifest = {"tenant_id": "acme", "revision": 7}

    def tearDown(self) -> None:
        shutil.rmtree(self.root, onerror=_remove_read_only)

    def test_snapshot_is_isolated_and_preserves_prior_contents(self) -> None:
        first = create_snapshot(
            tenant_id="acme",
            base_repo_path=str(self.base_repo),
            manifest=self.manifest,
            quality_report={"status": "passed", "checks": []},
        )
        first_path = Path(first["snapshot_path"])
        self.assertEqual("immutable", first["status"])
        self.assertEqual("customized", (first_path / "app.txt").read_text(encoding="utf-8"))
        self.assertFalse((first_path / "node_modules").exists())
        self.assertTrue((first_path / METADATA_FILE_NAME).is_file())
        self.assertEqual("modified", first["changed_file_hashes"]["app.txt"]["status"])
        self.assertEqual("added", first["changed_file_hashes"]["new.txt"]["status"])

        (self.source_repo / "app.txt").write_text("later change", encoding="utf-8")
        second = create_snapshot(
            tenant_id="acme",
            base_repo_path=str(self.base_repo),
            manifest=self.manifest,
        )

        self.assertNotEqual(first["snapshot_id"], second["snapshot_id"])
        self.assertEqual("customized", (first_path / "app.txt").read_text(encoding="utf-8"))
        loaded = get_snapshot(
            tenant_id="acme",
            base_repo_path=str(self.base_repo),
            snapshot_id=first["snapshot_id"],
        )
        self.assertEqual(first["source_tree_hash"], loaded["source_tree_hash"])

    def test_integrity_check_rejects_snapshot_mutation(self) -> None:
        snapshot = create_snapshot(
            tenant_id="acme",
            base_repo_path=str(self.base_repo),
            manifest=self.manifest,
        )
        snapshotted_file = Path(snapshot["snapshot_path"]) / "app.txt"
        snapshotted_file.chmod(stat.S_IWRITE | stat.S_IREAD)
        snapshotted_file.write_text("tampered", encoding="utf-8")

        with self.assertRaisesRegex(SnapshotError, "integrity"):
            get_snapshot(
                tenant_id="acme",
                base_repo_path=str(self.base_repo),
                snapshot_id=snapshot["snapshot_id"],
            )

    def test_tenant_path_traversal_is_rejected(self) -> None:
        with self.assertRaisesRegex(SnapshotError, "tenant_id"):
            create_snapshot(
                tenant_id="../acme",
                base_repo_path=str(self.base_repo),
                manifest=self.manifest,
            )

    def test_stale_base_revision_is_rejected(self) -> None:
        _hashes, base_revision = hash_tree(self.base_repo)
        (self.base_repo / "app.txt").write_text("updated base", encoding="utf-8")

        with self.assertRaisesRegex(SnapshotError, "base repository changed"):
            create_snapshot(
                tenant_id="acme",
                base_repo_path=str(self.base_repo),
                manifest=self.manifest,
                expected_base_revision=base_revision,
            )


if __name__ == "__main__":
    unittest.main()
