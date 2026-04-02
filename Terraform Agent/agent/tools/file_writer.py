from __future__ import annotations

from pathlib import Path


def write_files(output_dir: str, files: dict[str, str]) -> str:
    root = Path(output_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)

    for rel_path, content in files.items():
        full_path = root / rel_path
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_text(content, encoding="utf-8")

    return str(root)
