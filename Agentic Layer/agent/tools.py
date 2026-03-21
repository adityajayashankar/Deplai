"""Agent tools for reading, searching, and writing within Docker volumes."""

import base64
import re
import shlex
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from langchain_core.tools import tool
from utils import get_docker_client, decode_output, get_repo_root, CODEBASE_VOLUME, LLM_OUTPUT_VOLUME

# Allowlist: relative paths must contain only safe characters.
_SAFE_PATH_RE = re.compile(r'^[a-zA-Z0-9_\-. /]+$')


def _safe_rel_path(path: str) -> str | None:
    """Return the sanitised relative path, or None if it looks malicious."""
    path = path.strip("/")
    # Reject directory traversal and shell metacharacters
    if not path or ".." in path.split("/") or not _SAFE_PATH_RE.match(path):
        return None
    return path


@tool
def list_files(directory: str = "/") -> str:
    """List files and directories in the codebase.

    Args:
        directory: Relative path inside the codebase to list. Defaults to root.
    """
    safe_dir = _safe_rel_path(directory) if directory and directory != "/" else ""
    if directory and directory != "/" and safe_dir is None:
        return "Error: invalid directory path."
    repo_root = get_repo_root()
    target = f"{repo_root}/{safe_dir}" if safe_dir else repo_root
    try:
        output = get_docker_client().containers.run(
            "alpine",
            command=[
                "sh", "-c",
                # target is constructed from repo_root (trusted) + validated safe_dir
                f"find {shlex.quote(target)} -maxdepth 2 -type f "
                "\\( -name '*.py' -o -name '*.js' -o -name '*.ts' -o -name '*.tsx' "
                "-o -name '*.java' -o -name '*.go' -o -name '*.rs' -o -name '*.rb' "
                "-o -name '*.php' -o -name '*.c' -o -name '*.cpp' -o -name '*.h' "
                "-o -name '*.cs' -o -name '*.swift' -o -name '*.kt' "
                "-o -name '*.json' -o -name '*.yaml' -o -name '*.yml' "
                "-o -name '*.toml' -o -name '*.cfg' -o -name '*.ini' "
                "-o -name '*.md' -o -name '*.txt' -o -name '*.html' -o -name '*.css' "
                "-o -name 'Dockerfile' -o -name 'Makefile' -o -name '*.xml' "
                "-o -name '*.gradle' -o -name 'pom.xml' -o -name 'package.json' "
                "-o -name 'requirements.txt' -o -name 'Cargo.toml' -o -name 'go.mod' "
                f"\\) 2>/dev/null | head -200 | sed 's|^{shlex.quote(repo_root)}/||'"
            ],
            volumes={CODEBASE_VOLUME: {"bind": "/repo", "mode": "ro"}},
            remove=True,
        )
        result = decode_output(output).strip()
        return result if result else "No files found in this directory."
    except Exception as e:
        return f"Error listing files: {e}"


@tool
def read_file(filepath: str) -> str:
    """Read a file from the codebase.

    Args:
        filepath: Relative path of the file inside the codebase.
    """
    safe_path = _safe_rel_path(filepath)
    if safe_path is None:
        return "Error: invalid file path."
    repo_root = get_repo_root()
    full_path = shlex.quote(f"{repo_root}/{safe_path}")
    try:
        output = get_docker_client().containers.run(
            "alpine",
            command=["sh", "-c", f"head -300 {full_path} 2>/dev/null || true"],
            volumes={CODEBASE_VOLUME: {"bind": "/repo", "mode": "ro"}},
            remove=True,
        )
        return decode_output(output)
    except Exception as e:
        return f"Error reading file: {e}"


@tool
def search_code(pattern: str, file_extensions: str = "py,js,ts,java,go") -> str:
    """Search for a text pattern across the codebase files.

    Args:
        pattern: Text or regex pattern to search for.
        file_extensions: Comma-separated file extensions to search (default: py,js,ts,java,go).
    """
    # Validate extensions: only alphanumeric characters
    safe_exts = [re.sub(r'[^a-zA-Z0-9]', '', e.strip()) for e in file_extensions.split(",")]
    safe_exts = [e for e in safe_exts if e]
    include_args = " ".join(f"--include={shlex.quote('*.' + ext)}" for ext in safe_exts)
    repo_root = get_repo_root()
    # Use shlex.quote so the pattern cannot break out of its argument position
    try:
        output = get_docker_client().containers.run(
            "alpine",
            command=[
                "sh", "-c",
                f"grep -rn {include_args} -e {shlex.quote(pattern)} {shlex.quote(repo_root + '/')} 2>/dev/null "
                f"| head -50 | sed 's|^{shlex.quote(repo_root)}/||'"
            ],
            volumes={CODEBASE_VOLUME: {"bind": "/repo", "mode": "ro"}},
            remove=True,
        )
        result = decode_output(output).strip()
        return result if result else "No matches found."
    except Exception as e:
        return f"Error searching code: {e}"


@tool
def write_summary(content: str) -> str:
    """Write the final analysis summary to the output volume as summary.txt.

    Args:
        content: The full summary text to write.
    """
    try:
        client = get_docker_client()
        try:
            client.volumes.get(LLM_OUTPUT_VOLUME)
        except Exception:
            client.volumes.create(name=LLM_OUTPUT_VOLUME)

        # Base64-encode content so it cannot contain shell metacharacters, then
        # pass it via shlex.quote to guard against any edge-case characters.
        encoded = base64.b64encode(content.encode()).decode()
        client.containers.run(
            "alpine",
            command=[
                "sh", "-c",
                f"echo {shlex.quote(encoded)} | base64 -d > /output/summary.txt"
            ],
            volumes={LLM_OUTPUT_VOLUME: {"bind": "/output", "mode": "rw"}},
            remove=True,
        )
        return "Summary successfully written to LLM_Output/summary.txt"
    except Exception as e:
        return f"Error writing summary: {e}"


analysis_tools = [list_files, read_file, search_code, write_summary]
