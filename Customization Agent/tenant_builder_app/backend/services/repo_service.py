from __future__ import annotations

from pathlib import Path
import shutil
import subprocess


IGNORED_REPO_ARTIFACTS = {
    "node_modules",
    ".next",
    "dist",
    "build",
    "coverage",
    ".git",
    ".cache",
}

IGNORED_FILE_NAMES = {
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    ".env.test",
}

BASE_FRONTEND_PORT = 3001
TENANT_FRONTEND_PORT = 3002
BASE_BACKEND_PORT = 8001
TENANT_BACKEND_PORT = 8002


def ignore_repo_artifacts(_directory: str, contents: list[str]) -> list[str]:
    ignored: list[str] = []
    for name in contents:
        if name in IGNORED_REPO_ARTIFACTS:
            ignored.append(name)
            continue

        # Do not carry environment files from base repo into tenant copies.
        if name in IGNORED_FILE_NAMES or name.startswith(".env."):
            ignored.append(name)

    return ignored


def get_tenant_repo_path(base_repo_path: str, tenant_name: str) -> str:
    source = Path(base_repo_path).resolve()
    tenant_repo_name = f"SubSpace-{tenant_name}"
    return str((source.parent / tenant_repo_name).resolve())


def _assert_tenant_repo(repo_dir: Path) -> None:
    if not repo_dir.name.startswith("SubSpace-"):
        raise ValueError(f"Refusing to modify non-tenant repository: {repo_dir}")


def cleanup_repo_artifacts(repo_path: str) -> None:
    repo_dir = Path(repo_path).resolve()
    _assert_tenant_repo(repo_dir)

    for artifact_name in IGNORED_REPO_ARTIFACTS:
        for artifact_path in repo_dir.rglob(artifact_name):
            if artifact_path == repo_dir:
                continue
            if artifact_path.is_dir() and not artifact_path.is_symlink():
                shutil.rmtree(artifact_path, ignore_errors=False)


def install_dependencies(repo_path: str) -> None:
    repo_dir = Path(repo_path).resolve()
    _assert_tenant_repo(repo_dir)
    cleanup_repo_artifacts(str(repo_dir))

    frontend_dir = repo_dir / "frontend"
    if (frontend_dir / "package.json").exists():
        subprocess.run(
            ["npm", "install", "--legacy-peer-deps"],
            cwd=str(frontend_dir),
            check=True,
        )

    backend_dir = repo_dir / "backend"
    if (backend_dir / "package.json").exists():
        subprocess.run(
            ["npm", "install"],
            cwd=str(backend_dir),
            check=True,
        )


def _replace_literal(content: str, old: str, new: str) -> str:
    if old not in content:
        return content
    return content.replace(old, new)


def _configure_tenant_runtime_ports(repo_path: str) -> None:
    repo_dir = Path(repo_path).resolve()
    _assert_tenant_repo(repo_dir)

    frontend_package_json = repo_dir / "frontend" / "package.json"
    if frontend_package_json.exists():
        original = frontend_package_json.read_text(encoding="utf-8")
        updated = _replace_literal(
            original,
            f"next dev -p {BASE_FRONTEND_PORT}",
            f"next dev -p {TENANT_FRONTEND_PORT}",
        )
        if updated != original:
            frontend_package_json.write_text(updated, encoding="utf-8")

    backend_index = repo_dir / "backend" / "index.js"
    if backend_index.exists():
        original = backend_index.read_text(encoding="utf-8")
        updated = _replace_literal(
            original,
            f"process.env.PORT || {BASE_BACKEND_PORT}",
            f"process.env.PORT || {TENANT_BACKEND_PORT}",
        )
        if updated != original:
            backend_index.write_text(updated, encoding="utf-8")

    frontend_api_setup = repo_dir / "frontend" / "utils" / "apiSetup.js"
    if frontend_api_setup.exists():
        original = frontend_api_setup.read_text(encoding="utf-8")
        updated = _replace_literal(
            original,
            f"localhost:{BASE_BACKEND_PORT}",
            f"localhost:{TENANT_BACKEND_PORT}",
        )
        if updated != original:
            frontend_api_setup.write_text(updated, encoding="utf-8")


def create_tenant_repo(base_repo_path: str, tenant_name: str) -> str:
    source = Path(base_repo_path).resolve()
    if not source.exists():
        raise FileNotFoundError(f"Base repository not found: {source}")

    destination = Path(get_tenant_repo_path(base_repo_path=base_repo_path, tenant_name=tenant_name))
    if destination.exists():
        raise FileExistsError(f"Tenant repository already exists: {destination}")

    shutil.copytree(source, destination, ignore=ignore_repo_artifacts)
    _configure_tenant_runtime_ports(str(destination))
    install_dependencies(str(destination))
    return str(destination)


def reset_tenant_repo(base_repo_path: str, tenant_name: str) -> str:
    source = Path(base_repo_path).resolve()
    if not source.exists():
        raise FileNotFoundError(f"Base repository not found: {source}")

    destination = Path(get_tenant_repo_path(base_repo_path=base_repo_path, tenant_name=tenant_name))
    if destination.exists():
        _assert_tenant_repo(destination.resolve())
        try:
            shutil.rmtree(destination)
        except OSError:
            subprocess.run(["rm", "-rf", str(destination)], check=True)
        if destination.exists():
            raise OSError(f"Failed to reset tenant repository: {destination}")

    shutil.copytree(source, destination, ignore=ignore_repo_artifacts)
    _configure_tenant_runtime_ports(str(destination))
    install_dependencies(str(destination))
    return str(destination)


def ensure_tenant_repo(base_repo_path: str, tenant_name: str) -> str:
    destination = Path(get_tenant_repo_path(base_repo_path=base_repo_path, tenant_name=tenant_name))
    if destination.exists():
        _assert_tenant_repo(destination.resolve())
        _configure_tenant_runtime_ports(str(destination))
        return str(destination)
    return create_tenant_repo(base_repo_path=base_repo_path, tenant_name=tenant_name)