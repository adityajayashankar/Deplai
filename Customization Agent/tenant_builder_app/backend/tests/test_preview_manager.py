from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services import preview_manager


class PreviewManagerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.base_repo = self.root / "base"
        self.base_repo.mkdir()
        self.tenant_repo = self.root / "SubSpace-acme"
        self.tenant_repo.mkdir()
        with preview_manager._PREVIEW_LOCK:
            preview_manager._PREVIEW_PROCESSES.clear()

    def tearDown(self) -> None:
        preview_manager._cleanup_all_previews()
        with preview_manager._PREVIEW_LOCK:
            preview_manager._PREVIEW_PROCESSES.clear()
        self.temporary_directory.cleanup()

    def test_static_repo_is_ready_without_starting_a_process(self) -> None:
        (self.tenant_repo / "index.html").write_text("<h1>Acme</h1>", encoding="utf-8")

        started = preview_manager.start_preview(
            tenant_id="acme",
            base_repo_path=str(self.base_repo),
        )
        current = preview_manager.preview_status(
            tenant_id="acme",
            base_repo_path=str(self.base_repo),
        )

        self.assertEqual("static_file", started["kind"])
        self.assertEqual("ready", started["status"])
        self.assertEqual("static_file", current["kind"])
        self.assertEqual("ready", current["status"])
        self.assertIsNone(current["pid"])

    def test_dependency_failure_promotes_static_fallback(self) -> None:
        app_root = self.tenant_repo / "frontend"
        app_root.mkdir()
        (app_root / "package.json").write_text(
            json.dumps({"scripts": {"dev": "vite"}}),
            encoding="utf-8",
        )

        with patch.object(
            preview_manager,
            "_ensure_dependencies",
            return_value=(False, "Dependency install disabled."),
        ):
            started = preview_manager.start_preview(
                tenant_id="acme",
                base_repo_path=str(self.base_repo),
            )
            self.assertEqual("starting", started["status"])
            self.assertNotIn("url", started)
            deadline = time.time() + 3
            current = started
            while time.time() < deadline:
                current = preview_manager.preview_status(
                    tenant_id="acme",
                    base_repo_path=str(self.base_repo),
                )
                if current["status"] != "starting":
                    break
                time.sleep(0.01)

        self.assertEqual("static_file", current["kind"])
        self.assertEqual("ready", current["status"])
        self.assertIn("static preview fallback", current["detail"])

    def test_runnable_app_reports_live_server_until_started(self) -> None:
        app_root = self.tenant_repo / "frontend"
        app_root.mkdir()
        (app_root / "package.json").write_text(
            json.dumps({"scripts": {"dev": "next dev"}}),
            encoding="utf-8",
        )

        current = preview_manager.preview_status(
            tenant_id="acme",
            base_repo_path=str(self.base_repo),
        )

        self.assertEqual("live_server", current["kind"])
        self.assertEqual("stopped", current["status"])
        self.assertIn("has not been started", current["detail"])

    def test_stop_status_is_retained(self) -> None:
        (self.tenant_repo / "index.html").write_text("<h1>Acme</h1>", encoding="utf-8")
        preview_manager.start_preview(
            tenant_id="acme",
            base_repo_path=str(self.base_repo),
        )

        stopped = preview_manager.stop_preview(
            tenant_id="acme",
            base_repo_path=str(self.base_repo),
        )
        current = preview_manager.preview_status(
            tenant_id="acme",
            base_repo_path=str(self.base_repo),
        )

        self.assertEqual("stopped", stopped["status"])
        self.assertEqual("stopped", current["status"])

    def test_status_marks_exited_live_process_failed(self) -> None:
        process = subprocess.Popen([sys.executable, "-c", "pass"])
        process.wait(timeout=3)
        tenant_key = str(self.tenant_repo.resolve())
        with preview_manager._PREVIEW_LOCK:
            preview_manager._PREVIEW_PROCESSES[tenant_key] = {
                "kind": "live_server",
                "status": "ready",
                "url": "http://127.0.0.1:3999",
                "detail": "",
                "port": 3999,
                "process": process,
                "thread": None,
                "token": "test-token",
                "app_root": str(self.tenant_repo),
            }

        current = preview_manager.preview_status(
            tenant_id="acme",
            base_repo_path=str(self.base_repo),
        )

        self.assertEqual("failed", current["status"])
        self.assertIn("no longer running", current["detail"])


if __name__ == "__main__":
    unittest.main()
