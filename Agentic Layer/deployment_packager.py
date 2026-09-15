from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import tarfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from deployment_manifest import DATASTORE_PORTS, ManifestResolutionError, resolve_deployment_manifest


IGNORED_DIRS = {
    ".git",
    ".next",
    ".terraform",
    ".venv",
    "venv",
    "__pycache__",
    "node_modules",
    "coverage",
    ".cache",
    ".pytest_cache",
}

STATIC_DIR_CANDIDATES = (
    "dist",
    "build",
    "out",
    # Note: do not treat source "public/" as a finished static site — CRA/Vite keep
    # unbuilt assets there while package.json still owns build/start.
    "frontend/dist",
    "frontend/build",
    "frontend/out",
    "web/dist",
    "web/build",
    "client/dist",
    "client/build",
)

NODE_APP_DIR_CANDIDATES = (
    ".",
    "frontend",
    "web",
    "client",
    "app",
)

DOCKER_COMPOSE_CANDIDATES = (
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
    "backend/docker-compose.yml",
    "backend/docker-compose.yaml",
)

DOCKERFILE_CANDIDATES = (
    "Dockerfile",
    "dockerfile",
    "backend/Dockerfile",
    "frontend/Dockerfile",
    "app/Dockerfile",
    "server/Dockerfile",
)

MAX_PACKAGE_BYTES = int(os.getenv("DEPLAI_APP_PACKAGE_MAX_BYTES", "8000000"))
MAX_PACKAGE_FILES = int(os.getenv("DEPLAI_APP_PACKAGE_MAX_FILES", "2500"))
PACKAGE_STORE_ROOT = Path(__file__).resolve().parent / ".deplai_runtime" / "deployment_packages"


# ORM / database-client packages in package.json that indicate a DB is needed.
_DB_NPM_PACKAGES = {
    "prisma", "@prisma/client",
    "typeorm", "sequelize", "sequelize-typescript",
    "pg", "pg-native", "mysql", "mysql2", "mariadb",
    "mongoose", "mongodb",
    "knex", "objection",
    "drizzle-orm",
}


@dataclass
class DatabaseRequirements:
    """Result of scanning a repository for database dependencies."""
    enabled: bool
    engine: str  # 'postgres', 'mysql', 'mariadb', or ''
    has_prisma: bool
    has_migrations: bool
    detection_sources: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "engine": self.engine,
            "has_prisma": self.has_prisma,
            "has_migrations": self.has_migrations,
            "detection_sources": self.detection_sources,
        }


@dataclass
class DeploymentPackage:
    package_id: str
    source_root: str
    app_kind: str
    app_port: int
    health_path: str
    build_command: str
    start_command: str
    package_base64: str
    package_file_count: int
    package_bytes: int
    selected_root: str
    package_tarball_path: str
    manifest_path: str
    warnings: list[str]
    db_requirements: DatabaseRequirements = field(
        default_factory=lambda: DatabaseRequirements(
            enabled=False, engine="", has_prisma=False, has_migrations=False
        )
    )
    strategy: str = "cloud_init"
    environment: list[str] = field(default_factory=list)
    deployment_manifest: dict[str, Any] = field(default_factory=dict)
    manifest_cache_hit: bool = False
    manifest_fingerprint: str = ""

    def as_manifest(self) -> dict[str, Any]:
        return {
            "package_id": self.package_id,
            "source_root": self.source_root,
            "app_kind": self.app_kind,
            "app_port": self.app_port,
            "health_path": self.health_path,
            "build_command": self.build_command,
            "start_command": self.start_command,
            "strategy": self.strategy,
            "environment": list(self.environment),
            "package_file_count": self.package_file_count,
            "package_bytes": self.package_bytes,
            "selected_root": self.selected_root,
            "package_tarball_path": self.package_tarball_path,
            "manifest_path": self.manifest_path,
            "warnings": self.warnings,
            "db_requirements": self.db_requirements.as_dict(),
            "deployment_manifest": self.deployment_manifest,
            "manifest_cache_hit": self.manifest_cache_hit,
            "manifest_fingerprint": self.manifest_fingerprint,
        }


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _records(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _safe_slug(value: str) -> str:
    slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in str(value or ""))
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug.strip("-")[:48] or "deplai-app"


def _is_ignored(path: Path) -> bool:
    return any(part in IGNORED_DIRS for part in path.parts)


def _has_file(root: Path, *names: str) -> bool:
    return any((root / name).exists() for name in names)


def _find_file(root: Path, *names: str) -> Path | None:
    """Return first existing file matching any of the given relative paths."""
    for name in names:
        candidate = root / name
        if candidate.exists() and candidate.is_file():
            return candidate
    return None


def _read_text_safe(path: Path | None) -> str:
    if path is None or not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""


def detect_database_requirements(root: Path) -> DatabaseRequirements:
    """Scan a repository root and determine whether it needs a database.

    Detection signals (in order of reliability):
    1. ``prisma/schema.prisma`` — definitive: engine read from datasource block.
    2. ``docker-compose.yml`` / ``docker-compose.yaml`` — postgres/mysql image.
    3. ``package.json`` dependencies/devDependencies — ORM/DB client packages.
    4. Loose ``.env`` or ``.env.example`` containing DATABASE_URL.
    """
    enabled = False
    engine = ""
    has_prisma = False
    has_migrations = False
    sources: list[str] = []

    # ── 1. Prisma schema ──────────────────────────────────────────────────────
    # Search across common subdirs (backend, server, api, src, root)
    prisma_candidates = [
        root / "prisma" / "schema.prisma",
        root / "backend" / "prisma" / "schema.prisma",
        root / "server" / "prisma" / "schema.prisma",
        root / "api" / "prisma" / "schema.prisma",
        root / "src" / "prisma" / "schema.prisma",
    ]
    prisma_schema: Path | None = None
    for candidate in prisma_candidates:
        if candidate.exists() and candidate.is_file():
            prisma_schema = candidate
            break

    if prisma_schema is None:
        # Glob fallback for deeply-nested monorepos
        found = list(root.rglob("prisma/schema.prisma"))
        if found:
            prisma_schema = found[0]

    if prisma_schema is not None:
        has_prisma = True
        enabled = True
        sources.append(f"prisma/schema.prisma ({prisma_schema.relative_to(root).as_posix()})")
        schema_text = _read_text_safe(prisma_schema)
        # Extract provider from: provider = "postgresql" / "mysql" / "sqlite"
        provider_match = re.search(
            r'datasource\s+\w+\s*\{[^}]*provider\s*=\s*"([^"]+)"',
            schema_text,
            re.DOTALL,
        )
        if provider_match:
            raw_engine = provider_match.group(1).lower().strip()
            if raw_engine in {"postgresql", "postgres"}:
                engine = "postgres"
            elif raw_engine in {"mysql", "mariadb"}:
                engine = raw_engine
            elif raw_engine == "sqlite":
                # SQLite doesn't need RDS – treat as no external DB
                enabled = False
                has_prisma = True  # keep flag so migration step knows to run
                sources.append("prisma engine=sqlite → RDS not needed")
        else:
            engine = "postgres"  # Sensible default when provider not parseable

        # Check for migrations directory next to schema.prisma
        migrations_dir = prisma_schema.parent / "migrations"
        if migrations_dir.is_dir() and any(migrations_dir.iterdir()):
            has_migrations = True

    # ── 2. docker-compose ────────────────────────────────────────────────────
    if not enabled:
        compose_paths = [
            root / "docker-compose.yml",
            root / "docker-compose.yaml",
            root / "backend" / "docker-compose.yml",
            root / "backend" / "docker-compose.yaml",
        ]
        for compose_path in compose_paths:
            text = _read_text_safe(compose_path)
            if not text:
                continue
            if re.search(r'image:\s*postgres', text, re.IGNORECASE):
                enabled = True
                engine = engine or "postgres"
                sources.append(f"docker-compose postgres image ({compose_path.relative_to(root).as_posix()})")
                break
            if re.search(r'image:\s*mysql', text, re.IGNORECASE):
                enabled = True
                engine = engine or "mysql"
                sources.append(f"docker-compose mysql image ({compose_path.relative_to(root).as_posix()})")
                break
            if re.search(r'image:\s*mariadb', text, re.IGNORECASE):
                enabled = True
                engine = engine or "mariadb"
                sources.append(f"docker-compose mariadb image ({compose_path.relative_to(root).as_posix()})")
                break

    # ── 3. package.json ORM dependencies ────────────────────────────────────
    if not enabled:
        pkg_candidates = [
            root / "package.json",
            root / "backend" / "package.json",
            root / "server" / "package.json",
            root / "api" / "package.json",
        ]
        for pkg_path in pkg_candidates:
            text = _read_text_safe(pkg_path)
            if not text:
                continue
            try:
                pkg = json.loads(text)
            except Exception:
                continue
            if not isinstance(pkg, dict):
                continue
            all_deps: set[str] = set()
            for dep_key in ("dependencies", "devDependencies", "peerDependencies"):
                deps = pkg.get(dep_key)
                if isinstance(deps, dict):
                    all_deps.update(deps.keys())
            matched = all_deps & _DB_NPM_PACKAGES
            if matched:
                prisma_only = matched.issubset({"prisma", "@prisma/client"})
                if prisma_only:
                    # Prisma is an ORM — only require RDS when a concrete DB client is present.
                    has_prisma = True
                    if "pg" in matched or "pg-native" in matched or "@prisma/adapter-pg" in matched:
                        enabled = True
                        engine = engine or "postgres"
                else:
                    enabled = True
                    if not engine:
                        if "mysql" in matched or "mysql2" in matched:
                            engine = "mysql"
                        elif "mariadb" in matched:
                            engine = "mariadb"
                        elif "pg" in matched or "pg-native" in matched or "@prisma/adapter-pg" in matched:
                            engine = "postgres"
                        elif "prisma" in matched or "@prisma/client" in matched:
                            engine = "postgres"
                        else:
                            engine = "postgres"
                if enabled or prisma_only:
                    sources.append(
                        f"package.json deps: {', '.join(sorted(matched))} "
                        f"({pkg_path.relative_to(root).as_posix()})"
                    )
                if enabled:
                    break

    # ── 4. .env / .env.example containing DATABASE_URL ──────────────────────
    if not enabled:
        env_candidates = [
            root / ".env.example",
            root / ".env.sample",
            root / "backend" / ".env.example",
            root / "backend" / ".env.sample",
        ]
        for env_path in env_candidates:
            text = _read_text_safe(env_path)
            if re.search(r'DATABASE_URL\s*=', text):
                enabled = True
                if not engine:
                    if "postgresql" in text or "postgres" in text:
                        engine = "postgres"
                    elif "mysql" in text:
                        engine = "mysql"
                    else:
                        engine = "postgres"
                sources.append(f"DATABASE_URL in {env_path.relative_to(root).as_posix()}")
                break

    return DatabaseRequirements(
        enabled=enabled,
        engine=engine or ("postgres" if enabled else ""),
        has_prisma=has_prisma,
        has_migrations=has_migrations,
        detection_sources=sources,
    )


def _read_package_json(root: Path) -> dict[str, Any]:
    path = root / "package.json"
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _script_command(package_json: dict[str, Any], name: str) -> str:
    scripts = _record(package_json.get("scripts"))
    if isinstance(scripts.get(name), str) and str(scripts.get(name)).strip():
        return f"npm run {name}"
    return ""


_APP_PORT_KEYS = frozenset({
    "app_port",
    "http_port",
    "listen_port",
    "target_port",
    "container_port",
    "web_port",
    "port",
})
_DATASTORE_PORT_KEY_TOKENS = (
    "rds",
    "db_",
    "_db",
    "database",
    "postgres",
    "mysql",
    "mariadb",
    "redis",
    "cache",
    "mongo",
    "smtp",
)


def _coerce_http_port(value: Any) -> int | None:
    try:
        port = int(value)
    except (TypeError, ValueError):
        return None
    if not 1 <= port <= 65535 or port in DATASTORE_PORTS:
        return None
    return port


def _looks_like_http_app_port_key(key: str) -> bool:
    lowered = str(key).strip().lower()
    if "port" not in lowered:
        return False
    if any(token in lowered for token in _DATASTORE_PORT_KEY_TOKENS):
        return False
    return lowered in _APP_PORT_KEYS or lowered.endswith("_app_port")


def _infer_port(repository_context: dict[str, Any], deployment_profile: dict[str, Any], user_answers: dict[str, Any]) -> int:
    for key, value in (user_answers or {}).items():
        if not _looks_like_http_app_port_key(str(key)):
            continue
        port = _coerce_http_port(value)
        if port is not None:
            return port

    compute = _record(deployment_profile.get("compute"))
    for service in _records(compute.get("services")):
        process = str(service.get("process_type") or "").strip().lower()
        if process and process not in {"web", "http", "api"}:
            continue
        port = _coerce_http_port(service.get("port"))
        if port is not None:
            return port

    build = _record(repository_context.get("build"))
    port = _coerce_http_port(build.get("dockerfile_port"))
    if port is not None:
        return port
    return 3000


def _infer_health_path(repository_context: dict[str, Any], deployment_profile: dict[str, Any]) -> str:
    health = _record(repository_context.get("health"))
    operational = _record(deployment_profile.get("operational"))
    for value in (health.get("endpoint"), operational.get("health_check_path")):
        path = str(value or "").strip()
        if path:
            return path if path.startswith("/") else f"/{path}"
    return "/"


def _dockerfile_exposed_port(dockerfile: Path) -> int | None:
    text = _read_text_safe(dockerfile)
    # Prefer the last EXPOSE directive; ignore protocol suffix (e.g. 8080/tcp).
    matches = re.findall(r"(?im)^\s*EXPOSE\s+(\d{2,5})\b", text)
    for raw in reversed(matches):
        try:
            port = int(raw)
            if 1 <= port <= 65535:
                return port
        except Exception:
            continue
    return None


def _detect_docker_deploy(root: Path) -> dict[str, str] | None:
    """Return docker deploy metadata when compose or Dockerfile is present.

    Prefer compose when both exist — that is usually the intended full-stack
    runtime for repos that ship images.
    """
    for rel in DOCKER_COMPOSE_CANDIDATES:
        compose_path = root / rel
        if compose_path.is_file():
            selected = compose_path.parent
            selected_root = selected.relative_to(root).as_posix() if selected != root else "."
            return {
                "mode": "compose",
                "compose_file": compose_path.name,
                "dockerfile": "",
                "selected_root": selected_root,
                "context_root": str(selected),
            }

    for rel in DOCKERFILE_CANDIDATES:
        dockerfile = root / rel
        if dockerfile.is_file():
            selected = dockerfile.parent
            selected_root = selected.relative_to(root).as_posix() if selected != root else "."
            return {
                "mode": "dockerfile",
                "compose_file": "",
                "dockerfile": dockerfile.name,
                "selected_root": selected_root,
                "context_root": str(selected),
            }
    return None


def _tar_directory(root: Path, arc_root: str = ".") -> tuple[str, int, int]:
    files: list[Path] = []
    for path in sorted(root.rglob("*")):
        if _is_ignored(path.relative_to(root)):
            continue
        if not path.is_file() or path.is_symlink():
            continue
        files.append(path)
        if len(files) > MAX_PACKAGE_FILES:
            raise ValueError(f"deployment package has too many files (>{MAX_PACKAGE_FILES})")

    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for path in files:
            rel = path.relative_to(root).as_posix()
            archive.add(path, arcname=f"{arc_root.rstrip('/')}/{rel}" if arc_root != "." else rel)

    payload = buffer.getvalue()
    if len(payload) > MAX_PACKAGE_BYTES:
        raise ValueError(f"deployment package exceeds {MAX_PACKAGE_BYTES} compressed bytes")
    return base64.b64encode(payload).decode("ascii"), len(files), len(payload)


def _tar_generated_files(files: dict[str, str]) -> tuple[str, int, int]:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for rel_path, content in sorted(files.items()):
            payload = content.encode("utf-8")
            info = tarfile.TarInfo(name=rel_path)
            info.size = len(payload)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(payload))

    payload = buffer.getvalue()
    if len(payload) > MAX_PACKAGE_BYTES:
        raise ValueError(f"deployment package exceeds {MAX_PACKAGE_BYTES} compressed bytes")
    return base64.b64encode(payload).decode("ascii"), len(files), len(payload)


def _persist_package(package: DeploymentPackage) -> DeploymentPackage:
    package_dir = PACKAGE_STORE_ROOT / package.package_id
    package_dir.mkdir(parents=True, exist_ok=True)
    tarball_path = package_dir / "app.tgz"
    manifest_path = package_dir / "deployment_package_manifest.json"
    tarball_path.write_bytes(base64.b64decode(package.package_base64.encode("ascii")))
    package.package_tarball_path = str(tarball_path)
    package.manifest_path = str(manifest_path)
    manifest_path.write_text(json.dumps(package.as_manifest(), indent=2, sort_keys=True), encoding="utf-8")
    return package


def load_persisted_app_tarball(
    *,
    package_id: str = "",
    project_slug: str = "",
) -> tuple[str, bytes] | None:
    """Load app.tgz from the local package store for Terraform S3 delivery."""
    store = PACKAGE_STORE_ROOT
    wanted = str(package_id or "").strip()
    if wanted:
        path = store / wanted / "app.tgz"
        if path.is_file():
            return wanted, path.read_bytes()
    slug = re.sub(r"[^a-z0-9]+", "-", str(project_slug or "").lower()).strip("-")
    if not slug or not store.is_dir():
        return None
    matches = sorted(
        store.glob(f"{slug}*/app.tgz"),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    if not matches:
        return None
    latest = matches[0]
    return latest.parent.name, latest.read_bytes()


def bundle_has_app_artifact_tarball(files: list[dict[str, Any]]) -> bool:
    return any(
        str(item.get("path", "")).replace("\\", "/").rstrip("/").endswith("artifacts/app.tgz")
        for item in files
    )


def terraform_bundle_expects_s3_app_delivery(files: list[dict[str, Any]]) -> bool:
    chunks: list[str] = []
    for item in files:
        path = str(item.get("path", "")).replace("\\", "/").lower()
        if not path.endswith(".tf"):
            continue
        content = item.get("content", "")
        if str(item.get("encoding") or "").strip().lower() == "base64":
            try:
                chunks.append(base64.b64decode(str(content).encode("ascii"), validate=True).decode("utf-8", errors="replace"))
            except Exception:
                continue
        else:
            chunks.append(str(content))
    text = "\n".join(chunks)
    return "aws_s3_object" in text and "app.tgz" in text


def attach_app_artifact_to_tf_files(
    files: list[dict[str, Any]],
    *,
    package_id: str = "",
    project_slug: str = "",
    package_base64: str = "",
) -> list[dict[str, Any]]:
    """Ensure terraform/artifacts/app.tgz exists in a Terraform file bundle for S3 delivery."""
    if bundle_has_app_artifact_tarball(files):
        return files

    payload: bytes | None = None
    encoded = str(package_base64 or "").strip()
    if encoded:
        try:
            payload = base64.b64decode(encoded.encode("ascii"), validate=True)
        except Exception:
            payload = None

    if payload is None:
        loaded = load_persisted_app_tarball(package_id=package_id, project_slug=project_slug)
        if loaded:
            _, payload = loaded

    if not payload:
        return files

    updated = list(files)
    updated.append(
        {
            "path": "terraform/artifacts/app.tgz",
            "content": base64.b64encode(payload).decode("ascii"),
            "encoding": "base64",
        }
    )
    return updated


def _select_static_root(source_root: Path) -> Path | None:
    for rel in STATIC_DIR_CANDIDATES:
        candidate = source_root / rel
        if not candidate.is_dir():
            continue
        if (candidate / "index.html").exists() or any(candidate.glob("*.html")):
            return candidate
    if (source_root / "index.html").exists():
        return source_root
    return None


def _generated_fallback_html(project_name: str, root: Path, repo_context: dict[str, Any]) -> str:
    summary = str(repo_context.get("summary") or "").strip()
    runtime = str(_record(repo_context.get("language")).get("runtime") or "unknown").strip() or "unknown"
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{project_name} deployment</title>
    <style>
      body {{ margin: 0; font-family: Arial, sans-serif; background: #050505; color: #f4f4f5; }}
      main {{ max-width: 760px; margin: 0 auto; padding: 48px 24px; }}
      code {{ color: #67e8f9; }}
      .panel {{ border: 1px solid #27272a; border-radius: 8px; padding: 20px; background: #0a0a0a; }}
    </style>
  </head>
  <body>
    <main>
      <h1>{project_name} infrastructure is live</h1>
      <div class="panel">
        <p>DeplAI created AWS infrastructure successfully, but the repository did not expose a deployable app artifact.</p>
        <p>Detected runtime: <code>{runtime}</code></p>
        <p>Repository root: <code>{root.as_posix()}</code></p>
        <p>{summary or "Add a static build output, package.json start script, or Python entrypoint to deploy the application itself."}</p>
      </div>
    </main>
  </body>
</html>
"""


def _source_root_candidates(source_root: str) -> list[Path]:
    raw = str(source_root or "").strip()
    candidates: list[Path] = []
    if raw:
        candidates.append(Path(raw).expanduser())

    normalized = raw.replace("\\", "/")
    github_mount = Path(os.getenv("DEPLAI_GITHUB_REPOS_ROOT") or "/repos")
    local_mount = Path(os.getenv("DEPLAI_LOCAL_PROJECTS_ROOT") or "/local-projects")
    markers = (
        ("/Connector/tmp/repos/", github_mount),
        ("/Connector/tmp/local-projects/", local_mount),
        ("Connector/tmp/repos/", github_mount),
        ("Connector/tmp/local-projects/", local_mount),
        ("/app/tmp/repos/", github_mount),
        ("/app/tmp/local-projects/", local_mount),
    )
    for marker, mount_root in markers:
        if marker not in normalized:
            continue
        suffix = normalized.split(marker, 1)[1].strip("/")
        if suffix:
            candidates.append(mount_root / suffix)

    deduped: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate.resolve(strict=False))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(candidate)
    return deduped


def _build_deterministic_package(
    *,
    source_root: str,
    source_roots: list[str] | tuple[str, ...] | None,
    project_name: str,
    repository_context: dict[str, Any] | None,
    deployment_profile: dict[str, Any] | None,
    user_answers: dict[str, Any] | None,
) -> DeploymentPackage:
    """Build an archive from exactly one resolved, certified deployment manifest."""
    attempted: list[str] = []
    root: Path | None = None
    for candidate_input in [source_root, *(source_roots or [])]:
        for candidate in _source_root_candidates(candidate_input):
            resolved = candidate.resolve(strict=False)
            attempted.append(str(resolved))
            if resolved.is_dir():
                root = resolved
                break
        if root is not None:
            break
    if root is None:
        detail = f" Attempted: {', '.join(attempted)}" if attempted else ""
        raise ManifestResolutionError(f"repository source is not readable.{detail}")

    repo_context = repository_context or {}
    profile = deployment_profile or {}
    answers = user_answers or {}
    # User-supplied build/start command override (e.g. "vercel build" style).
    # We mutate repo_context so the manifest resolver and downstream EC2 user-data
    # pick up the user choice without breaking the existing data flow.
    user_build_command = (
        str(answers.get("build_command_override") or "").strip()
        or str(answers.get("build_command") or "").strip()
        or None
    )
    user_start_command = (
        str(answers.get("start_command_override") or "").strip()
        or str(answers.get("start_command") or "").strip()
        or None
    )
    if user_build_command or user_start_command:
        build_section = _record((repo_context.get("build")))
        if user_build_command:
            build_section["build_command"] = user_build_command
        if user_start_command:
            build_section["start_command"] = user_start_command
        repo_context = {**repo_context, "build": build_section}
    manifest, cache_hit, fingerprint = resolve_deployment_manifest(root, project_name)
    selected_root = (root / manifest.app_root).resolve()
    try:
        selected_root.relative_to(root)
    except ValueError as exc:
        raise ManifestResolutionError("manifest app_root escapes the repository", source_root=root) from exc
    if not selected_root.is_dir():
        raise ManifestResolutionError(f"manifest app_root {manifest.app_root!r} is not a directory", source_root=root)

    app_port = int(manifest.port or _infer_port(repo_context, profile, answers))
    if manifest.runtime == "static" and manifest.port is None:
        app_port = 80
    health_path = (
        manifest.health_check_path
        if manifest.is_user_supplied
        else _infer_health_path(repo_context, profile)
    )
    warnings: list[str] = []
    if cache_hit:
        warnings.append("Deployment manifest cache hit; repository stack detection was skipped.")
    elif manifest.is_user_supplied:
        warnings.append("Validated user-supplied deplai.yaml; no repository stack guessing was used.")
    else:
        warnings.append("Generated a deterministic deployment manifest from certified repository signals.")

    db_requirements = detect_database_requirements(root)
    if db_requirements.enabled and db_requirements.detection_sources:
        warnings.append(
            f"Database detected ({db_requirements.engine}): "
            + "; ".join(db_requirements.detection_sources)
            + ". RDS will be provisioned automatically."
        )

    if manifest.runtime == "docker":
        dockerfile = next((selected_root / name for name in DOCKERFILE_CANDIDATES if (selected_root / name).is_file()), None)
        compose = next((selected_root / name for name in DOCKER_COMPOSE_CANDIDATES if (selected_root / name).is_file()), None)
        if dockerfile is None and compose is None:
            raise ManifestResolutionError("runtime docker requires a Dockerfile or Compose file in app_root", source_root=root)
        if manifest.port is None and dockerfile is not None:
            exposed = _dockerfile_exposed_port(dockerfile)
            if exposed is not None:
                app_port = exposed
        warnings.append("Certified Docker executor selected; no application commands are generated at deploy time.")
    elif manifest.strategy == "buildpack":
        warnings.append("Certified Paketo buildpack executor selected from the manifest registry.")
    elif manifest.runtime == "static":
        if not (selected_root / "index.html").is_file():
            raise ManifestResolutionError("static app_root must contain index.html", source_root=root)
        warnings.append("Certified cloud-init static-site executor selected.")
    else:
        warnings.append("Certified cloud-init runtime executor selected from the manifest registry.")

    package_base64, file_count, byte_count = _tar_directory(selected_root)
    package = DeploymentPackage(
        package_id=f"{_safe_slug(project_name)}-{fingerprint[:12]}",
        source_root=str(root),
        app_kind=manifest.runtime,
        app_port=app_port,
        health_path=health_path,
        build_command=manifest.build_command,
        start_command=manifest.start_command,
        package_base64=package_base64,
        package_file_count=file_count,
        package_bytes=byte_count,
        selected_root=manifest.app_root,
        package_tarball_path="",
        manifest_path="",
        warnings=warnings,
        db_requirements=db_requirements,
        strategy=manifest.strategy,
        environment=list(manifest.env),
        deployment_manifest=manifest.as_dict(),
        manifest_cache_hit=cache_hit,
        manifest_fingerprint=fingerprint,
    )
    return _persist_package(package)


def build_deployment_package(
    *,
    source_root: str,
    source_roots: list[str] | tuple[str, ...] | None = None,
    project_name: str,
    repository_context: dict[str, Any] | None = None,
    deployment_profile: dict[str, Any] | None = None,
    user_answers: dict[str, Any] | None = None,
) -> DeploymentPackage:
    """Resolve and package an app without any model or terminal fallback."""
    return _build_deterministic_package(
        source_root=source_root,
        source_roots=source_roots,
        project_name=project_name,
        repository_context=repository_context,
        deployment_profile=deployment_profile,
        user_answers=user_answers,
    )

    # Kept below temporarily for compatibility with downstream patch sets. It
    # is intentionally unreachable: placeholder generation is prohibited.
    attempted: list[str] = []
    root: Path | None = None
    candidate_inputs = [source_root, *(source_roots or [])]
    candidates: list[Path] = []
    for candidate_input in candidate_inputs:
        candidates.extend(_source_root_candidates(candidate_input))
    for candidate in candidates:
        resolved = candidate.resolve(strict=False)
        attempted.append(str(resolved))
        if resolved.exists() and resolved.is_dir():
            root = resolved
            break
    if root is None:
        detail = f" Attempted: {', '.join(attempted)}" if attempted else ""
        raise ValueError(f"source_root is required and must point to a readable repository directory.{detail}")

    repo_context = repository_context or {}
    profile = deployment_profile or {}
    answers = user_answers or {}
    warnings: list[str] = []
    app_port = _infer_port(repo_context, profile, answers)
    health_path = _infer_health_path(repo_context, profile)
    digest = hashlib.sha256(str(root).encode("utf-8")).hexdigest()[:12]
    package_id = f"{_safe_slug(project_name)}-{digest}"

    # Detect database requirements by scanning the actual repo files.
    db_requirements = detect_database_requirements(root)
    if db_requirements.enabled and db_requirements.detection_sources:
        warnings.append(
            f"Database detected ({db_requirements.engine}): "
            + "; ".join(db_requirements.detection_sources)
            + ". RDS will be provisioned automatically."
        )

    # Prefer Docker when the repo ships images — install+run on EC2 instead of
    # treating source public/ or package.json as the primary runtime.
    docker_meta = _detect_docker_deploy(root)
    if docker_meta is not None:
        context_root = Path(docker_meta["context_root"])
        package_base64, file_count, byte_count = _tar_directory(context_root)
        docker_port = app_port
        if docker_meta["mode"] == "dockerfile":
            exposed = _dockerfile_exposed_port(context_root / docker_meta["dockerfile"])
            if exposed is not None:
                docker_port = exposed
            warnings.append(
                f"Dockerfile detected ({docker_meta['selected_root']}/{docker_meta['dockerfile']}); "
                "EC2 bootstrap will install Docker, build the image, and run the container."
            )
            build_command = "docker"
            start_command = f"dockerfile:{docker_meta['dockerfile']}"
        else:
            warnings.append(
                f"Docker Compose detected ({docker_meta['selected_root']}/{docker_meta['compose_file']}); "
                "EC2 bootstrap will install Docker and run `docker compose up --build -d`."
            )
            build_command = "compose"
            start_command = f"compose:{docker_meta['compose_file']}"
        return _persist_package(DeploymentPackage(
            package_id=package_id,
            source_root=str(root),
            app_kind="docker",
            app_port=docker_port,
            health_path=health_path,
            build_command=build_command,
            start_command=start_command,
            package_base64=package_base64,
            package_file_count=file_count,
            package_bytes=byte_count,
            selected_root=docker_meta["selected_root"],
            package_tarball_path="",
            manifest_path="",
            warnings=warnings,
            db_requirements=db_requirements,
        ))

    static_root = _select_static_root(root)
    if static_root is not None:
        package_base64, file_count, byte_count = _tar_directory(static_root)
        return _persist_package(DeploymentPackage(
            package_id=package_id,
            source_root=str(root),
            app_kind="static",
            app_port=80,
            health_path="/",
            build_command="",
            start_command="",
            package_base64=package_base64,
            package_file_count=file_count,
            package_bytes=byte_count,
            selected_root=static_root.relative_to(root).as_posix() if static_root != root else ".",
            package_tarball_path="",
            manifest_path="",
            warnings=warnings,
            db_requirements=db_requirements,
        ))

    from runtime_catalog import (
        detect_bootstrappable_recipe,
        get_runtime_recipe,
        infer_commands_for_recipe,
        resolve_package_root,
    )

    recipe = detect_bootstrappable_recipe(root)
    if recipe is not None:
        package_root = resolve_package_root(root, recipe)
        build_command, start_command, recipe_warnings = infer_commands_for_recipe(root, recipe)
        warnings.extend(recipe_warnings)
        skip = recipe.app_kind == "node" and not start_command
        if not skip:
            if not start_command:
                start_command = recipe.default_start_command
                warnings.append(
                    f"{recipe.display_name} detected but no start command could be inferred; "
                    "using catalog default."
                )
            if start_command:
                package_base64, file_count, byte_count = _tar_directory(package_root)
                selected_root = package_root.relative_to(root).as_posix() if package_root != root else "."
                volume_hint = get_runtime_recipe(recipe.app_kind)
                if volume_hint and volume_hint.min_root_volume_gb > 35:
                    warnings.append(
                        f"{recipe.display_name} apps use a larger root volume "
                        f"({volume_hint.min_root_volume_gb}GB) on EC2."
                    )
                return _persist_package(DeploymentPackage(
                    package_id=package_id,
                    source_root=str(root),
                    app_kind=recipe.app_kind,
                    app_port=app_port,
                    health_path=health_path,
                    build_command=build_command,
                    start_command=start_command,
                    package_base64=package_base64,
                    package_file_count=file_count,
                    package_bytes=byte_count,
                    selected_root=selected_root,
                    package_tarball_path="",
                    manifest_path="",
                    warnings=warnings,
                    db_requirements=db_requirements,
                ))

    warnings.append(
        "Repository did not expose static build output, package.json with a start script, "
        "Python/Go/Java/.NET/PHP/Ruby/Rust entrypoints, or Docker artifacts; "
        "generated a static placeholder package so Terraform infrastructure generation can continue."
    )
    package_base64, file_count, byte_count = _tar_generated_files({
        "index.html": _generated_fallback_html(project_name, root, repo_context),
    })
    return _persist_package(DeploymentPackage(
        package_id=f"{package_id}-placeholder",
        source_root=str(root),
        app_kind="static",
        app_port=80,
        health_path="/",
        build_command="",
        start_command="",
        package_base64=package_base64,
        package_file_count=file_count,
        package_bytes=byte_count,
        selected_root="generated-placeholder",
        package_tarball_path="",
        manifest_path="",
        warnings=warnings,
        db_requirements=db_requirements,
    ))
