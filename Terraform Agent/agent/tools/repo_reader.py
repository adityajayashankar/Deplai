from __future__ import annotations

from pathlib import Path


SUPPORTED_TEXT_SUFFIXES = {
    ".py",
    ".tf",
    ".tfvars",
    ".md",
    ".txt",
    ".yaml",
    ".yml",
    ".json",
    ".toml",
    ".env",
    ".example",
    ".dockerfile",
    "",
}


def _render_tree(path: Path, root: Path, lines: list[str], prefix: str = "") -> None:
    children = sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    for index, child in enumerate(children):
        marker = "`-- " if index == len(children) - 1 else "|-- "
        rel = child.relative_to(root).as_posix()
        lines.append(f"{prefix}{marker}{rel}")
        if child.is_dir():
            child_prefix = "    " if index == len(children) - 1 else "|   "
            _render_tree(child, root, lines, prefix + child_prefix)


def read_repo(path: str) -> dict[str, str]:
    root = Path(path).resolve()
    if not root.exists() or not root.is_dir():
        raise FileNotFoundError(f"Repository path not found: {root}")

    tree_lines = [f"repo: {root.name}"]
    _render_tree(root, root, tree_lines)

    contents: dict[str, str] = {}
    for file_path in root.rglob("*"):
        if not file_path.is_file():
            continue
        if any(part in {".git", "__pycache__", ".venv", "venv", "node_modules"} for part in file_path.parts):
            continue
        suffix = file_path.suffix.lower()
        if suffix not in SUPPORTED_TEXT_SUFFIXES and file_path.name.lower() != "dockerfile":
            continue
        rel = file_path.relative_to(root).as_posix()
        try:
            contents[rel] = file_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue

    contents["__tree__"] = "\n".join(tree_lines)
    return contents
