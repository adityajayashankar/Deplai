"""Deterministic application deployment manifests.

This module is intentionally independent of the planning/LLM layer.  It is the
only code that inspects an application repository on the deploy path and it
only uses an explicit ``deplai.yaml`` or a small, ordered set of file signals.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:  # PyYAML is an Agentic Layer runtime dependency.
    import yaml
except ImportError:  # pragma: no cover - surfaced as an actionable deploy error
    yaml = None  # type: ignore[assignment]


MANIFEST_FILENAMES = ("deplai.yaml", "deplai.yml")
CACHE_VERSION = 2
CACHE_ROOT = Path(__file__).resolve().parent / ".deplai_runtime" / "manifest_cache"
NODE_WORKSPACE_COMMAND = "deplai-node-workspace"
NODE_WEB_DIR_NAMES = ("frontend", "web", "client")
NODE_API_DIR_NAMES = ("backend", "server", "api")
NODE_ADMIN_DIR_NAMES = ("admin-frontend", "admin")
DATASTORE_PORTS = frozenset({5432, 3306, 6379, 27017, 1433, 1521})

SUPPORTED_RUNTIMES = frozenset({"docker", "node", "python", "java", "go", "ruby", "static"})
SUPPORTED_STRATEGIES = frozenset({"docker", "buildpack", "cloud_init"})
EXECUTOR_REGISTRY: dict[str, frozenset[str]] = {
    "docker": frozenset({"docker"}),
    "buildpack": frozenset({"node", "python", "java", "go", "ruby"}),
    "cloud_init": frozenset({"node", "python", "java", "go", "ruby", "static"}),
}

APP_ROOT_CANDIDATES = (".", "frontend", "web", "client", "app", "backend", "server", "api")
DOCKER_COMPOSE_FILENAMES = ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml")
DOCKERFILE_FILENAMES = ("Dockerfile", "dockerfile")
PYTHON_MARKER_FILES = (
    "requirements.txt",
    "pyproject.toml",
    "Pipfile",
    "manage.py",
    "app.py",
    "main.py",
    "server.py",
)
PYTHON_ENTRY_NAMES = (
    "manage.py",
    "app.py",
    "main.py",
    "server.py",
    "wsgi.py",
    "asgi.py",
    "application.py",
    "run.py",
    "api.py",
)
PYTHON_ENTRY_DIRS = (".", "src", "app", "backend", "server", "api")
SECRET_ENV_NAME = re.compile(r"(?:secret|password|token|private.?key|api.?key)", re.IGNORECASE)
ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class ManifestResolutionError(ValueError):
    """A repository cannot be deployed without an unambiguous manifest."""

    def __init__(self, reason: str, *, source_root: Path | None = None) -> None:
        location = f" in {source_root}" if source_root else ""
        super().__init__(
            f"deterministic_manifest_required{location}: {reason}. "
            "Add a deplai.yaml with runtime, strategy, build_command, start_command, port, and health_check_path."
        )


@dataclass(frozen=True)
class DeploymentManifest:
    """Validated manifest used by certified deployment executors only."""

    name: str
    runtime: str
    strategy: str
    runtime_version: str = ""
    build_command: str = ""
    start_command: str = ""
    port: int | None = None
    health_check_path: str = "/"
    env: tuple[str, ...] = ()
    app_root: str = "."
    origin: str = "detected"
    signals: tuple[str, ...] = ()
    explicit_fields: frozenset[str] = field(default_factory=frozenset, repr=False, compare=False)

    @property
    def is_user_supplied(self) -> bool:
        return self.origin == "user"

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "runtime": self.runtime,
            "runtime_version": self.runtime_version or None,
            "build_command": self.build_command,
            "start_command": self.start_command,
            "port": self.port,
            "health_check_path": self.health_check_path,
            "env": list(self.env),
            "strategy": self.strategy,
            "app_root": self.app_root,
            "origin": self.origin,
            "signals": list(self.signals),
        }


def _safe_name(value: Any) -> str:
    name = str(value or "").strip()
    if not name:
        return ""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", name):
        raise ManifestResolutionError("name must contain only letters, numbers, dots, underscores, or hyphens")
    return name


def _normalise_path(value: Any) -> str:
    path = str(value or "/").strip() or "/"
    if not path.startswith("/"):
        path = f"/{path}"
    if "\n" in path or "\r" in path or not re.fullmatch(r"/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*", path):
        raise ManifestResolutionError("health_check_path must be a safe absolute HTTP path")
    return path


def _normalise_port(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        port = int(value)
    except (TypeError, ValueError) as exc:
        raise ManifestResolutionError("port must be an integer between 1 and 65535") from exc
    if not 1 <= port <= 65535:
        raise ManifestResolutionError("port must be between 1 and 65535")
    return port


def _normalise_env(value: Any) -> tuple[str, ...]:
    if value in (None, ""):
        return ()
    if not isinstance(value, list):
        raise ManifestResolutionError("env must be a YAML list of KEY=value strings")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or "=" not in item:
            raise ManifestResolutionError("each env value must use KEY=value form")
        key, raw_value = item.split("=", 1)
        key = key.strip()
        if not ENV_KEY.fullmatch(key):
            raise ManifestResolutionError(f"invalid environment variable name {key!r}")
        if SECRET_ENV_NAME.search(key):
            raise ManifestResolutionError(
                f"{key} cannot be stored in deplai.yaml; use AWS Secrets Manager for secret values"
            )
        if "\x00" in raw_value or "\n" in raw_value or "\r" in raw_value:
            raise ManifestResolutionError(f"{key} must be a single-line environment value")
        entry = f"{key}={raw_value}"
        if entry not in result:
            result.append(entry)
    return tuple(result)


def _normalise_app_root(value: Any) -> str:
    root = str(value or ".").strip().replace("\\", "/") or "."
    root = root.strip("/") or "."
    if root == ".":
        return root
    if root.startswith("../") or "/../" in root or not re.fullmatch(r"[A-Za-z0-9._/-]+", root):
        raise ManifestResolutionError("app_root must be a relative repository path")
    return root


def _validate_manifest(
    payload: dict[str, Any],
    *,
    origin: str,
    default_name: str,
    signals: tuple[str, ...] = (),
) -> DeploymentManifest:
    explicit_fields = frozenset(str(key) for key in payload.keys())
    runtime = str(payload.get("runtime") or "").strip().lower()
    strategy = str(payload.get("strategy") or "").strip().lower()
    if runtime not in SUPPORTED_RUNTIMES:
        allowed = ", ".join(sorted(SUPPORTED_RUNTIMES - {"static"}))
        raise ManifestResolutionError(f"runtime must be one of {allowed}")
    if not strategy:
        strategy = "docker" if runtime == "docker" else ("cloud_init" if runtime == "static" else "buildpack")
    if strategy not in SUPPORTED_STRATEGIES or runtime not in EXECUTOR_REGISTRY.get(strategy, frozenset()):
        raise ManifestResolutionError(f"strategy {strategy!r} is not certified for runtime {runtime!r}")

    name = _safe_name(payload.get("name")) or _safe_name(default_name)
    if not name:
        raise ManifestResolutionError("name is required")
    build_command = str(payload.get("build_command") or "").strip()
    start_command = str(payload.get("start_command") or "").strip()
    for label, command in (("build_command", build_command), ("start_command", start_command)):
        if "\x00" in command or "\n" in command or "\r" in command:
            raise ManifestResolutionError(f"{label} must be a single line")
    if runtime not in {"docker", "static"} and not start_command:
        raise ManifestResolutionError(f"{runtime} needs an explicit start_command")
    if origin == "user" and runtime not in {"docker", "static"} and not build_command:
        # Buildpacks may not need a command, but an explicit manifest must not hide
        # an important build decision.  `:` makes an intentional no-build step clear.
        raise ManifestResolutionError("an explicit non-container manifest needs build_command (use ':' when no build is needed)")

    return DeploymentManifest(
        name=name,
        runtime=runtime,
        strategy=strategy,
        runtime_version=str(payload.get("runtime_version") or "").strip(),
        build_command=build_command,
        start_command=start_command,
        port=_normalise_port(payload.get("port")),
        health_check_path=_normalise_path(payload.get("health_check_path") or "/"),
        env=_normalise_env(payload.get("env")),
        app_root=_normalise_app_root(payload.get("app_root") or "."),
        origin=origin,
        signals=signals,
        explicit_fields=explicit_fields,
    )


def _fill_missing_user_commands(payload: dict[str, Any], base: Path) -> dict[str, Any]:
    """Keep user-supplied fields and infer only the commands they omitted."""
    filled = dict(payload)
    runtime = str(filled.get("runtime") or "").strip().lower()
    if runtime == "python":
        if not str(filled.get("start_command") or "").strip():
            start, _ = _infer_python_start(base)
            filled["start_command"] = start or "python3 app.py"
        if not str(filled.get("build_command") or "").strip():
            filled["build_command"], _ = _python_build_command(base, "python")
    elif runtime == "node":
        package_json = _package_json(base)
        scripts = package_json.get("scripts") if isinstance(package_json.get("scripts"), dict) else {}
        if not str(filled.get("start_command") or "").strip():
            filled["start_command"] = _node_start_command(base, scripts)
        if not str(filled.get("build_command") or "").strip():
            filled["build_command"] = (
                "npm run build" if isinstance(scripts.get("build"), str) and scripts["build"].strip() else ":"
            )
    elif runtime in {"java", "go", "ruby"} and (
        not str(filled.get("start_command") or "").strip() or not str(filled.get("build_command") or "").strip()
    ):
        detected = _language_manifest(runtime, base, str(filled.get("name") or "app"), ".")
        if not str(filled.get("start_command") or "").strip():
            filled["start_command"] = detected.start_command
        if not str(filled.get("build_command") or "").strip():
            filled["build_command"] = detected.build_command
    return filled


def _read_yaml_manifest(path: Path, project_name: str) -> DeploymentManifest:
    if yaml is None:
        raise ManifestResolutionError("PyYAML is required to parse deplai.yaml", source_root=path.parent)
    try:
        payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ManifestResolutionError(f"could not parse {path.name}: {exc}", source_root=path.parent) from exc
    if not isinstance(payload, dict):
        raise ManifestResolutionError(f"{path.name} must contain a YAML mapping", source_root=path.parent)
    app_root = path.parent / _normalise_app_root(payload.get("app_root") or ".")
    if not app_root.is_dir():
        raise ManifestResolutionError(
            f"app_root {_normalise_app_root(payload.get('app_root') or '.')} does not exist",
            source_root=path.parent,
        )
    payload = _fill_missing_user_commands(payload, app_root)
    return _validate_manifest(payload, origin="user", default_name=project_name, signals=(path.name,))


def _file_digest(path: Path, digest: "hashlib._Hash") -> None:
    digest.update(path.as_posix().encode("utf-8"))
    digest.update(b"\0")
    try:
        digest.update(path.read_bytes())
    except OSError:
        digest.update(b"<unreadable>")
    digest.update(b"\0")


def manifest_fingerprint(root: Path) -> str:
    """Hash only the files that can affect manifest resolution.

    This is intentionally content-based rather than timestamp-based, so a
    redeploy for the same repository revision skips detection even when it is
    cloned into another working directory.
    """
    digest = hashlib.sha256(f"deplai-manifest-v{CACHE_VERSION}\0".encode("utf-8"))
    relevant: list[Path] = []
    for filename in MANIFEST_FILENAMES:
        candidate = root / filename
        if candidate.is_file():
            relevant.append(candidate)
    for subdir in APP_ROOT_CANDIDATES:
        base = root if subdir == "." else root / subdir
        if not base.is_dir():
            continue
        for filename in (
            *DOCKERFILE_FILENAMES,
            *DOCKER_COMPOSE_FILENAMES,
            "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
            "requirements.txt", "pyproject.toml", "Pipfile", "poetry.lock",
            "app.py", "main.py", "server.py", "manage.py", "wsgi.py", "asgi.py",
            "application.py", "run.py", "api.py",
            "pom.xml", "build.gradle", "build.gradle.kts", "go.mod", "Gemfile", "Procfile",
            "dist/index.html", "build/index.html", "out/index.html",
        ):
            candidate = base / filename
            if candidate.is_file():
                relevant.append(candidate)
    for path in sorted(set(relevant), key=lambda item: item.as_posix()):
        _file_digest(path.relative_to(root), digest) if False else None
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        try:
            digest.update(path.read_bytes())
        except OSError:
            digest.update(b"<unreadable>")
        digest.update(b"\0")
    return digest.hexdigest()


def _cache_path(fingerprint: str) -> Path:
    return CACHE_ROOT / f"{fingerprint}.json"


def _load_cached_manifest(fingerprint: str, project_name: str) -> DeploymentManifest | None:
    path = _cache_path(fingerprint)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(payload, dict) or payload.get("cache_version") != CACHE_VERSION:
        return None
    raw_manifest = payload.get("manifest")
    if not isinstance(raw_manifest, dict):
        return None
    try:
        return _validate_manifest(
            raw_manifest,
            origin=str(raw_manifest.get("origin") or "detected"),
            default_name=project_name,
            signals=tuple(str(item) for item in raw_manifest.get("signals") or []),
        )
    except ManifestResolutionError:
        return None


def _store_manifest(fingerprint: str, manifest: DeploymentManifest) -> None:
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    path = _cache_path(fingerprint)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps({"cache_version": CACHE_VERSION, "manifest": manifest.as_dict()}, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _package_json(base: Path) -> dict[str, Any]:
    try:
        payload = json.loads((base / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _port_from_package_scripts(base: Path, default: int) -> int:
    package = _package_json(base)
    scripts = package.get("scripts") if isinstance(package.get("scripts"), dict) else {}
    blob = " ".join(str(value) for value in scripts.values())
    match = re.search(r"(?:-p|--port)\s+(\d{2,5})", blob)
    if not match:
        return default
    port = int(match.group(1))
    if 1 <= port <= 65535 and port not in DATASTORE_PORTS:
        return port
    return default


def _first_package_dir(root: Path, names: tuple[str, ...]) -> str | None:
    for relative in names:
        if (root / relative / "package.json").is_file():
            return relative
    return None


def _detect_node_workspace_manifest(root: Path, project_name: str) -> DeploymentManifest | None:
    """Treat frontend+backend (or web+api) as one app, not a static dump or a single SPA."""
    web_rel = _first_package_dir(root, NODE_WEB_DIR_NAMES)
    api_rel = _first_package_dir(root, NODE_API_DIR_NAMES)
    if not web_rel or not api_rel:
        return None
    port = _port_from_package_scripts(root / web_rel, 3000)
    signals = [f"{web_rel}/package.json", f"{api_rel}/package.json"]
    admin_rel = _first_package_dir(root, NODE_ADMIN_DIR_NAMES)
    if admin_rel:
        signals.append(f"{admin_rel}/package.json")
    return _validate_manifest(
        {
            "name": project_name,
            "runtime": "node",
            "strategy": "cloud_init",
            "build_command": NODE_WORKSPACE_COMMAND,
            "start_command": NODE_WORKSPACE_COMMAND,
            "port": port,
            "app_root": ".",
        },
        origin="detected",
        default_name=project_name,
        signals=tuple(signals),
    )


def bootstrap_fallback_from_repository_context(
    repository_context: dict[str, Any] | None,
    *,
    repository_url: str = "",
) -> dict[str, Any]:
    """When packaging fails, still start a Node workspace instead of nginx-copying source."""
    result: dict[str, Any] = {}
    if repository_url:
        result["repository_url"] = str(repository_url).strip()
    ctx = repository_context if isinstance(repository_context, dict) else {}
    names: set[str] = set()
    frameworks = ctx.get("frameworks")
    if isinstance(frameworks, list):
        for item in frameworks:
            if isinstance(item, dict):
                names.add(str(item.get("name") or "").strip().lower())
            else:
                names.add(str(item).strip().lower())
    frontend = ctx.get("frontend") if isinstance(ctx.get("frontend"), dict) else {}
    backend = ctx.get("backend") if isinstance(ctx.get("backend"), dict) else {}
    hints = ctx.get("infrastructure_hints") if isinstance(ctx.get("infrastructure_hints"), dict) else {}
    language = ctx.get("language") if isinstance(ctx.get("language"), dict) else {}
    runtime = str(language.get("runtime") or "").strip().lower()
    frontend_name = str(frontend.get("framework") or frontend.get("name") or "").strip().lower()
    nodeish = bool(
        names
        & {"nextjs", "next.js", "express", "nestjs", "react", "node", "nodejs"}
        or frontend_name in {"nextjs", "next.js", "react", "vue", "nuxt"}
        or runtime in {"node", "nodejs", "javascript", "typescript"}
    )
    workspace = bool(
        hints.get("monorepo")
        or (frontend and backend)
        or ("express" in names and names & {"nextjs", "next.js", "react"})
    )
    if workspace:
        result.update(
            {
                "app_kind": "node",
                "app_subdir": ".",
                "build_command": NODE_WORKSPACE_COMMAND,
                "start_command": NODE_WORKSPACE_COMMAND,
            }
        )
    elif nodeish:
        result["app_kind"] = "node"
        result["app_subdir"] = "."
    return result


def _node_start_command(base: Path, scripts: dict[str, Any]) -> str:
    if isinstance(scripts.get("start"), str) and scripts["start"].strip():
        return "npm run start"
    for filename, command in (
        ("server.js", "node server.js"),
        ("app.js", "node app.js"),
        ("index.js", "node index.js"),
    ):
        if (base / filename).is_file():
            return command
    return ""


def _node_manifest(base: Path, project_name: str, relative_root: str) -> DeploymentManifest | None:
    package_json = _package_json(base)
    scripts = package_json.get("scripts") if isinstance(package_json.get("scripts"), dict) else {}
    build = "npm run build" if isinstance(scripts.get("build"), str) and scripts["build"].strip() else ":"
    start = _node_start_command(base, scripts)
    if not start:
        # package.json without a startable entry is tooling, not a Node app.
        # Continue detection so a sibling Python/Java/Go runtime can win.
        return None
    engines = package_json.get("engines") if isinstance(package_json.get("engines"), dict) else {}
    return _validate_manifest(
        {
            "name": project_name,
            "runtime": "node",
            "runtime_version": str(engines.get("node") or ""),
            "build_command": build,
            "start_command": start,
            "strategy": "buildpack",
            "app_root": relative_root,
        },
        origin="detected",
        default_name=project_name,
        signals=(f"{relative_root}/package.json",),
    )


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _python_dependency_blob(base: Path) -> str:
    parts: list[str] = []
    for filename in ("requirements.txt", "requirements-prod.txt", "Pipfile", "pyproject.toml", "poetry.lock"):
        candidate = base / filename
        if candidate.is_file():
            parts.append(_read_text(candidate).lower())
    return "\n".join(parts)


def _procfile_web_command(base: Path) -> str:
    procfile = base / "Procfile"
    if not procfile.is_file():
        return ""
    for line in _read_text(procfile).splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, sep, value = stripped.partition(":")
        if sep and key.strip().lower() == "web" and value.strip():
            return value.strip().replace("${PORT}", "$APP_PORT").replace("$PORT", "$APP_PORT")
    return ""


def _pyproject_console_script(base: Path) -> str:
    path = base / "pyproject.toml"
    if not path.is_file():
        return ""
    try:
        import tomllib
        payload = tomllib.loads(_read_text(path))
    except Exception:
        return ""
    if not isinstance(payload, dict):
        return ""
    scripts: dict[str, Any] = {}
    project = payload.get("project")
    if isinstance(project, dict) and isinstance(project.get("scripts"), dict):
        scripts.update(project["scripts"])
    tool = payload.get("tool")
    poetry = tool.get("poetry") if isinstance(tool, dict) else None
    if isinstance(poetry, dict) and isinstance(poetry.get("scripts"), dict):
        scripts.update(poetry["scripts"])
    for preferred in ("start", "serve", "web", "app", "main"):
        if preferred in scripts and str(scripts[preferred]).strip():
            return preferred
    for name, target in scripts.items():
        if str(name).strip() and str(target).strip():
            return str(name).strip()
    return ""


def _python_entry_file(base: Path) -> Path | None:
    for relative in PYTHON_ENTRY_DIRS:
        folder = base if relative == "." else base / relative
        if not folder.is_dir():
            continue
        for filename in PYTHON_ENTRY_NAMES:
            candidate = folder / filename
            if candidate.is_file():
                return candidate
    return None


def _start_from_python_entry(base: Path, entry: Path) -> str:
    rel = entry.relative_to(base).as_posix()
    text = _read_text(entry).lower()
    parent = entry.parent
    module = entry.stem
    pythonpath = ""
    if parent != base:
        pythonpath = f"PYTHONPATH={parent.relative_to(base).as_posix()} "

    if entry.name == "manage.py":
        prefix = f"cd {parent.relative_to(base).as_posix()} && " if parent != base else ""
        return f"{prefix}python3 manage.py runserver 0.0.0.0:$APP_PORT"

    asgi = entry.name == "asgi.py" or "fastapi" in text or "starlette" in text
    wsgi = entry.name in {"wsgi.py", "application.py"} or "flask(" in text or "from flask" in text
    obj = "application" if re.search(r"\bapplication\s*=", text) else "app"

    if asgi:
        return f"{pythonpath}python3 -m uvicorn {module}:{obj} --host 0.0.0.0 --port $APP_PORT".strip()
    if wsgi:
        return f"{pythonpath}python3 -m gunicorn {module}:{obj} --bind 0.0.0.0:$APP_PORT".strip()
    return f"python3 {rel}"


def _python_start_from_deps(deps: str) -> str:
    if "django" in deps:
        return "python3 manage.py runserver 0.0.0.0:$APP_PORT"
    if "fastapi" in deps or "uvicorn" in deps:
        return "python3 -m uvicorn main:app --host 0.0.0.0 --port $APP_PORT"
    if "gunicorn" in deps:
        return "python3 -m gunicorn app:app --bind 0.0.0.0:$APP_PORT"
    if "flask" in deps:
        return "python3 -m flask --app app run --host 0.0.0.0 --port $APP_PORT"
    return "python3 app.py"


def _infer_python_start(base: Path) -> tuple[str, str]:
    procfile = _procfile_web_command(base)
    if procfile:
        return procfile, "Procfile"
    script = _pyproject_console_script(base)
    if script:
        return script, "pyproject.toml"
    entry = _python_entry_file(base)
    if entry is not None:
        return _start_from_python_entry(base, entry), entry.relative_to(base).as_posix()
    return _python_start_from_deps(_python_dependency_blob(base)), "requirements"


def _python_build_command(base: Path, signal: str) -> tuple[str, str]:
    if (base / "requirements.txt").is_file():
        return "python3 -m pip install -r requirements.txt", "requirements.txt"
    if (base / "Pipfile").is_file():
        return "python3 -m pip install pipenv && pipenv install --deploy --system", "Pipfile"
    marker = "pyproject.toml" if (base / "pyproject.toml").is_file() else signal
    return "python3 -m pip install .", marker


def _python_manifest(base: Path, project_name: str, relative_root: str) -> DeploymentManifest:
    start, signal = _infer_python_start(base)
    if not start:
        start = "python3 app.py"
        signal = signal or "python"
    build, marker = _python_build_command(base, signal)
    return _validate_manifest(
        {
            "name": project_name,
            "runtime": "python",
            "build_command": build,
            "start_command": start,
            "strategy": "buildpack",
            "app_root": relative_root,
        },
        origin="detected",
        default_name=project_name,
        signals=(f"{relative_root}/{marker}", f"{relative_root}/{signal}"),
    )


def _language_manifest(runtime: str, base: Path, project_name: str, relative_root: str) -> DeploymentManifest:
    commands = {
        "java": ("mvn -q -DskipTests package" if (base / "pom.xml").is_file() else "./gradlew build -x test", "java -jar target/*.jar" if (base / "pom.xml").is_file() else "java -jar build/libs/*.jar"),
        "go": ("mkdir -p bin && go build -o bin/app .", "./bin/app"),
        "ruby": ("bundle install", "bundle exec rails server -b 0.0.0.0 -p $APP_PORT" if (base / "bin" / "rails").is_file() else "bundle exec puma -b tcp://0.0.0.0:$APP_PORT"),
    }
    build, start = commands[runtime]
    return _validate_manifest(
        {
            "name": project_name,
            "runtime": runtime,
            "build_command": build,
            "start_command": start,
            "strategy": "buildpack",
            "app_root": relative_root,
        },
        origin="detected",
        default_name=project_name,
        signals=(f"{relative_root}/{runtime}",),
    )


def _docker_manifest(root: Path, base: Path, project_name: str, relative_root: str) -> DeploymentManifest | None:
    for filename in DOCKER_COMPOSE_FILENAMES:
        if (base / filename).is_file():
            return _validate_manifest(
                {
                    "name": project_name,
                    "runtime": "docker",
                    "strategy": "docker",
                    "build_command": "compose",
                    "start_command": f"compose:{filename}",
                    "app_root": relative_root,
                }, origin="detected", default_name=project_name, signals=(f"{relative_root}/{filename}",),
            )
    for filename in DOCKERFILE_FILENAMES:
        dockerfile = base / filename
        if not dockerfile.is_file():
            continue
        port_match = re.findall(r"(?im)^\s*EXPOSE\s+(\d{1,5})(?:/tcp)?\b", dockerfile.read_text(encoding="utf-8", errors="replace"))
        port = int(port_match[-1]) if port_match and 1 <= int(port_match[-1]) <= 65535 else None
        return _validate_manifest(
            {
                "name": project_name,
                "runtime": "docker",
                "strategy": "docker",
                "build_command": "docker",
                "start_command": f"dockerfile:{filename}",
                "port": port,
                "app_root": relative_root,
            }, origin="detected", default_name=project_name, signals=(f"{relative_root}/{filename}",),
        )
    return None


def _detect_manifest(root: Path, project_name: str) -> DeploymentManifest:
    app_roots = [(root if rel == "." else root / rel, rel) for rel in APP_ROOT_CANDIDATES]

    # Detection order is a contract: do not reorder without a migration.
    for base, relative_root in app_roots:
        if base.is_dir():
            manifest = _docker_manifest(root, base, project_name, relative_root)
            if manifest is not None:
                return manifest
    workspace = _detect_node_workspace_manifest(root, project_name)
    if workspace is not None:
        return workspace
    for base, relative_root in app_roots:
        if (base / "package.json").is_file():
            manifest = _node_manifest(base, project_name, relative_root)
            if manifest is not None:
                return manifest
    for base, relative_root in app_roots:
        if any((base / filename).is_file() for filename in PYTHON_MARKER_FILES):
            return _python_manifest(base, project_name, relative_root)
    for base, relative_root in app_roots:
        if any((base / filename).is_file() for filename in ("pom.xml", "build.gradle", "build.gradle.kts")):
            return _language_manifest("java", base, project_name, relative_root)
    for base, relative_root in app_roots:
        if (base / "go.mod").is_file():
            return _language_manifest("go", base, project_name, relative_root)
    for base, relative_root in app_roots:
        if (base / "Gemfile").is_file():
            return _language_manifest("ruby", base, project_name, relative_root)

    # A finished static artifact is safe to serve with the certified cloud-init
    # executor.  It is an extension of the documented app-runtime table and is
    # deliberately not a generated placeholder.
    for relative_root in ("dist", "build", "out"):
        base = root / relative_root
        if (base / "index.html").is_file():
            return _validate_manifest(
                {
                    "name": project_name,
                    "runtime": "static",
                    "strategy": "cloud_init",
                    "port": 80,
                    "health_check_path": "/",
                    "app_root": relative_root,
                }, origin="detected", default_name=project_name, signals=(f"{relative_root}/index.html",),
            )
    raise ManifestResolutionError("no Dockerfile, package.json, Python, Java, Go, Ruby, or finished static artifact was found", source_root=root)


def resolve_deployment_manifest(root: Path, project_name: str) -> tuple[DeploymentManifest, bool, str]:
    """Resolve a user manifest or deterministic detection result.

    Returns ``(manifest, cache_hit, fingerprint)``.  No model, shell command,
    or repository execution is involved in this function.
    """
    root = root.resolve()
    if not root.is_dir():
        raise ManifestResolutionError("repository root is not a readable directory", source_root=root)
    fingerprint = manifest_fingerprint(root)
    cached = _load_cached_manifest(fingerprint, project_name)
    if cached is not None:
        return cached, True, fingerprint

    for filename in MANIFEST_FILENAMES:
        candidate = root / filename
        if candidate.is_file():
            manifest = _read_yaml_manifest(candidate, project_name)
            _store_manifest(fingerprint, manifest)
            return manifest, False, fingerprint

    manifest = _detect_manifest(root, project_name)
    _store_manifest(fingerprint, manifest)
    return manifest, False, fingerprint
