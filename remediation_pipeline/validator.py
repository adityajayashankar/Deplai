from __future__ import annotations

import os
import py_compile
import re
import subprocess
import tempfile
from pathlib import Path

from remediation_pipeline.models import Fix
from utils import CODEBASE_VOLUME, decode_output, get_docker_client


_HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


class DiffValidator:
    """Validate model-generated diffs and mark risky patches for review."""

    def validate(self, project_id: str, fix: Fix) -> Fix | None:
        if not fix.diff.strip():
            return fix

        original = self._read_repo_file(project_id, fix.filepath)
        if original is None:
            return fix.model_copy(update={"status": "needs_review", "warnings": fix.warnings + ["Target file not found in repository volume"]})

        try:
            patched = self._apply_unified_diff(original, fix.diff)
        except ValueError:
            # Reject malformed diffs entirely.
            return None

        if not patched.strip():
            return fix.model_copy(update={"status": "needs_review", "warnings": fix.warnings + ["Patched file is empty after applying diff"]})

        lint_ok, lint_warnings = self._lint_candidate(fix.filepath, patched)
        status = fix.status if lint_ok else "needs_review"
        warnings = list(fix.warnings)
        warnings.extend(lint_warnings)
        return fix.model_copy(update={"status": status, "warnings": warnings})

    @staticmethod
    def _apply_unified_diff(original: str, diff: str) -> str:
        lines = diff.splitlines()
        if not lines:
            raise ValueError("empty diff")

        original_lines = original.splitlines()
        output: list[str] = []
        src_index = 0
        i = 0
        saw_hunk = False

        while i < len(lines):
            line = lines[i]
            if line.startswith("---") or line.startswith("+++"):
                i += 1
                continue
            if not line.startswith("@@"):
                i += 1
                continue

            saw_hunk = True
            match = _HUNK_RE.match(line)
            if not match:
                raise ValueError("Malformed hunk header")

            old_start = int(match.group(1)) - 1
            if old_start < src_index:
                raise ValueError("Overlapping hunk")

            output.extend(original_lines[src_index:old_start])
            src_index = old_start
            i += 1

            while i < len(lines):
                hunk_line = lines[i]
                if hunk_line.startswith("@@"):
                    break
                if hunk_line.startswith("---") or hunk_line.startswith("+++"):
                    i += 1
                    continue
                if hunk_line.startswith("\\"):
                    i += 1
                    continue

                prefix = hunk_line[:1]
                text = hunk_line[1:]

                if prefix == " ":
                    if src_index >= len(original_lines) or original_lines[src_index] != text:
                        raise ValueError("Context mismatch while applying patch")
                    output.append(text)
                    src_index += 1
                elif prefix == "-":
                    if src_index >= len(original_lines) or original_lines[src_index] != text:
                        raise ValueError("Delete mismatch while applying patch")
                    src_index += 1
                elif prefix == "+":
                    output.append(text)
                else:
                    raise ValueError("Unexpected diff line prefix")
                i += 1

        if not saw_hunk:
            raise ValueError("No hunks present")

        output.extend(original_lines[src_index:])
        return "\n".join(output) + ("\n" if original.endswith("\n") else "")

    def _lint_candidate(self, filepath: str, content: str) -> tuple[bool, list[str]]:
        ext = Path(filepath).suffix.lower()

        with tempfile.TemporaryDirectory(prefix="deplai-remediation-") as temp_dir:
            candidate_path = Path(temp_dir) / Path(filepath).name
            candidate_path.write_text(content, encoding="utf-8")

            if ext == ".py":
                try:
                    py_compile.compile(str(candidate_path), doraise=True)
                    return True, []
                except Exception as exc:
                    return False, [f"Python compile failed: {exc}"]

            if ext in {".js", ".jsx", ".mjs", ".cjs"}:
                return self._run_command(["node", "--check", str(candidate_path)], "JavaScript parse check failed")

            if ext in {".ts", ".tsx"}:
                ts_script = (
                    "const fs=require('fs');"
                    "let ts;"
                    "try { ts=require('typescript'); } catch (e) { process.exit(2); }"
                    "const src=fs.readFileSync(process.argv[1],'utf8');"
                    "const out=ts.transpileModule(src,{reportDiagnostics:true,compilerOptions:{target:'ES2020',jsx:'react-jsx'}});"
                    "if(out.diagnostics&&out.diagnostics.length){process.stderr.write('TypeScript parse failed');process.exit(1);}"
                )
                ok, warnings = self._run_command(["node", "-e", ts_script, str(candidate_path)], "TypeScript parse check failed")
                if not ok and any("exit code 2" in w.lower() for w in warnings):
                    # typescript package is unavailable in runtime container; do not block patch.
                    return True, ["TypeScript parser unavailable in runtime; skipped lint gate"]
                return ok, warnings

            if ext == ".go":
                return self._run_command(["go", "vet", str(candidate_path)], "go vet failed")

            return True, []

    @staticmethod
    def _run_command(cmd: list[str], failure_prefix: str) -> tuple[bool, list[str]]:
        try:
            completed = subprocess.run(
                cmd,
                check=False,
                capture_output=True,
                text=True,
                timeout=15,
            )
        except FileNotFoundError:
            tool_name = cmd[0]
            return True, [f"{tool_name} not installed in runtime; skipped lint gate"]
        except Exception as exc:
            return False, [f"{failure_prefix}: {exc}"]

        if completed.returncode == 0:
            return True, []

        stderr = (completed.stderr or completed.stdout or "").strip()
        return False, [f"{failure_prefix}: exit code {completed.returncode}. {stderr}"]

    @staticmethod
    def _read_repo_file(project_id: str, rel_path: str) -> str | None:
        cleaned = str(rel_path or "").strip().replace("\\", "/").lstrip("/")
        if not cleaned:
            return None
        try:
            output = get_docker_client().containers.run(
                "alpine",
                command=["cat", f"/repo/{project_id}/{cleaned}"],
                volumes={CODEBASE_VOLUME: {"bind": "/repo", "mode": "ro"}},
                remove=True,
            )
            return decode_output(output)
        except Exception:
            return None
