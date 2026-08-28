"""Typed artifacts exchanged between customization agents.

Agents communicate through these structures rather than free-form text dumps.
Repository-derived strings are treated as untrusted content.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal


class CustomizationMode(str, Enum):
    FULL = "full_transformation"
    TARGETED = "targeted_screen"
    DESIGN_SYSTEM = "design_system"
    RESPONSIVE = "responsive"
    ACCESSIBILITY = "accessibility"


class RunStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    AWAITING_REVIEW = "awaiting_review"
    COMPLETED = "completed"
    FAILED = "failed"
    BLOCKED = "blocked"


class ChangeClass(str, Enum):
    UI = "UI"
    UX = "UX"
    STYLE = "STYLE"
    STRUCTURE = "STRUCTURE"
    BUSINESS_LOGIC = "BUSINESS_LOGIC"
    UNKNOWN = "UNKNOWN"


class FailureClass(str, Enum):
    TRANSIENT = "TRANSIENT"
    TOOL_FAILURE = "TOOL_FAILURE"
    CONTEXT_FAILURE = "CONTEXT_FAILURE"
    VALIDATION_FAILURE = "VALIDATION_FAILURE"
    POLICY_VIOLATION = "POLICY_VIOLATION"
    CODE_FAILURE = "CODE_FAILURE"
    BUILD_FAILURE = "BUILD_FAILURE"
    UNKNOWN = "UNKNOWN"


class TrustLevel(str, Enum):
    TRUSTED = "TRUSTED"
    UNTRUSTED_REPOSITORY_CONTENT = "UNTRUSTED_REPOSITORY_CONTENT"
    GENERATED_ARTIFACT = "GENERATED_ARTIFACT"


PERMITTED_CHANGE_CLASSES = {ChangeClass.UI, ChangeClass.UX, ChangeClass.STYLE, ChangeClass.STRUCTURE}
BLOCKED_CHANGE_CLASSES = {ChangeClass.BUSINESS_LOGIC, ChangeClass.UNKNOWN}

PIPELINE_STAGES = [
    "intake",
    "mapping",
    "business_logic",
    "ux_research",
    "ux_strategy",
    "design_system",
    "screen_planner",
    "implement_shell",
    "implement_screens",
    "implement_responsive",
    "implement_a11y",
    "visual_qa",
    "functional_safety",
    "repair",
    "preview_verify",
    "review_gate",
]

ANALYSIS_STAGES = {
    "intake",
    "mapping",
    "business_logic",
    "ux_research",
    "ux_strategy",
    "design_system",
    "screen_planner",
}

IMPLEMENTATION_STAGES = {
    "implement_shell",
    "implement_screens",
    "implement_responsive",
    "implement_a11y",
}

STAGE_LABELS = {
    "intake": "Repository analyzed",
    "mapping": "Frontend map created",
    "business_logic": "Business logic boundaries identified",
    "ux_research": "Product UX model generated",
    "ux_strategy": "UX architecture generated",
    "design_system": "Design system generated",
    "screen_planner": "Screen plan created",
    "implement_shell": "Application shell",
    "implement_screens": "Screens updated",
    "implement_responsive": "Responsive behavior",
    "implement_a11y": "Accessibility",
    "visual_qa": "Visual QA",
    "functional_safety": "Functional safety",
    "repair": "Repair pass",
    "preview_verify": "Preview verification",
    "review_gate": "Final review",
}

POLICY_NAMES = (
    "NO_BUSINESS_LOGIC_MODIFICATION",
    "NO_SECRET_ACCESS",
    "NO_CREDENTIAL_EXFILTRATION",
    "NO_UNAPPROVED_DEPENDENCY",
    "NO_DESTRUCTIVE_OPERATION",
    "NO_PROTECTED_FILE_MODIFICATION",
    "NO_UNSAFE_PREVIEW_ACCESS",
)

FRONTEND_EXTENSIONS = {
    ".tsx",
    ".jsx",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".module.css",
    ".html",
    ".htm",
    ".svg",
    ".vue",
    ".svelte",
}

STYLE_EXTENSIONS = {".css", ".scss", ".sass", ".less", ".module.css"}
COMPONENT_EXTENSIONS = {".tsx", ".jsx", ".vue", ".svelte"}
CONFIG_FILENAMES = {
    "package.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "package-lock.json",
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mjs",
    "angular.json",
    "svelte.config.js",
    "nuxt.config.ts",
    "nuxt.config.js",
    "tailwind.config.js",
    "tailwind.config.ts",
    "postcss.config.js",
    "postcss.config.mjs",
    "tsconfig.json",
    "jsconfig.json",
}

IGNORED_DIRECTORY_NAMES = {
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    "coverage",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".turbo",
    ".cache",
    ".vercel",
    ".deplai_runtime",
    "runtime",
    "venv",
    ".venv",
}

SECRET_FILENAMES = {
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    ".env.test",
    "credentials.json",
    "secrets.json",
    "id_rsa",
    "id_ed25519",
}

SECRET_SUFFIXES = {".pem", ".key", ".p12", ".pfx"}

PROTECTED_PATH_HINTS = (
    "/api/",
    "\\api\\",
    "/server/",
    "/backend/",
    "/prisma/",
    "/migrations/",
    "/graphql/",
    "/trpc/",
    "auth.ts",
    "auth.js",
    "middleware.ts",
    "middleware.js",
    "/lib/db",
    "/lib/auth",
    "/services/",
    "route.ts",
    "route.js",
    "actions.ts",
    "actions.js",
    "schema.prisma",
    "database.sql",
)

FRONTEND_PATH_HINTS = (
    "/components/",
    "/pages/",
    "/app/",
    "/src/app/",
    "/styles/",
    "/css/",
    "/ui/",
    "/layouts/",
    "/features/",
    "/views/",
    "/public/",
    "globals.css",
    "index.css",
    "app.css",
)

LOGIC_TOKEN_HINTS = (
    "usestate",
    "useeffect",
    "usereducer",
    "usequery",
    "usemutation",
    "fetch(",
    "axios.",
    "prisma.",
    "mongoose.",
    "createclient",
    "getserver",
    "cookies(",
    "headers(",
    "authorization",
    "bearer ",
    "process.env",
    "secret",
    "password",
    "apikey",
    "api_key",
    "private_key",
    "stripe",
    "razorpay",
    "jwt",
    "bcrypt",
    "hashpassword",
    "permission",
    "rbac",
    "pric",
    "discount",
    "checkout",
    "webhook",
)

PRESENTATION_TOKEN_HINTS = (
    "classname",
    "class=",
    "style=",
    "styled",
    "tailwind",
    "theme",
    "css",
    "font",
    "color",
    "padding",
    "margin",
    "flex",
    "grid",
    "aria-",
    "role=",
    "placeholder",
    "variant",
)


def empty_manifest() -> dict[str, Any]:
    return {
        "language": "unknown",
        "framework": "unknown",
        "frontend_framework": "unknown",
        "package_manager": "unknown",
        "build_system": "unknown",
        "routing": "unknown",
        "source_directories": [],
        "entry_points": [],
        "design_system": "unknown",
        "component_libraries": [],
        "css_strategy": "unknown",
        "state_management": "unknown",
        "api_clients": [],
        "auth_boundaries": [],
        "testing": [],
        "build_command": None,
        "dev_command": None,
        "preview_requirements": [],
    }


def empty_boundary() -> dict[str, Any]:
    return {
        "protected_files": [],
        "protected_directories": [],
        "protected_symbols": [],
        "protected_functions": [],
        "protected_imports": [],
        "allowed_frontend_surface": [],
    }


CustomizationModeName = Literal[
    "full_transformation",
    "targeted_screen",
    "design_system",
    "responsive",
    "accessibility",
]
