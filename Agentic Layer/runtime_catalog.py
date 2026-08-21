"""DeplAI runtime / framework provisioning catalog.

Single source of truth for:
- what project shapes we can detect
- which EC2 bootstrap recipe (app_kind) they map to
- install / build / start defaults used by the packager + EC2 renderer

Detection priority (lower runs first among language recipes; packaging is handled
separately by the packager before these recipes):
  docker → static artifact → node → python → go → java → dotnet → php → ruby → rust
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class FrameworkHint:
    """Framework-level signal (usually nested under a language runtime)."""

    name: str
    role: str
    detect_deps: tuple[str, ...] = ()
    detect_files: tuple[str, ...] = ()
    notes: str = ""


@dataclass(frozen=True)
class RuntimeRecipe:
    """EC2-bootable (or edge-hostable) runtime recipe."""

    app_kind: str
    display_name: str
    category: str  # language | packaging | static
    priority: int
    detect_files: tuple[str, ...] = ()
    detect_any_files: tuple[str, ...] = ()  # any one is enough
    package_dirs: tuple[str, ...] = (".",)
    dnf_packages: tuple[str, ...] = ()
    install_script: str = ""
    default_build_command: str = ""
    default_start_command: str = ""
    min_root_volume_gb: int = 35
    platform_targets: tuple[str, ...] = ("ec2",)
    frameworks: tuple[FrameworkHint, ...] = ()
    bootstrap_notes: str = ""


# Framework hints enrich planning / docs; language recipes own EC2 bootstrap.
NODE_FRAMEWORKS: tuple[FrameworkHint, ...] = (
    FrameworkHint("nextjs", "ssr_web_framework", detect_deps=("next",), detect_files=("next.config.js", "next.config.ts")),
    FrameworkHint("nuxt", "ssr_web_framework", detect_deps=("nuxt",)),
    FrameworkHint("remix", "ssr_web_framework", detect_deps=("@remix-run/react", "remix")),
    FrameworkHint("nestjs", "http_api_server", detect_deps=("@nestjs/core",)),
    FrameworkHint("express", "http_api_server", detect_deps=("express",)),
    FrameworkHint("fastify", "http_api_server", detect_deps=("fastify",)),
    FrameworkHint("react", "spa_frontend", detect_deps=("react",), detect_files=("vite.config.ts", "vite.config.js")),
    FrameworkHint("vue", "spa_frontend", detect_deps=("vue",)),
    FrameworkHint("svelte", "spa_frontend", detect_deps=("svelte",)),
    FrameworkHint("angular", "spa_frontend", detect_deps=("@angular/core",), detect_files=("angular.json",)),
    FrameworkHint("prisma", "orm", detect_deps=("prisma", "@prisma/client"), detect_files=("prisma/schema.prisma",)),
)

PYTHON_FRAMEWORKS: tuple[FrameworkHint, ...] = (
    FrameworkHint("fastapi", "http_api_server", detect_deps=("fastapi",)),
    FrameworkHint("django", "ssr_web_framework", detect_deps=("django",), detect_files=("manage.py",)),
    FrameworkHint("flask", "http_api_server", detect_deps=("flask",)),
    FrameworkHint("celery", "background_worker", detect_deps=("celery",)),
)

JAVA_FRAMEWORKS: tuple[FrameworkHint, ...] = (
    FrameworkHint("spring_boot", "http_api_server", detect_deps=(), detect_files=("pom.xml", "build.gradle", "build.gradle.kts")),
)

DOTNET_FRAMEWORKS: tuple[FrameworkHint, ...] = (
    FrameworkHint("aspnet", "http_api_server", detect_files=("*.csproj",)),
)

PHP_FRAMEWORKS: tuple[FrameworkHint, ...] = (
    FrameworkHint("laravel", "ssr_web_framework", detect_deps=("laravel/framework",), detect_files=("artisan",)),
)

RUBY_FRAMEWORKS: tuple[FrameworkHint, ...] = (
    FrameworkHint("rails", "ssr_web_framework", detect_deps=("rails",), detect_files=("config/application.rb", "bin/rails")),
)

RUNTIME_RECIPES: tuple[RuntimeRecipe, ...] = (
    RuntimeRecipe(
        app_kind="docker",
        display_name="Docker / Compose",
        category="packaging",
        priority=10,
        detect_any_files=(
            "Dockerfile",
            "dockerfile",
            "docker-compose.yml",
            "docker-compose.yaml",
            "compose.yml",
            "compose.yaml",
        ),
        dnf_packages=("docker",),
        min_root_volume_gb=40,
        bootstrap_notes="Install Docker Engine + Compose plugin; build/run image or compose up.",
    ),
    RuntimeRecipe(
        app_kind="static",
        display_name="Static site artifact",
        category="static",
        priority=20,
        detect_any_files=("dist/index.html", "build/index.html", "out/index.html"),
        dnf_packages=("nginx",),
        platform_targets=("ec2", "s3_cloudfront"),
        bootstrap_notes="Serve prebuilt HTML/JS/CSS via nginx or S3+CloudFront.",
    ),
    RuntimeRecipe(
        app_kind="node",
        display_name="Node.js",
        category="language",
        priority=30,
        detect_files=("package.json",),
        package_dirs=(".", "frontend", "web", "client", "app", "backend", "server", "api"),
        dnf_packages=("nodejs", "npm"),
        default_build_command="npm run build",
        default_start_command="npm run start",
        min_root_volume_gb=35,
        frameworks=NODE_FRAMEWORKS,
        bootstrap_notes="npm ci/install, optional build, pm2 or static export behind nginx.",
    ),
    RuntimeRecipe(
        app_kind="python",
        display_name="Python",
        category="language",
        priority=40,
        detect_any_files=("requirements.txt", "pyproject.toml", "Pipfile", "app.py", "main.py", "server.py", "manage.py"),
        dnf_packages=("python3", "python3-pip"),
        default_start_command="python3 app.py",
        frameworks=PYTHON_FRAMEWORKS,
        bootstrap_notes="pip install -r requirements.txt (or pyproject); systemd/uvicorn/gunicorn/django.",
    ),
    RuntimeRecipe(
        app_kind="go",
        display_name="Go",
        category="language",
        priority=50,
        detect_files=("go.mod",),
        dnf_packages=("golang",),
        default_build_command="go build -o /opt/deplai-app/bin/app .",
        default_start_command="/opt/deplai-app/bin/app",
        bootstrap_notes="go build then run binary under systemd; nginx reverse-proxy.",
    ),
    RuntimeRecipe(
        app_kind="java",
        display_name="Java / JVM",
        category="language",
        priority=60,
        detect_any_files=("pom.xml", "build.gradle", "build.gradle.kts"),
        dnf_packages=("java-17-amazon-corretto-devel", "maven"),
        default_build_command="mvn -q -DskipTests package",
        default_start_command="java -jar target/*.jar",
        min_root_volume_gb=40,
        frameworks=JAVA_FRAMEWORKS,
        bootstrap_notes="Maven/Gradle package; run Spring Boot or executable jar behind nginx.",
    ),
    RuntimeRecipe(
        app_kind="dotnet",
        display_name=".NET",
        category="language",
        priority=70,
        detect_any_files=("*.csproj", "*.fsproj", "*.sln"),
        install_script="""
rpm --import https://packages.microsoft.com/keys/microsoft.asc || true
curl -fsSL -o /tmp/microsoft-prod.rpm https://packages.microsoft.com/config/centos/7/packages-microsoft-prod.rpm || true
rpm -Uvh /tmp/microsoft-prod.rpm || true
dnf install -y dotnet-sdk-8.0 || dnf install -y dotnet-sdk-6.0 || true
""",
        default_build_command="dotnet publish -c Release -o /opt/deplai-app/publish",
        default_start_command="dotnet /opt/deplai-app/publish/*.dll",
        min_root_volume_gb=40,
        frameworks=DOTNET_FRAMEWORKS,
        bootstrap_notes="dotnet publish + run ASP.NET DLL behind nginx.",
    ),
    RuntimeRecipe(
        app_kind="php",
        display_name="PHP",
        category="language",
        priority=80,
        detect_any_files=("composer.json", "index.php", "artisan"),
        dnf_packages=("php", "php-cli", "php-fpm", "php-mbstring", "php-xml", "php-mysqlnd", "unzip"),
        install_script="""
if ! command -v composer >/dev/null 2>&1; then
  curl -fsSL https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
fi
""",
        default_build_command="composer install --no-dev --optimize-autoloader",
        default_start_command="php-fpm",
        frameworks=PHP_FRAMEWORKS,
        bootstrap_notes="composer install; php-fpm + nginx document root.",
    ),
    RuntimeRecipe(
        app_kind="ruby",
        display_name="Ruby",
        category="language",
        priority=90,
        detect_files=("Gemfile",),
        dnf_packages=("ruby", "ruby-devel", "gcc", "make", "redhat-rpm-config"),
        install_script="gem install bundler --no-document || true",
        default_build_command="bundle install --deployment",
        default_start_command="bundle exec puma -C config/puma.rb || bundle exec rails server -b 0.0.0.0 -p $APP_PORT",
        frameworks=RUBY_FRAMEWORKS,
        bootstrap_notes="bundler install; puma/rails under systemd behind nginx.",
    ),
    RuntimeRecipe(
        app_kind="rust",
        display_name="Rust",
        category="language",
        priority=100,
        detect_files=("Cargo.toml",),
        install_script="""
if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  . "$HOME/.cargo/env"
fi
""",
        default_build_command="cargo build --release",
        default_start_command="./target/release/$(basename \"$PWD\")",
        min_root_volume_gb=40,
        bootstrap_notes="cargo build --release; run binary under systemd behind nginx.",
    ),
)


DATASTORE_PROVISIONING: tuple[dict[str, Any], ...] = (
    {"name": "postgresql", "aws": "rds_postgres", "detect": ["prisma", "psycopg2", "sqlalchemy", "DATABASE_URL"]},
    {"name": "mysql", "aws": "rds_mysql", "detect": ["mysql", "pymysql", "mysql://"]},
    {"name": "redis", "aws": "elasticache_redis", "detect": ["redis", "ioredis", "bull", "celery"]},
    {"name": "mongodb", "aws": "documentdb_or_self_managed", "detect": ["mongoose", "mongodb://"]},
    {"name": "s3", "aws": "s3_bucket", "detect": ["@aws-sdk/client-s3", "boto3"]},
    {"name": "rabbitmq", "aws": "amazon_mq", "detect": ["amqplib", "amqp"]},
    {"name": "kafka", "aws": "msk", "detect": ["kafkajs", "kafka"]},
)


def list_runtime_recipes() -> list[RuntimeRecipe]:
    return sorted(RUNTIME_RECIPES, key=lambda item: item.priority)


def get_runtime_recipe(app_kind: str) -> RuntimeRecipe | None:
    kind = str(app_kind or "").strip().lower()
    for recipe in RUNTIME_RECIPES:
        if recipe.app_kind == kind:
            return recipe
    return None


def catalog_summary() -> dict[str, Any]:
    """JSON-friendly catalog for UI / docs / planning agents."""
    return {
        "runtimes": [
            {
                **{k: v for k, v in asdict(recipe).items() if k != "frameworks"},
                "frameworks": [asdict(item) for item in recipe.frameworks],
            }
            for recipe in list_runtime_recipes()
        ],
        "datastores": list(DATASTORE_PROVISIONING),
        "ec2_bootstrapped_kinds": sorted(
            recipe.app_kind
            for recipe in RUNTIME_RECIPES
            if "ec2" in recipe.platform_targets
        ),
    }


def _path_exists(root: Path, rel: str) -> bool:
    rel = rel.replace("\\", "/").strip("/")
    if "*" in rel:
        return any(root.glob(rel))
    return (root / rel).exists()


def detect_bootstrappable_recipe(root: Path) -> RuntimeRecipe | None:
    """Language recipes only (docker/static are handled by the packager first)."""
    for recipe in list_runtime_recipes():
        if recipe.app_kind in {"docker", "static"}:
            continue
        search_roots = [root / rel if rel != "." else root for rel in (recipe.package_dirs or (".",))]
        for package_root in search_roots:
            if not package_root.is_dir():
                continue
            if recipe.detect_files and all(_path_exists(package_root, rel) for rel in recipe.detect_files):
                return recipe
            if recipe.detect_any_files and any(_path_exists(package_root, rel) for rel in recipe.detect_any_files):
                return recipe
    return None


def detect_language_recipe(root: Path) -> RuntimeRecipe | None:
    """Pick static artifact or language recipe (docker handled separately)."""
    for candidate in ("dist/index.html", "build/index.html", "out/index.html"):
        if _path_exists(root, candidate):
            return get_runtime_recipe("static")
    return detect_bootstrappable_recipe(root)


def resolve_package_root(root: Path, recipe: RuntimeRecipe) -> Path:
    for rel in recipe.package_dirs or (".",):
        candidate = root if rel == "." else root / rel
        if not candidate.is_dir():
            continue
        if recipe.detect_files and all(_path_exists(candidate, item) for item in recipe.detect_files):
            return candidate
        if recipe.detect_any_files and any(_path_exists(candidate, item) for item in recipe.detect_any_files):
            return candidate
    return root


def infer_commands_for_recipe(root: Path, recipe: RuntimeRecipe) -> tuple[str, str, list[str]]:
    """Return (build_command, start_command, warnings) with repo-aware overrides."""
    warnings: list[str] = []
    package_root = resolve_package_root(root, recipe)
    build = recipe.default_build_command
    start = recipe.default_start_command

    if recipe.app_kind == "node":
        import json

        package_json_path = package_root / "package.json"
        scripts: dict[str, Any] = {}
        try:
            payload = json.loads(package_json_path.read_text(encoding="utf-8"))
            scripts = payload.get("scripts") if isinstance(payload.get("scripts"), dict) else {}
        except Exception:
            scripts = {}
        build = "npm run build" if scripts.get("build") else ""
        if scripts.get("start"):
            start = "npm run start"
        elif (package_root / "server.js").exists():
            start = "node server.js"
        elif (package_root / "app.js").exists():
            start = "node app.js"
        elif (package_root / "index.js").exists():
            start = "node index.js"
        else:
            start = ""
        if not build:
            warnings.append("No npm build script detected; EC2 bootstrap will skip build.")
        return build, start, warnings

    if recipe.app_kind == "python":
        if (package_root / "manage.py").exists():
            start = "python3 manage.py runserver 0.0.0.0:$APP_PORT"
            build = "python3 manage.py migrate --noinput || true"
        elif (package_root / "app.py").exists():
            # Prefer uvicorn when FastAPI-ish layout is likely
            text = ""
            try:
                text = (package_root / "app.py").read_text(encoding="utf-8", errors="replace")
            except Exception:
                text = ""
            if "FastAPI" in text or "fastapi" in text:
                start = "python3 -m uvicorn app:app --host 0.0.0.0 --port $APP_PORT"
            else:
                start = "python3 app.py"
        elif (package_root / "main.py").exists():
            start = "python3 main.py"
        elif (package_root / "server.py").exists():
            start = "python3 server.py"
        if (package_root / "requirements.txt").exists():
            build = "python3 -m pip install -r requirements.txt"
            warnings.append("Python requirements.txt detected; EC2 bootstrap will install it.")
        elif (package_root / "pyproject.toml").exists():
            build = "python3 -m pip install ."
        return build, start, warnings

    if recipe.app_kind == "go":
        build = "mkdir -p bin && go build -o bin/app ."
        start = "./bin/app"
        return build, start, warnings

    if recipe.app_kind == "java":
        if (package_root / "pom.xml").exists():
            build = "mvn -q -DskipTests package"
            start = "bash -lc 'JAR=$(ls -1 target/*.jar | grep -v original | head -n 1); exec java -jar \"$JAR\"'"
        elif (package_root / "build.gradle").exists() or (package_root / "build.gradle.kts").exists():
            build = "./gradlew bootJar -x test || ./gradlew build -x test"
            start = "bash -lc 'JAR=$(ls -1 build/libs/*.jar | grep -v plain | head -n 1); exec java -jar \"$JAR\"'"
        return build, start, warnings

    if recipe.app_kind == "dotnet":
        build = "dotnet publish -c Release -o ./publish"
        start = "bash -lc 'DLL=$(ls -1 publish/*.dll | head -n 1); exec dotnet \"$DLL\" --urls http://0.0.0.0:$APP_PORT'"
        return build, start, warnings

    if recipe.app_kind == "php":
        build = "composer install --no-dev --optimize-autoloader" if (package_root / "composer.json").exists() else ""
        start = "php -S 0.0.0.0:$APP_PORT -t public" if (package_root / "public").is_dir() else "php -S 0.0.0.0:$APP_PORT"
        return build, start, warnings

    if recipe.app_kind == "ruby":
        build = "bundle install"
        if (package_root / "bin/rails").exists() or (package_root / "config/application.rb").exists():
            start = "bundle exec rails server -b 0.0.0.0 -p $APP_PORT"
        else:
            start = "bundle exec puma -b tcp://0.0.0.0:$APP_PORT"
        return build, start, warnings

    if recipe.app_kind == "rust":
        build = "cargo build --release"
        start = "bash -lc 'BIN=$(ls -1 target/release/* | head -n 1); exec \"$BIN\"'"
        return build, start, warnings

    return build, start, warnings


def install_bash_for_kind(app_kind: str) -> str:
    """Shell fragment installed during EC2 user_data for a given app_kind."""
    recipe = get_runtime_recipe(app_kind)
    if recipe is None:
        return ""
    lines: list[str] = []
    if recipe.dnf_packages:
        pkgs = " ".join(recipe.dnf_packages)
        lines.append(f"dnf install -y {pkgs}")
    extra = str(recipe.install_script or "").strip()
    if extra:
        lines.append(extra)
    if recipe.app_kind == "node":
        lines.extend(
            [
                "swapoff /swapfile || true",
                "rm -f /swapfile",
                "fallocate -l 6G /swapfile",
                "chmod 600 /swapfile",
                "mkswap /swapfile",
                "swapon /swapfile",
                "grep -q '^/swapfile ' /etc/fstab || echo '/swapfile swap swap defaults 0 0' >> /etc/fstab",
            ]
        )
    if recipe.app_kind == "docker":
        lines = [
            "dnf install -y docker",
            "systemctl enable --now docker",
            "usermod -aG docker ec2-user || true",
            "mkdir -p /usr/local/lib/docker/cli-plugins",
            'if [ ! -x /usr/local/lib/docker/cli-plugins/docker-compose ]; then',
            '  curl -fsSL "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64" \\',
            "    -o /usr/local/lib/docker/cli-plugins/docker-compose",
            "  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose",
            "fi",
            "docker version",
            "docker compose version || true",
            'write_status "docker_engine_ready"',
        ]
    return "\n".join(lines)
