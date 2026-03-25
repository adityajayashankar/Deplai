#!/usr/bin/env python3
"""
Repository entrypoint detector.

Detects likely runtime/framework and deployable entrypoints by combining:
1) build/runtime config parsing (package.json, pyproject, webpack/vite config),
2) framework conventions (Next.js, Vite, React, Flask, Django, etc.),
3) served-route/template clues from server code,
4) confidence scoring to decide if user confirmation is needed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

SKIP_DIRS = {
    ".git",
    "node_modules",
    ".next",
    ".venv",
    "venv",
    "env",
    ".env",
    "__pycache__",
    ".pytest_cache",
    "dist",
    "build",
    ".idea",
    ".vscode",
    ".mypy_cache",
    ".ruff_cache",
    "tmp",
}

TEXT_EXTENSIONS = {
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".mjs",
    ".cjs",
    ".py",
    ".rb",
    ".php",
    ".java",
}

SERVER_HINT_TOKENS = (
    "server",
    "app",
    "main",
    "index",
    "route",
    "api",
    "backend",
)

MAX_DISCOVERY_FILES = 12000
MAX_SCAN_FILES = 200
MAX_TEXT_READ_BYTES = 300_000


@dataclass
class Candidate:
    path: str
    score: float
    kind: str
    reasons: List[str] = field(default_factory=list)
    sources: List[str] = field(default_factory=list)


@dataclass
class DetectionResult:
    repo_root: str
    detected_runtime: str
    detected_framework: str
    confidence: str
    requires_user_confirmation: bool
    top_candidate: Optional[Candidate]
    candidates: List[Candidate]
    suggested_questions: List[str]


def norm_rel(path: str) -> str:
    return path.replace("\\", "/").lstrip("./").strip("/")


def safe_read_text(path: Path, max_bytes: int = MAX_TEXT_READ_BYTES) -> str:
    try:
        with path.open("rb") as f:
            data = f.read(max_bytes + 1)
        if len(data) > max_bytes:
            data = data[:max_bytes]
        return data.decode("utf-8", errors="ignore")
    except OSError:
        return ""


def list_repo_files(root: Path) -> List[str]:
    files: List[str] = []

    def should_skip_dir(relative_dir: str) -> bool:
        normalized = norm_rel(relative_dir).lower()
        if not normalized:
            return False
        parts = [p for p in normalized.split("/") if p]
        if not parts:
            return False
        leaf = parts[-1]
        if leaf in SKIP_DIRS:
            return True
        if leaf.startswith("venv") or leaf.startswith(".venv"):
            return True
        if "site-packages" in parts or "dist-packages" in parts:
            return True
        return False

    for dirpath, dirnames, filenames in os.walk(root):
        kept: List[str] = []
        for d in dirnames:
            rel = norm_rel(str((Path(dirpath) / d).relative_to(root)))
            if should_skip_dir(rel):
                continue
            kept.append(d)
        dirnames[:] = kept
        for filename in filenames:
            if len(files) >= MAX_DISCOVERY_FILES:
                return files
            absolute = Path(dirpath) / filename
            relative = norm_rel(str(absolute.relative_to(root)))
            if relative:
                files.append(relative)
    files.sort()
    return files


def load_json(path: Path) -> Optional[dict]:
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def existing(paths: Sequence[str], file_map: Dict[str, str]) -> List[str]:
    hits: List[str] = []
    for p in paths:
        key = norm_rel(p).lower()
        if key in file_map:
            hits.append(file_map[key])
    return hits


def parse_script_command(command: str) -> List[Tuple[str, str]]:
    """
    Returns a list of (candidate_path, reason_fragment) extracted from script commands.
    """
    found: List[Tuple[str, str]] = []
    text = command.strip()
    if not text:
        return found

    file_cmd = re.compile(
        r"(?:^|[;&|]\s*)(?:node|nodemon|tsx|ts-node|python3?|deno run)\s+([./\w-]+\.(?:js|mjs|cjs|ts|tsx|py))",
        flags=re.IGNORECASE,
    )
    for match in file_cmd.finditer(text):
        found.append((norm_rel(match.group(1)), "script command points to executable file"))

    module_cmd = re.compile(r"(?:uvicorn|gunicorn)\s+([a-zA-Z0-9_./-]+):[a-zA-Z0-9_]+", flags=re.IGNORECASE)
    for match in module_cmd.finditer(text):
        module = match.group(1).replace(".", "/")
        found.append((f"{norm_rel(module)}.py", "script command points to ASGI/WSGI module"))

    return found


def html_score(path: str) -> float:
    p = norm_rel(path).lower()
    base = p.rsplit("/", 1)[-1]
    if p == "index.html":
        return 0.94
    if p in {"public/index.html", "src/index.html", "app/index.html"}:
        return 0.9
    if p.endswith("/index.html"):
        if p.startswith("dist/") or p.startswith("build/"):
            return 0.86
        return 0.84
    if any(token in base for token in ("home", "main", "default")) and base.endswith(".html"):
        return 0.74
    if "/templates/" in f"/{p}" or p.startswith("templates/") or "/views/" in f"/{p}":
        return 0.71
    return 0.58


def classify_runtime_and_framework(file_map: Dict[str, str], package_json: Optional[dict]) -> Tuple[str, str]:
    runtime_scores: Dict[str, int] = {"unknown": 0, "node": 0, "python": 0, "java": 0, "go": 0, "ruby": 0}
    framework = "unknown"

    if package_json:
        runtime_scores["node"] += 4
        deps = {
            **(package_json.get("dependencies") or {}),
            **(package_json.get("devDependencies") or {}),
        }
        dep_keys = {str(k).lower() for k in deps.keys()}
        if "next" in dep_keys:
            framework = "nextjs"
        elif "nuxt" in dep_keys:
            framework = "nuxt"
        elif "vite" in dep_keys and "react" in dep_keys:
            framework = "react-vite"
        elif "vite" in dep_keys and "vue" in dep_keys:
            framework = "vue-vite"
        elif "vite" in dep_keys:
            framework = "vite"
        elif "react" in dep_keys:
            framework = "react"
        elif "vue" in dep_keys:
            framework = "vue"
        elif "svelte" in dep_keys:
            framework = "svelte"
        elif "express" in dep_keys:
            framework = "express"

    if "pyproject.toml" in file_map or "requirements.txt" in file_map or "manage.py" in file_map:
        runtime_scores["python"] += 4
    if "pom.xml" in file_map or "build.gradle" in file_map or "build.gradle.kts" in file_map:
        runtime_scores["java"] += 4
    if "go.mod" in file_map:
        runtime_scores["go"] += 4
    if "gemfile" in file_map:
        runtime_scores["ruby"] += 4

    runtime = max(runtime_scores.items(), key=lambda kv: kv[1])[0]
    return runtime, framework


def detect_entries(root: Path) -> DetectionResult:
    files = list_repo_files(root)
    file_map = {f.lower(): f for f in files}

    candidates: Dict[str, Candidate] = {}

    def add_candidate(path: str, score: float, kind: str, reason: str, source: str) -> None:
        norm = norm_rel(path)
        if not norm:
            return
        key = norm.lower()
        actual = file_map.get(key, norm)
        existing_candidate = candidates.get(key)
        if existing_candidate is None:
            candidates[key] = Candidate(
                path=actual,
                score=round(float(score), 3),
                kind=kind,
                reasons=[reason],
                sources=[source],
            )
            return
        existing_candidate.score = max(existing_candidate.score, round(float(score), 3))
        if reason not in existing_candidate.reasons:
            existing_candidate.reasons.append(reason)
        if source not in existing_candidate.sources:
            existing_candidate.sources.append(source)
        if kind == "runtime_entry":
            existing_candidate.kind = kind

    package_json = load_json(root / "package.json") if "package.json" in file_map else None
    runtime, framework = classify_runtime_and_framework(file_map, package_json)

    # 1) Build/runtime config parsing
    if package_json:
        scripts = package_json.get("scripts") or {}
        main_field = package_json.get("main")
        if isinstance(main_field, str) and main_field.strip():
            add_candidate(main_field.strip(), 0.88, "runtime_entry", "package.json main field", "build_config")

        for script_name, script_cmd in scripts.items():
            if not isinstance(script_cmd, str):
                continue
            for parsed_path, reason in parse_script_command(script_cmd):
                add_candidate(parsed_path, 0.86, "runtime_entry", f"{script_name} script: {reason}", "build_config")

            cmd_l = script_cmd.lower()
            if "next " in cmd_l:
                for hit in existing(
                    [
                        "src/app/page.tsx",
                        "src/app/page.jsx",
                        "app/page.tsx",
                        "app/page.jsx",
                        "pages/index.tsx",
                        "pages/index.jsx",
                    ],
                    file_map,
                ):
                    add_candidate(hit, 0.9, "web_entry", "Next.js script + framework convention", "build_config")
            if "vite" in cmd_l:
                for hit in existing(["index.html", "public/index.html"], file_map):
                    add_candidate(hit, 0.9, "web_entry", "Vite script + convention", "build_config")

    for config_file, fw_name, fw_paths, score in [
        ("next.config.js", "nextjs", ["src/app/page.tsx", "app/page.tsx", "pages/index.tsx"], 0.89),
        ("next.config.ts", "nextjs", ["src/app/page.tsx", "app/page.tsx", "pages/index.tsx"], 0.89),
        ("nuxt.config.ts", "nuxt", ["app.vue", "pages/index.vue"], 0.88),
        ("vite.config.ts", "vite", ["index.html", "public/index.html", "src/main.ts", "src/main.js"], 0.86),
        ("vite.config.js", "vite", ["index.html", "public/index.html", "src/main.ts", "src/main.js"], 0.86),
        ("angular.json", "angular", ["src/main.ts", "src/index.html"], 0.86),
        ("svelte.config.js", "svelte", ["src/routes/+page.svelte", "src/app.html"], 0.86),
    ]:
        if config_file in file_map:
            if framework == "unknown":
                framework = fw_name
            for hit in existing(fw_paths, file_map):
                add_candidate(hit, score, "web_entry", f"{config_file} + framework convention", "framework_convention")

    # Simple webpack entry parsing.
    for wp in existing(["webpack.config.js", "webpack.config.ts"], file_map):
        text = safe_read_text(root / wp)
        for match in re.finditer(r"entry\s*:\s*['\"]([^'\"]+)['\"]", text):
            add_candidate(match.group(1), 0.87, "runtime_entry", "webpack entry field", "build_config")
        for match in re.finditer(r"entry\s*:\s*\{[^}]*['\"]?[\w-]+['\"]?\s*:\s*['\"]([^'\"]+)['\"]", text, flags=re.S):
            add_candidate(match.group(1), 0.86, "runtime_entry", "webpack entry object", "build_config")

    # Python config hints.
    if "pyproject.toml" in file_map:
        pyproject_text = safe_read_text(root / file_map["pyproject.toml"])
        for match in re.finditer(r"(?m)^([\w.-]+)\s*=\s*\"([\w./-]+):[\w.-]+\"", pyproject_text):
            possible = f"{match.group(2).replace('.', '/')}.py"
            add_candidate(possible, 0.85, "runtime_entry", "pyproject script/module entry", "build_config")
        for hit in existing(["main.py", "app.py", "src/main.py"], file_map):
            add_candidate(hit, 0.82, "runtime_entry", "pyproject detected with common Python entry", "framework_convention")

    # Procfile hints.
    if "procfile" in file_map:
        proc = safe_read_text(root / file_map["procfile"])
        for line in proc.splitlines():
            if ":" not in line:
                continue
            name, command = line.split(":", 1)
            if name.strip().lower() not in {"web", "worker"}:
                continue
            for parsed_path, reason in parse_script_command(command):
                add_candidate(parsed_path, 0.87, "runtime_entry", f"Procfile {name.strip()} {reason}", "build_config")

    # 2) Framework conventions
    convention_paths = [
        ("nextjs", ["src/app/page.tsx", "app/page.tsx", "pages/index.tsx", "pages/index.jsx"], 0.86),
        ("react", ["src/main.tsx", "src/main.jsx", "src/index.tsx", "src/index.jsx"], 0.82),
        ("vue", ["src/main.ts", "src/main.js", "src/App.vue"], 0.82),
        ("svelte", ["src/main.ts", "src/main.js", "src/routes/+page.svelte"], 0.82),
        ("python", ["app.py", "main.py", "manage.py", "wsgi.py", "asgi.py"], 0.8),
        ("node", ["server.js", "app.js", "src/server.ts", "src/index.ts"], 0.79),
    ]
    for fw_or_rt, paths, score in convention_paths:
        if framework == fw_or_rt or runtime == fw_or_rt or fw_or_rt == "python":
            for hit in existing(paths, file_map):
                kind = "web_entry" if hit.lower().endswith((".html", ".tsx", ".jsx", ".vue", ".svelte")) else "runtime_entry"
                add_candidate(hit, score, kind, f"{fw_or_rt} convention path", "framework_convention")

    # Add html candidates from discovered files.
    for rel in files:
        if rel.lower().endswith((".html", ".htm")):
            add_candidate(rel, html_score(rel), "web_entry", "HTML file discovered in repository", "framework_convention")

    # 3) Server route/template scanning
    scan_candidates = [f for f in files if Path(f).suffix.lower() in TEXT_EXTENSIONS]
    scan_candidates.sort(
        key=lambda p: (
            0
            if any(token in p.lower() for token in SERVER_HINT_TOKENS)
            else 1,
            len(p),
        )
    )
    scan_candidates = scan_candidates[:MAX_SCAN_FILES]

    for rel in scan_candidates:
        text = safe_read_text(root / rel)
        if not text:
            continue

        for match in re.finditer(r"sendFile\([^)]*['\"]([^'\"]+\.html?)['\"]", text, flags=re.IGNORECASE):
            add_candidate(match.group(1), 0.93, "web_entry", f"{rel}: sendFile HTML route", "server_routes")

        for match in re.finditer(r"express\.static\(\s*['\"]([^'\"]+)['\"]\s*\)", text, flags=re.IGNORECASE):
            directory = norm_rel(match.group(1))
            if directory:
                add_candidate(f"{directory}/index.html", 0.85, "web_entry", f"{rel}: express.static directory", "server_routes")

        for match in re.finditer(r"render_template\(\s*['\"]([^'\"]+\.html?)['\"]", text, flags=re.IGNORECASE):
            template = norm_rel(match.group(1))
            add_candidate(f"templates/{template}", 0.91, "web_entry", f"{rel}: Flask render_template", "server_routes")
            add_candidate(template, 0.87, "web_entry", f"{rel}: Flask render_template", "server_routes")

        for match in re.finditer(r"render\([^,]+,\s*['\"]([^'\"]+\.html?)['\"]", text, flags=re.IGNORECASE):
            template = norm_rel(match.group(1))
            add_candidate(f"templates/{template}", 0.9, "web_entry", f"{rel}: Django render", "server_routes")
            add_candidate(template, 0.86, "web_entry", f"{rel}: Django render", "server_routes")

        for match in re.finditer(r"TemplateResponse\(\s*['\"]([^'\"]+\.html?)['\"]", text, flags=re.IGNORECASE):
            template = norm_rel(match.group(1))
            add_candidate(f"templates/{template}", 0.9, "web_entry", f"{rel}: TemplateResponse", "server_routes")
            add_candidate(template, 0.86, "web_entry", f"{rel}: TemplateResponse", "server_routes")

    # Normalize to existing files when possible (e.g. "templates/foo.html").
    normalized_candidates: List[Candidate] = []
    for cand in candidates.values():
        key = cand.path.lower()
        if key in file_map:
            cand.path = file_map[key]
        normalized_candidates.append(cand)

    normalized_candidates.sort(key=lambda c: (c.score, -len(c.path)), reverse=True)

    top = normalized_candidates[0] if normalized_candidates else None
    second = normalized_candidates[1] if len(normalized_candidates) > 1 else None

    if not top:
        confidence = "low"
        requires_user = True
    else:
        gap = top.score - (second.score if second else 0.0)
        if top.score >= 0.88 and gap >= 0.12:
            confidence = "high"
            requires_user = False
        elif top.score >= 0.75 and gap >= 0.08:
            confidence = "medium"
            requires_user = False
        else:
            confidence = "low"
            requires_user = True

    questions: List[str] = []
    if requires_user:
        questions.append("Which runtime command should launch this app in production?")
        questions.append("Which file/path should be treated as the primary web entrypoint?")
        if runtime == "unknown":
            questions.append("What stack is this service using (Node, Python, Java, etc.)?")

    return DetectionResult(
        repo_root=str(root.resolve()),
        detected_runtime=runtime,
        detected_framework=framework,
        confidence=confidence,
        requires_user_confirmation=requires_user,
        top_candidate=top,
        candidates=normalized_candidates[:12],
        suggested_questions=questions[:3],
    )


def print_human(result: DetectionResult) -> None:
    print(f"Repository: {result.repo_root}")
    print(f"Runtime: {result.detected_runtime}")
    print(f"Framework: {result.detected_framework}")
    print(f"Confidence: {result.confidence}")
    print(f"Needs user confirmation: {'yes' if result.requires_user_confirmation else 'no'}")
    print("")

    if result.top_candidate:
        tc = result.top_candidate
        print(f"Top candidate: {tc.path} ({tc.kind}, score={tc.score:.3f})")
        for reason in tc.reasons:
            print(f"  - {reason}")
    else:
        print("Top candidate: none")

    print("")
    print("Candidates:")
    if not result.candidates:
        print("  (none)")
    for idx, cand in enumerate(result.candidates, start=1):
        print(f"  {idx:02d}. {cand.path} [{cand.kind}] score={cand.score:.3f} sources={','.join(cand.sources)}")

    if result.suggested_questions:
        print("")
        print("Suggested user questions:")
        for q in result.suggested_questions:
            print(f"  - {q}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Detect likely runtime and entrypoints from a repository.",
    )
    parser.add_argument(
        "repo",
        nargs="?",
        default=".",
        help="Repository path to inspect (default: current directory).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output JSON only.",
    )
    args = parser.parse_args()

    root = Path(args.repo).resolve()
    if not root.exists() or not root.is_dir():
        raise SystemExit(f"Invalid repository path: {root}")

    result = detect_entries(root)

    if args.json:
        payload = asdict(result)
        print(json.dumps(payload, indent=2))
    else:
        print_human(result)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
