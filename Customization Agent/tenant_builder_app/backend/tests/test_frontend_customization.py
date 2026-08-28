"""Tests for the LangGraph frontend customization engine."""

from __future__ import annotations

import json
import shutil
import stat
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from frontend_customization.graph import build_frontend_customization_graph, next_node
from frontend_customization.intake import analyze_repository, list_frontend_paths
from frontend_customization.models import ChangeClass, PIPELINE_STAGES
from frontend_customization.policies import classify_change, evaluate_change
from frontend_customization.runner import continue_run, restore_checkpoint, start_run
from frontend_customization.workspace import acquire_files, changed_files, ensure_workspace, release_files
from langgraph.graph import END


def _remove_read_only(function, path, _exc_info) -> None:
    os_chmod = __import__("os").chmod
    os_chmod(path, stat.S_IWRITE | stat.S_IREAD)
    function(path)


def _write_fixture(root: Path) -> None:
    (root / "src" / "api").mkdir(parents=True)
    (root / "src" / "pages").mkdir(parents=True)
    (root / "package.json").write_text(
        json.dumps(
            {
                "name": "orbit-ml-inference",
                "scripts": {"dev": "vite", "build": "vite build"},
                "dependencies": {"react": "18.3.1", "react-dom": "18.3.1"},
                "devDependencies": {"vite": "5.4.0", "tailwindcss": "3.4.0", "typescript": "5.6.0"},
            }
        ),
        encoding="utf-8",
    )
    (root / "index.html").write_text(
        "<!doctype html><html><body><div id='root'></div><script type='module' src='/src/main.tsx'></script></body></html>",
        encoding="utf-8",
    )
    (root / "src" / "main.tsx").write_text(
        "import './index.css';\nimport { createRoot } from 'react-dom/client';\ncreateRoot(document.getElementById('root')!).render(<App />);\nfunction App(){ return <Projects /> }\n",
        encoding="utf-8",
    )
    (root / "src" / "index.css").write_text("body { font-family: sans-serif; color: #222; }\n", encoding="utf-8")
    (root / "src" / "pages" / "projects.tsx").write_text(
        "export default function Projects(){ const items = []; return <main><h1>Projects</h1><button>Create project</button></main> }\n",
        encoding="utf-8",
    )
    (root / "src" / "api" / "billing.ts").write_text(
        "export async function charge(userId: string) {\n  const secret = process.env.STRIPE_SECRET;\n  return fetch('/api/charge', { method: 'POST', headers: { authorization: 'Bearer ' + secret }, body: JSON.stringify({ userId }) });\n}\n",
        encoding="utf-8",
    )
    (root / "vite.config.ts").write_text("export default { server: { port: 5173 } };\n", encoding="utf-8")


class PolicyEngineTests(unittest.TestCase):
    def test_blocks_business_logic_and_secrets(self) -> None:
        boundary = {"protected_files": ["src/api/billing.ts"], "protected_directories": ["src/api"], "allowed_frontend_surface": ["src/index.css"]}
        classification = classify_change(
            "src/api/billing.ts",
            "export const charge = () => fetch('/api')",
            "export const charge = () => fetch('/api/v2')",
            boundary,
        )
        self.assertEqual(classification, ChangeClass.BUSINESS_LOGIC)
        violations = evaluate_change(
            path="src/api/billing.ts",
            before="x",
            after="y",
            classification=classification,
            boundary=boundary,
        )
        self.assertTrue(any(item["policy"] == "NO_PROTECTED_FILE_MODIFICATION" for item in violations))
        secret_violations = evaluate_change(
            path=".env",
            before="",
            after="API_KEY=secret",
            classification=ChangeClass.STYLE,
            boundary=boundary,
        )
        self.assertTrue(any(item["policy"] == "NO_SECRET_ACCESS" for item in secret_violations))

    def test_allows_style_changes_on_frontend_surface(self) -> None:
        boundary = {"allowed_frontend_surface": ["src/index.css"], "protected_files": [], "protected_directories": []}
        before = "body { color: #222; }"
        after = "body { color: #111; padding: 16px; }"
        classification = classify_change("src/index.css", before, after, boundary)
        self.assertEqual(classification, ChangeClass.STYLE)
        self.assertEqual(evaluate_change(path="src/index.css", before=before, after=after, classification=classification, boundary=boundary), [])


class WorkspaceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        self.repo = self.root / "repo"
        self.repo.mkdir()
        _write_fixture(self.repo)

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def test_workspace_copy_locks_and_conflicts(self) -> None:
        workspace = ensure_workspace("run1", str(self.repo), self.root / "runtime")
        self.assertTrue(Path(workspace["original_root"]).exists())
        self.assertTrue(Path(workspace["working_root"]).exists())
        acquired = acquire_files("run1", "shell", ["src/index.css"])
        self.assertEqual(acquired, ["src/index.css"])
        with self.assertRaises(RuntimeError):
            acquire_files("run1", "screen", ["src/index.css"])
        release_files("run1", "shell")
        acquire_files("run1", "screen", ["src/index.css"])
        release_files("run1", "screen")


class GraphRoutingTests(unittest.TestCase):
    def test_graph_compiles_and_routes_pipeline(self) -> None:
        graph = build_frontend_customization_graph()
        self.assertIsNotNone(graph)
        state = {"completed_nodes": [], "status": "running"}
        self.assertEqual(next_node(state), "intake")  # type: ignore[arg-type]
        state["completed_nodes"] = list(PIPELINE_STAGES)
        self.assertEqual(next_node(state), END)  # type: ignore[arg-type]
        interrupted = {"completed_nodes": ["intake"], "status": "awaiting_review", "interrupt_required": True, "current_stage": "intake"}
        self.assertEqual(next_node(interrupted), END)  # type: ignore[arg-type]


class EngineIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        self.repo = self.root / "repo"
        self.backend = self.root / "backend"
        self.repo.mkdir()
        self.backend.mkdir()
        _write_fixture(self.repo)

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def test_full_run_protects_billing_and_customizes_css(self) -> None:
        view = start_run(
            backend_dir=self.backend,
            base_repo_path=str(self.repo),
            project_id="proj-1",
            tenant_id="acme",
            user_id="user-1",
            goal="Improve overall UI/UX",
            mode="full_transformation",
            wait=True,
        )
        self.assertIn(view["status"], {"completed", "awaiting_review"})
        self.assertIn("intake", view["completed_nodes"])
        self.assertIn("business_logic", view["completed_nodes"])
        self.assertGreaterEqual(len(view["checkpoints"]), 1)
        self.assertTrue((self.backend / "runtime" / "frontend_customization" / view["run_id"] / "working" / "src" / "index.css").exists())
        working_css = (self.backend / "runtime" / "frontend_customization" / view["run_id"] / "working" / "src" / "index.css").read_text(encoding="utf-8")
        original_billing = (self.backend / "runtime" / "frontend_customization" / view["run_id"] / "working" / "src" / "api" / "billing.ts").read_text(encoding="utf-8")
        self.assertIn("process.env.STRIPE_SECRET", original_billing)
        self.assertTrue("--deplai-surface" in working_css or "max-width: 640px" in working_css or view["changesets"])
        changed = {item.get("file") for item in view["changesets"]}
        self.assertNotIn("src/api/billing.ts", changed)
        protected = view["business_logic_boundary"]["protected_file_count"]
        self.assertGreaterEqual(protected, 1)
        self.assertEqual(view["repository_manifest"]["frontend_framework"], "React")

    def test_checkpoint_restore_and_continue(self) -> None:
        view = start_run(
            backend_dir=self.backend,
            base_repo_path=str(self.repo),
            project_id="proj-2",
            tenant_id="acme",
            user_id="user-1",
            goal="Improve overall UI/UX",
            wait=True,
        )
        checkpoint = (view.get("checkpoints") or [None])[0]
        self.assertIsNotNone(checkpoint)
        restored = restore_checkpoint(backend_dir=self.backend, run_id=view["run_id"], checkpoint_id=checkpoint["checkpoint_id"])
        self.assertEqual(restored["run_id"], view["run_id"])
        continued = continue_run(backend_dir=self.backend, run_id=view["run_id"], user_input={"confirmed": True}, confirmed=True, wait=True)
        self.assertEqual(continued["run_id"], view["run_id"])

    def test_file_tree_lists_frontend_before_edits(self) -> None:
        paths = list_frontend_paths(str(self.repo))
        self.assertIn("src/pages/projects.tsx", paths)
        self.assertIn("src/index.css", paths)
        self.assertIn("index.html", paths)
        self.assertNotIn("src/api/billing.ts", paths)

    def test_static_html_does_not_pause_for_raw_mode_fields(self) -> None:
        shutil.rmtree(self.repo)
        self.repo.mkdir()
        (self.repo / "index.html").write_text("<!doctype html><html><body><h1>Observatory</h1></body></html>", encoding="utf-8")
        (self.repo / "styles.css").write_text("body { margin: 0; }", encoding="utf-8")
        manifest = analyze_repository(str(self.repo))
        self.assertTrue(manifest["has_frontend_surface"])
        self.assertEqual(manifest["framework"], "static")
        view = start_run(
            backend_dir=self.backend,
            base_repo_path=str(self.repo),
            project_id="proj-html",
            tenant_id="acme",
            user_id="user-1",
            goal="Improve overall UI/UX",
            mode="full_transformation",
            wait=True,
        )
        self.assertNotEqual(view.get("interrupt_kind"), "confirm_mode")
        if view.get("interrupt_required"):
            self.assertNotEqual(view.get("current_stage"), "intake")
        self.assertIn("intake", view["completed_nodes"])
        files = list_frontend_paths(str(self.backend / "runtime" / "frontend_customization" / view["run_id"] / "working"))
        self.assertTrue(any(path.endswith("index.html") for path in files))


class ModelRouterTests(unittest.TestCase):
    def test_gateway_user_is_available_without_api_key(self) -> None:
        from frontend_customization.model_router import llm_available, sanitize_llm_config

        self.assertTrue(llm_available({"user_id": "user-1", "access_mode": "platform", "model": "best_coding"}))
        self.assertFalse(llm_available({}))
        self.assertFalse(llm_available({"provider": "openai", "model": "gpt-4.1"}))
        cleaned = sanitize_llm_config({"api_key": "sk-secret", "model": "best", "user_id": "u1"})
        self.assertNotIn("api_key", cleaned)
        self.assertEqual(cleaned["model"], "best")


if __name__ == "__main__":
    unittest.main()
