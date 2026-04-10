from __future__ import annotations

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import yaml

from deployment_planning_contract import (
    BuildInfo,
    ConflictItem,
    DataStoreFinding,
    EnvironmentVariablesInfo,
    FrontendInfo,
    HealthInfo,
    InfrastructureHints,
    LanguageInfo,
    LowConfidenceItem,
    MonitoringInfo,
    ProcessFinding,
    RepositoryContextDocument,
    RepositoryFinding,
)
from planning_runtime import analyzer_context_md_path, analyzer_context_path, runtime_paths_for_workspace, write_json
from repository_sources import resolve_repository_source


SKIP_DIRS = {
    ".git",
    "node_modules",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".terraform",
    "dist",
    "build",
    "coverage",
}
MAX_TEXT_BYTES = 256_000

NODE_FRAMEWORK_MAP: dict[str, tuple[str, str]] = {
    "express": ("express", "http_api_server"),
    "fastify": ("fastify", "http_api_server"),
    "koa": ("koa", "http_api_server"),
    "hapi": ("hapi", "http_api_server"),
    "next": ("nextjs", "ssr_web_framework"),
    "nuxt": ("nuxt", "ssr_web_framework"),
    "remix": ("remix", "ssr_web_framework"),
    "react": ("react", "spa_frontend"),
    "vue": ("vue", "spa_frontend"),
    "svelte": ("svelte", "spa_frontend"),
    "bull": ("bull", "background_worker"),
    "bullmq": ("bullmq", "background_worker"),
    "socket.io": ("socket.io", "websocket_server"),
    "ws": ("ws", "websocket_server"),
    "prisma": ("prisma", "orm"),
    "typeorm": ("typeorm", "orm"),
    "sequelize": ("sequelize", "orm"),
    "mongoose": ("mongoose", "mongodb_orm"),
    "ioredis": ("redis", "redis_client"),
    "redis": ("redis", "redis_client"),
    "amqplib": ("rabbitmq", "queue_client"),
    "kafkajs": ("kafka", "queue_client"),
    "@elastic/elasticsearch": ("elasticsearch", "search_client"),
    "winston": ("winston", "logging"),
    "pino": ("pino", "logging"),
    "prom-client": ("prometheus", "metrics"),
}

PYTHON_FRAMEWORK_MAP: dict[str, tuple[str, str]] = {
    "fastapi": ("fastapi", "http_api_server"),
    "uvicorn": ("uvicorn", "asgi_runtime"),
    "django": ("django", "ssr_web_framework"),
    "flask": ("flask", "http_api_server"),
    "sqlalchemy": ("sqlalchemy", "orm"),
    "psycopg2": ("postgresql", "postgres_client"),
    "redis": ("redis", "redis_client"),
    "celery": ("celery", "background_worker"),
    "alembic": ("alembic", "migration_tool"),
    "structlog": ("structlog", "logging"),
    "prometheus-client": ("prometheus", "metrics"),
}

DATASTORE_HINTS: dict[str, list[str]] = {
    "postgresql": ["postgres", "psycopg2", "prisma", "typeorm", "sequelize", "sqlalchemy", "database_url", "postgresql://"],
    "mysql": ["mysql", "pymysql", "mysql://"],
    "mongodb": ["mongoose", "mongo", "mongodb://"],
    "redis": ["redis", "ioredis", "bull", "rediss://"],
    "rabbitmq": ["amqp", "rabbitmq", "amqplib"],
    "kafka": ["kafka", "kafkajs"],
    "elasticsearch": ["elastic", "elasticsearch"],
}


def _list_files(root: Path) -> list[Path]:
    files: list[Path] = []
    root = root.resolve()
    # Use os.walk with topdown pruning to avoid traversing heavy directories
    # like node_modules or .git, which can cause request timeouts.
    for dirpath, dirnames, filenames in os.walk(root, topdown=True):
        dirnames[:] = [name for name in dirnames if name not in SKIP_DIRS]

        current_dir = Path(dirpath)
        for filename in filenames:
            path = current_dir / filename
            if path.is_file():
                files.append(path)
    return files


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")[:MAX_TEXT_BYTES]
    except UnicodeDecodeError:
        return path.read_text(encoding="latin-1", errors="ignore")[:MAX_TEXT_BYTES]


def _relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _parse_package_json(path: Path) -> dict[str, Any]:
    return json.loads(_read_text(path))


def _parse_pyproject_dependencies(raw: str) -> tuple[list[str], str | None]:
    deps: list[str] = []
    version: str | None = None
    in_project = False
    in_dep_list = False
    for line in raw.splitlines():
        stripped = line.strip()
        if stripped == "[project]":
            in_project = True
            in_dep_list = False
            continue
        if stripped.startswith("[") and stripped != "[project]":
            in_project = False
            in_dep_list = False
        if in_project and stripped.startswith("requires-python"):
            version = stripped.split("=", 1)[-1].strip().strip('"').strip("'")
        if in_project and stripped.startswith("dependencies"):
            in_dep_list = True
            continue
        if in_dep_list:
            if stripped.startswith("]"):
                in_dep_list = False
                continue
            dep = stripped.strip(",").strip().strip('"').strip("'")
            if dep:
                deps.append(dep)
    return deps, version


def _detect_frameworks_from_names(names: set[str], mapping: dict[str, tuple[str, str]], source: str) -> list[RepositoryFinding]:
    findings: list[RepositoryFinding] = []
    for dependency, (name, role) in mapping.items():
        if dependency.lower() in names:
            findings.append(RepositoryFinding(name=name, role=role, confidence="high", source=source))
    return findings


def _dependency_scanner(root: Path, files: list[Path]) -> dict[str, Any]:
    language = LanguageInfo(primary=None, runtime=None, version=None, confidence="low")
    frameworks: list[RepositoryFinding] = []
    build = BuildInfo()
    detected_names: set[str] = set()
    test_frameworks: list[str] = []

    for path in files:
        rel = _relative(path, root)
        name = path.name.lower()
        if name == "package.json":
            payload = _parse_package_json(path)
            deps = payload.get("dependencies") or {}
            dev_deps = payload.get("devDependencies") or {}
            names = {str(key).lower() for key in {**deps, **dev_deps}.keys()}
            detected_names.update(names)
            frameworks.extend(_detect_frameworks_from_names(names, NODE_FRAMEWORK_MAP, rel))
            language = LanguageInfo(
                primary="typescript" if "typescript" in names else "javascript",
                runtime="node",
                version=str(((payload.get("engines") or {}) if isinstance(payload.get("engines"), dict) else {}).get("node") or "") or None,
                confidence="high",
            )
            scripts = payload.get("scripts") if isinstance(payload.get("scripts"), dict) else {}
            build.build_command = str(scripts.get("build") or build.build_command or "") or None
            build.start_command = str(scripts.get("start") or build.start_command or "") or None
            build.test_command = str(scripts.get("test") or build.test_command or "") or None
            if "jest" in names or "vitest" in names:
                test_frameworks.append("node_test_framework")
        elif name == "requirements.txt":
            raw = _read_text(path)
            names = {line.split("==")[0].split(">=")[0].split("[")[0].strip().lower() for line in raw.splitlines() if line.strip() and not line.startswith("#")}
            detected_names.update(names)
            frameworks.extend(_detect_frameworks_from_names(names, PYTHON_FRAMEWORK_MAP, rel))
            language = LanguageInfo(primary="python", runtime="python", version=None, confidence="high")
            if "pytest" in names:
                test_frameworks.append("pytest")
        elif name == "pyproject.toml":
            raw = _read_text(path)
            deps, version = _parse_pyproject_dependencies(raw)
            names = {dep.split(" ")[0].split(">=")[0].split("==")[0].strip().lower() for dep in deps}
            detected_names.update(names)
            frameworks.extend(_detect_frameworks_from_names(names, PYTHON_FRAMEWORK_MAP, rel))
            language = LanguageInfo(primary="python", runtime="python", version=version, confidence="high")

    if not build.test_command and test_frameworks:
        build.test_command = test_frameworks[0]

    return {
        "language": language,
        "frameworks": frameworks,
        "build": build,
        "detected_names": sorted(detected_names),
    }


def _framework_config_scanner(root: Path, files: list[Path]) -> dict[str, Any]:
    frontend = FrontendInfo()
    build = BuildInfo()
    for path in files:
        rel = _relative(path, root)
        name = path.name.lower()
        raw = _read_text(path)
        if name in {"next.config.js", "next.config.ts"}:
            frontend.framework = "nextjs"
            frontend.has_build_step = True
            if "output: 'export'" in raw or 'output: "export"' in raw:
                frontend.static_site_candidate = True
            if "output: 'standalone'" in raw or 'output: "standalone"' in raw:
                frontend.hybrid = True
        elif name in {"vite.config.ts", "vite.config.js"}:
            frontend.framework = "vite"
            frontend.has_build_step = True
            match = re.search(r"outDir\s*:\s*['\"]([^'\"]+)['\"]", raw)
            if match:
                frontend.output_dir = match.group(1)
        elif name == "dockerfile":
            build.has_dockerfile = True
            build.is_multi_stage = raw.lower().count("from ") > 1
            expose = re.search(r"EXPOSE\s+(\d+)", raw, re.IGNORECASE)
            if expose:
                build.dockerfile_port = int(expose.group(1))
            build.runs_as_root = "USER " not in raw.upper()
        elif name == "procfile":
            frontend.hybrid = frontend.hybrid or "web:" in raw.lower()
    return {"frontend": frontend, "build": build}


def _infra_scanner(root: Path, files: list[Path]) -> dict[str, Any]:
    hints = InfrastructureHints()
    build = BuildInfo()
    processes: list[ProcessFinding] = []
    compose_images: list[str] = []
    nested_package_json = 0
    nested_dockerfiles = 0

    for path in files:
        rel = _relative(path, root)
        lower_rel = rel.lower()
        if path.name.lower() == "docker-compose.yml":
            hints.existing_compose = True
            payload = yaml.safe_load(_read_text(path)) or {}
            services = payload.get("services") if isinstance(payload, dict) else {}
            if isinstance(services, dict):
                for service_name, service_value in services.items():
                    service = service_value if isinstance(service_value, dict) else {}
                    image = str(service.get("image") or "").strip()
                    if image:
                        compose_images.append(image)
                    ports = service.get("ports") or []
                    if build.dockerfile_port is None and isinstance(ports, list) and ports:
                        first = str(ports[0])
                        port_match = re.search(r"(\d+)\s*:?(\d+)?", first)
                        if port_match:
                            build.dockerfile_port = int(port_match.group(2) or port_match.group(1))
                    processes.append(ProcessFinding(type="service", source=rel, command=str(service.get("command") or service_name)))
        elif path.name.lower() == "procfile":
            for line in _read_text(path).splitlines():
                if ":" not in line:
                    continue
                proc_type, command = line.split(":", 1)
                processes.append(ProcessFinding(type=proc_type.strip(), source=rel, command=command.strip()))
        elif "kubernetes" in lower_rel or lower_rel.startswith("k8s/"):
            hints.kubernetes_manifests = True
        elif path.name.lower() in {"serverless.yml", "template.yaml"}:
            hints.serverless_config = True
        if rel.count("/") > 0 and path.name.lower() == "package.json":
            nested_package_json += 1
        if rel.count("/") > 0 and path.name.lower() == "dockerfile":
            nested_dockerfiles += 1

    hints.monorepo = nested_package_json > 1 or nested_dockerfiles > 1
    return {"infrastructure_hints": hints, "processes": processes, "compose_images": compose_images, "build": build}


def _env_scanner(root: Path, files: list[Path]) -> dict[str, Any]:
    info = EnvironmentVariablesInfo()
    env_names: set[str] = set()
    candidates = {
        ".env.example",
        ".env.sample",
        ".env.template",
        "env.example",
        ".env.defaults",
        ".env.development.example",
    }
    for path in files:
        rel = _relative(path, root)
        if rel not in candidates:
            continue
        for line in _read_text(path).splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            key = key.strip()
            value = value.strip()
            env_names.add(key)
            lowered = value.lower()
            if not value or lowered in {"changeme", "your-key-here", "xxx", "placeholder"}:
                info.required_secrets.append(key)
            elif "://" in value or key.endswith("_URL") or key.endswith("_URI"):
                info.service_endpoints.append(key)
            elif lowered in {"true", "false"} or re.fullmatch(r"\d+", value):
                info.config_values.append(key)
            else:
                info.config_values.append(key)
    return {"environment_variables": info, "env_names": sorted(env_names)}


def _data_store_scanner(root: Path, files: list[Path], dependency_names: set[str], compose_images: list[str], env_names: set[str]) -> dict[str, Any]:
    signals_by_store: dict[str, list[str]] = {key: [] for key in DATASTORE_HINTS}
    versions: dict[str, str | None] = {key: None for key in DATASTORE_HINTS}
    file_text_cache: list[tuple[str, str]] = [(_relative(path, root), _read_text(path)) for path in files if path.suffix.lower() in {".py", ".js", ".ts", ".tsx", ".yml", ".yaml", ".env", ".toml", ".txt", ".json"}]

    for store, hints in DATASTORE_HINTS.items():
        for dep in dependency_names:
            if any(hint == dep or hint in dep for hint in hints):
                signals_by_store[store].append(f"dependency:{dep}")
        for image in compose_images:
            lowered = image.lower()
            if any(hint in lowered for hint in hints):
                signals_by_store[store].append(f"compose_image:{image}")
                version_match = re.search(r":([\w.\-]+)$", image)
                if version_match:
                    versions[store] = version_match.group(1)
        for env in env_names:
            lowered = env.lower()
            if any(hint.replace("://", "").replace("_", "") in lowered.replace("_", "") for hint in hints):
                signals_by_store[store].append(f"env:{env}")
        for rel, raw in file_text_cache:
            lowered = raw.lower()
            if store == "postgresql" and ("prisma/migrations" in rel or "alembic" in rel or "db/migrate" in rel):
                signals_by_store[store].append(f"migration:{rel}")
            if store == "redis" and "bull" in lowered:
                signals_by_store[store].append(f"queue_signal:{rel}")
            if any(hint in lowered for hint in hints):
                signals_by_store[store].append(f"config:{rel}")

    data_stores: list[DataStoreFinding] = []
    low_confidence_items: list[LowConfidenceItem] = []
    for store, signals in signals_by_store.items():
        normalized = sorted({signal for signal in signals})
        if not normalized:
            continue
        purpose: list[str] = []
        if store == "redis" and any("bull" in signal for signal in normalized):
            purpose = ["queue", "cache"]
        confidence = "high" if len(normalized) >= 2 else "medium"
        data_stores.append(
            DataStoreFinding(
                type=store,
                version=versions.get(store),
                confidence=confidence,
                signals=normalized[:8],
                purpose=purpose,
            )
        )
        if versions.get(store) is None:
            low_confidence_items.append(LowConfidenceItem(field=f"data_stores.{store}.version", reason=f"{store} version not specified anywhere in repo"))
    return {"data_stores": data_stores, "low_confidence_items": low_confidence_items}


def _build_ci_scanner(root: Path, files: list[Path]) -> dict[str, Any]:
    build = BuildInfo()
    for path in files:
        rel = _relative(path, root)
        if rel.startswith(".github/workflows/") and rel.endswith((".yml", ".yaml")):
            build.ci_provider = "github_actions"
        elif rel == ".gitlab-ci.yml":
            build.ci_provider = "gitlab_ci"
        elif path.name.lower() == "buildspec.yml":
            build.ci_provider = "aws_codebuild"
    return {"build": build}


def _health_scanner(root: Path, files: list[Path], dependency_names: set[str]) -> dict[str, Any]:
    health = HealthInfo()
    monitoring = MonitoringInfo()
    if "winston" in dependency_names:
        monitoring.logging = "winston"
    elif "pino" in dependency_names:
        monitoring.logging = "pino"
    elif "structlog" in dependency_names:
        monitoring.logging = "structlog"
    if "prom-client" in dependency_names or "prometheus-client" in dependency_names:
        monitoring.metrics = "prometheus"

    patterns = ["/healthz", "/health", "/ping", "/status"]
    for path in files:
        if path.suffix.lower() not in {".py", ".js", ".ts", ".tsx"}:
            continue
        rel = _relative(path, root)
        raw = _read_text(path)
        lowered = raw.lower()
        for pattern in patterns:
            if pattern in lowered:
                health.endpoint = pattern
                health.confidence = "high"
                health.source = rel
                return {"health": health, "monitoring": monitoring}
    health.endpoint = "/"
    health.confidence = "low"
    health.source = "default"
    return {"health": health, "monitoring": monitoring}


def _frontend_scanner(root: Path, files: list[Path], framework_names: set[str]) -> dict[str, Any]:
    frontend = FrontendInfo()
    entry_candidates: list[str] = []
    for candidate in ["index.html", "public/index.html", "dist/index.html", "build/index.html", "src/index.html"]:
        if (root / candidate).exists():
            entry_candidates.append(candidate)
    frontend.entry_candidates = entry_candidates
    frontend.has_build_step = bool(entry_candidates or "react" in framework_names or "vite" in framework_names or "nextjs" in framework_names)
    frontend.static_site_candidate = bool(entry_candidates and not {"express", "fastapi", "django", "flask", "nextjs"} & framework_names)
    frontend.hybrid = bool(frontend.static_site_candidate and {"express", "fastapi", "django", "flask", "nextjs"} & framework_names)
    if frontend.static_site_candidate and not frontend.output_dir:
        for output_dir in ["dist", "build", "out", "public"]:
            if (root / output_dir).exists():
                frontend.output_dir = output_dir
                break
    return {"frontend": frontend}


def _docs_scanner(root: Path, files: list[Path]) -> dict[str, Any]:
    notes: list[str] = []
    for candidate in ["README.md", "DEPLOY.md", "DEPLOYMENT.md", "docs/deployment.md", "docs/deploy.md", "CONTRIBUTING.md"]:
        path = root / candidate
        if not path.exists() or not path.is_file():
            continue
        raw = _read_text(path)
        ram_match = re.search(r"(\d+)\s*MB\s+(?:RAM|memory)", raw, re.IGNORECASE)
        if ram_match:
            notes.append(f"README mentions the app requires a minimum of {ram_match.group(1)}MB RAM per process")
        port_match = re.search(r"port\s+(\d{2,5})", raw, re.IGNORECASE)
        if port_match:
            notes.append(f"Documentation references port {port_match.group(1)}")
    return {"readme_notes": ". ".join(notes) if notes else None}


def _merge_build_infos(builds: list[BuildInfo]) -> BuildInfo:
    merged = BuildInfo()
    for build in builds:
        for field in build.model_fields:
            value = getattr(build, field)
            if value not in (None, False, ""):
                setattr(merged, field, value)
    return merged


def _summarize_context(context: RepositoryContextDocument) -> str:
    parts: list[str] = []
    if context.language.runtime:
        parts.append(f"Runtime: {context.language.runtime}")
    if context.language.version:
        parts.append(f"Version: {context.language.version}")
    if context.frameworks:
        parts.append("Frameworks: " + ", ".join(sorted({item.name for item in context.frameworks})))
    if context.data_stores:
        parts.append("Data stores: " + ", ".join(sorted({item.type for item in context.data_stores})))
    return " | ".join(parts)


def _context_markdown(context: RepositoryContextDocument) -> str:
    framework_lines = "\n".join(f"- **{item.name}** ({item.role}, {item.confidence})" for item in context.frameworks) or "- None detected"
    datastore_lines = "\n".join(
        f"- **{item.type}** ({item.confidence}) — {', '.join(item.signals)}"
        for item in context.data_stores
    ) or "- None detected"
    process_lines = "\n".join(f"- `{item.type}` — {item.command or item.source}" for item in context.processes) or "- No explicit processes detected"
    flags = [f"- {item.reason}" for item in context.low_confidence_items] + [f"- {item.reason}" for item in context.conflicts]
    flag_lines = "\n".join(flags) or "- No major flags"
    return f"""# Repository Analysis — {context.project_name}

## Detected Stack
- **Language:** {context.language.primary or 'unknown'} / {context.language.runtime or 'unknown'} {context.language.version or ''}
- **Build:** {context.build.build_command or 'not found'}
- **Start:** {context.build.start_command or 'not found'}
- **Dockerfile:** {'yes' if context.build.has_dockerfile else 'no'}

## Frameworks
{framework_lines}

## Data Stores
{datastore_lines}

## Processes
{process_lines}

## Required Secrets
{', '.join(context.environment_variables.required_secrets) or 'None detected'}

## Health Check
{context.health.endpoint or 'None detected'} ({context.health.confidence})

## Flags
{flag_lines}
"""


def run_repository_analysis(*, project_id: str, project_name: str, project_type: str, workspace: str, user_id: str | None = None, repo_full_name: str | None = None) -> tuple[RepositoryContextDocument, str, dict[str, str]]:
    source_root = resolve_repository_source(project_id=project_id, project_type=project_type, user_id=user_id, repo_full_name=repo_full_name)
    files = _list_files(source_root)

    with ThreadPoolExecutor(max_workers=8) as executor:
        dep_future = executor.submit(_dependency_scanner, source_root, files)
        cfg_future = executor.submit(_framework_config_scanner, source_root, files)
        infra_future = executor.submit(_infra_scanner, source_root, files)
        env_future = executor.submit(_env_scanner, source_root, files)

        dep_result = dep_future.result()
        infra_result = infra_future.result()
        env_result = env_future.result()
        cfg_result = cfg_future.result()

        dependency_names = set(dep_result.get("detected_names") or [])
        framework_names = {finding.name for finding in dep_result.get("frameworks") or []}

        data_result = executor.submit(
            _data_store_scanner,
            source_root,
            files,
            dependency_names,
            infra_result.get("compose_images") or [],
            set(env_result.get("env_names") or []),
        ).result()
        ci_result = executor.submit(_build_ci_scanner, source_root, files).result()
        health_result = executor.submit(_health_scanner, source_root, files, dependency_names).result()
        frontend_result = executor.submit(_frontend_scanner, source_root, files, framework_names).result()
        docs_result = executor.submit(_docs_scanner, source_root, files).result()

    conflicts: list[ConflictItem] = []
    data_stores = data_result.get("data_stores") or []
    if any(item.type == "postgresql" for item in data_stores) and any(item.type == "mysql" for item in data_stores):
        conflicts.append(ConflictItem(field="data_stores", reason="Both PostgreSQL and MySQL signals were detected", signals=["postgresql", "mysql"]))

    low_confidence_items = list(data_result.get("low_confidence_items") or [])
    if not (env_result.get("env_names") or []):
        low_confidence_items.append(LowConfidenceItem(field="environment_variables", reason="No .env.example-style template found. Required secrets list may be incomplete"))
    if not health_result["health"].endpoint:
        low_confidence_items.append(LowConfidenceItem(field="health.endpoint", reason="No health check route detected; defaulting to '/'"))

    context = RepositoryContextDocument(
        project_root=str(source_root),
        workspace=workspace,
        project_name=project_name,
        project_type=project_type,
        language=dep_result["language"],
        frameworks=dep_result.get("frameworks") or [],
        build=_merge_build_infos([dep_result["build"], cfg_result["build"], infra_result["build"], ci_result["build"]]),
        frontend=FrontendInfo.model_validate({**cfg_result["frontend"].model_dump(), **frontend_result["frontend"].model_dump(exclude_unset=True)}),
        data_stores=data_stores,
        processes=infra_result.get("processes") or [],
        environment_variables=env_result["environment_variables"],
        health=health_result["health"],
        monitoring=health_result["monitoring"],
        infrastructure_hints=infra_result["infrastructure_hints"],
        conflicts=conflicts,
        low_confidence_items=low_confidence_items,
        readme_notes=docs_result.get("readme_notes"),
        summary="",
    )
    context.summary = _summarize_context(context)
    context_md = _context_markdown(context)

    write_json(analyzer_context_path(workspace), context.model_dump(exclude_none=True))
    analyzer_context_md_path(workspace).write_text(context_md, encoding="utf-8")
    return context, context_md, runtime_paths_for_workspace(workspace)
