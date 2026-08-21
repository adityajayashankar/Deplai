"""Auth / OAuth provisioning helpers for deployed apps.

DeplAI cannot create Google/GitHub OAuth apps for the customer, but it can:
1. Detect which auth providers the repo expects (.env.example + dependencies)
2. Inject the live public base URL so callback redirects match the deployed host
3. Inject operator-supplied client IDs/secrets into the instance .env
4. Surface missing secrets before/after deploy
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


ENV_TEMPLATE_NAMES = (
    ".env.example",
    ".env.sample",
    ".env.template",
    "env.example",
    ".env.defaults",
    ".env.development.example",
    ".env.local.example",
)

PROVIDER_KEY_HINTS: dict[str, tuple[str, ...]] = {
    "google": (
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "GOOGLE_OAUTH_CLIENT_ID",
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "AUTH_GOOGLE_ID",
        "AUTH_GOOGLE_SECRET",
    ),
    "github": (
        "GITHUB_CLIENT_ID",
        "GITHUB_CLIENT_SECRET",
        "AUTH_GITHUB_ID",
        "AUTH_GITHUB_SECRET",
    ),
    "nextauth": (
        "NEXTAUTH_URL",
        "NEXTAUTH_SECRET",
        "AUTH_SECRET",
        "AUTH_URL",
    ),
    "platform": (
        "PLATFORM_CLIENT_ID",
        "PLATFORM_CLIENT_SECRET",
        "DEPLAI_CLIENT_ID",
        "DEPLAI_CLIENT_SECRET",
        "AUTH_PLATFORM_ID",
        "AUTH_PLATFORM_SECRET",
    ),
    "facebook": ("FACEBOOK_CLIENT_ID", "FACEBOOK_CLIENT_SECRET", "AUTH_FACEBOOK_ID", "AUTH_FACEBOOK_SECRET"),
    "apple": ("APPLE_CLIENT_ID", "APPLE_CLIENT_SECRET", "AUTH_APPLE_ID", "AUTH_APPLE_SECRET"),
    "microsoft": ("AZURE_AD_CLIENT_ID", "MICROSOFT_CLIENT_ID", "AUTH_MICROSOFT_ID", "AUTH_MICROSOFT_SECRET"),
}

AUTH_DEPENDENCY_HINTS: dict[str, str] = {
    "next-auth": "nextauth",
    "@auth/core": "nextauth",
    "@auth/nextjs": "nextauth",
    "passport-google-oauth20": "google",
    "passport-github2": "github",
    "@react-oauth/google": "google",
    "google-auth-library": "google",
    "@octokit/auth-oauth-app": "github",
    "authlib": "platform",
    "social-auth-app-django": "platform",
    "django-allauth": "platform",
}

PUBLIC_URL_KEYS = (
    "APP_URL",
    "APP_BASE_URL",
    "PUBLIC_URL",
    "BASE_URL",
    "SITE_URL",
    "NEXTAUTH_URL",
    "AUTH_URL",
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_BASE_URL",
    "VITE_APP_URL",
    "REACT_APP_URL",
    "REACT_APP_API_URL",
    "VITE_API_URL",
)


@dataclass
class AuthRequirements:
    providers: list[str] = field(default_factory=list)
    required_secret_keys: list[str] = field(default_factory=list)
    optional_url_keys: list[str] = field(default_factory=list)
    detected_env_keys: list[str] = field(default_factory=list)
    detection_sources: list[str] = field(default_factory=list)
    callback_paths: list[str] = field(default_factory=list)
    missing_secret_keys: list[str] = field(default_factory=list)
    supplied_secrets: dict[str, str] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""


def _parse_env_keys(text: str) -> list[str]:
    keys: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key = stripped.split("=", 1)[0].strip()
        if key and key not in keys:
            keys.append(key)
    return keys


def _dependency_names(root: Path) -> set[str]:
    names: set[str] = set()
    for rel in ("package.json", "frontend/package.json", "backend/package.json", "web/package.json"):
        path = root / rel
        if not path.is_file():
            continue
        try:
            payload = json.loads(_read_text(path))
        except Exception:
            continue
        for section in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
            block = payload.get(section)
            if isinstance(block, dict):
                names.update(str(key).lower() for key in block.keys())
    req = root / "requirements.txt"
    if req.is_file():
        for line in _read_text(req).splitlines():
            cleaned = re.split(r"[<>=!~\s]", line.strip(), maxsplit=1)[0].strip().lower()
            if cleaned and not cleaned.startswith("#"):
                names.add(cleaned)
    return names


def _collect_env_template_keys(root: Path) -> tuple[list[str], list[str]]:
    keys: list[str] = []
    sources: list[str] = []
    for name in ENV_TEMPLATE_NAMES:
        for path in [root / name, *root.glob(f"*/{name}")]:
            if not path.is_file():
                continue
            found = _parse_env_keys(_read_text(path))
            if not found:
                continue
            sources.append(str(path.relative_to(root)).replace("\\", "/"))
            for key in found:
                if key not in keys:
                    keys.append(key)
    return keys, sources


def _providers_for_key(key: str) -> list[str]:
    upper = key.upper()
    matched: list[str] = []
    for provider, hints in PROVIDER_KEY_HINTS.items():
        hint_set = {h.upper() for h in hints}
        if upper in hint_set:
            matched.append(provider)
            continue
        token = provider.upper()
        if provider == "nextauth" and ("NEXTAUTH" in upper or upper in {"AUTH_SECRET", "AUTH_URL"}):
            matched.append(provider)
        elif provider != "nextauth" and token in upper:
            matched.append(provider)
    return matched


def _default_callback_paths(providers: list[str]) -> list[str]:
    paths = [
        "/api/auth/callback/google",
        "/api/auth/callback/github",
        "/auth/google/callback",
        "/auth/github/callback",
        "/login/oauth2/code/google",
        "/login/oauth2/code/github",
    ]
    if "nextauth" in providers:
        paths = [
            "/api/auth/callback/google",
            "/api/auth/callback/github",
            "/api/auth/callback/credentials",
            *paths,
        ]
    seen: set[str] = set()
    ordered: list[str] = []
    for path in paths:
        if path in seen:
            continue
        seen.add(path)
        ordered.append(path)
    return ordered


def _secrets_from_user_answers(user_answers: dict[str, Any] | None) -> dict[str, str]:
    answers = user_answers if isinstance(user_answers, dict) else {}
    supplied: dict[str, str] = {}

    def _absorb(mapping: Any) -> None:
        if not isinstance(mapping, dict):
            return
        for key, value in mapping.items():
            name = str(key or "").strip()
            text = str(value or "").strip()
            if not name or not text:
                continue
            upper = name.upper()
            if upper == name or any(
                token in upper for token in ("CLIENT", "SECRET", "AUTH", "TOKEN", "NEXTAUTH", "GOOGLE", "GITHUB", "PLATFORM")
            ):
                supplied[name] = text

    _absorb(answers.get("oauth"))
    _absorb(answers.get("auth"))
    _absorb(answers.get("secrets"))
    _absorb(answers.get("environment_variables"))
    _absorb(answers.get("env"))
    _absorb({k: v for k, v in answers.items() if isinstance(v, (str, int, float))})
    return supplied


def detect_auth_requirements(
    root: Path,
    *,
    user_answers: dict[str, Any] | None = None,
) -> AuthRequirements:
    keys, sources = _collect_env_template_keys(root)
    deps = _dependency_names(root)
    providers: list[str] = []
    required_secret_keys: list[str] = []
    optional_url_keys: list[str] = []
    detection_sources = list(sources)

    for key in keys:
        upper = key.upper()
        if upper in PUBLIC_URL_KEYS or (
            upper.endswith("_URL") and any(tok in upper for tok in ("APP", "AUTH", "PUBLIC", "SITE", "BASE", "NEXTAUTH"))
        ):
            if key not in optional_url_keys:
                optional_url_keys.append(key)
        for provider in _providers_for_key(key):
            if provider not in providers:
                providers.append(provider)
        if any(token in upper for token in ("CLIENT_SECRET", "CLIENT_ID", "AUTH_SECRET", "NEXTAUTH_SECRET", "_SECRET", "_TOKEN")):
            if upper in PUBLIC_URL_KEYS or upper.endswith("_URL") or upper == "JWT_SECRET":
                continue
            if key not in required_secret_keys:
                required_secret_keys.append(key)

    for dep, provider in AUTH_DEPENDENCY_HINTS.items():
        if dep not in deps:
            continue
        if provider not in providers:
            providers.append(provider)
        detection_sources.append(f"dependency:{dep}")
        if provider == "nextauth":
            for key in ("NEXTAUTH_SECRET", "AUTH_SECRET"):
                if key not in required_secret_keys:
                    required_secret_keys.append(key)
            for key in ("NEXTAUTH_URL", "AUTH_URL"):
                if key not in optional_url_keys:
                    optional_url_keys.append(key)
        if provider == "google":
            for key in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"):
                if key not in required_secret_keys:
                    required_secret_keys.append(key)
        if provider == "github":
            for key in ("GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"):
                if key not in required_secret_keys:
                    required_secret_keys.append(key)

    supplied = _secrets_from_user_answers(user_answers)
    missing = [
        key
        for key in required_secret_keys
        if key not in supplied and key.upper() not in {s.upper() for s in supplied}
    ]

    return AuthRequirements(
        providers=providers,
        required_secret_keys=required_secret_keys,
        optional_url_keys=optional_url_keys or list(PUBLIC_URL_KEYS[:6]),
        detected_env_keys=keys,
        detection_sources=detection_sources,
        callback_paths=_default_callback_paths(providers),
        missing_secret_keys=missing,
        supplied_secrets=supplied,
    )


def public_url_bootstrap_bash(callback_paths: list[str] | None = None) -> str:
    """Shell fragment appended during EC2 user_data after writing the base .env.

    IMPORTANT: this text is embedded inside a Terraform ``<<-USERDATA`` heredoc.
    Shell ``${...}`` must be written as ``$${...}`` so Terraform emits a literal
    ``${...}`` for bash instead of trying to parse it as HCL interpolation.
    """
    paths = callback_paths or _default_callback_paths([])
    path_list = " ".join(paths[:8])
    # Use $$ so the generated .tf contains $${VAR} → bash sees ${VAR}.
    return f"""
# ── Public URL + OAuth callback host (from instance metadata) ───────────────
PUBLIC_IP="$(curl -s --connect-timeout 2 http://169.254.169.254/latest/meta-data/public-ipv4 || true)"
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="$(curl -s --connect-timeout 2 http://169.254.169.254/latest/meta-data/local-ipv4 || true)"
fi
PUBLIC_HOST="$${{PUBLIC_IP:-127.0.0.1}}"
APP_BASE_URL="http://$${{PUBLIC_HOST}}"
{{
  echo "APP_URL=$${{APP_BASE_URL}}"
  echo "APP_BASE_URL=$${{APP_BASE_URL}}"
  echo "PUBLIC_URL=$${{APP_BASE_URL}}"
  echo "BASE_URL=$${{APP_BASE_URL}}"
  echo "SITE_URL=$${{APP_BASE_URL}}"
  echo "NEXTAUTH_URL=$${{APP_BASE_URL}}"
  echo "AUTH_URL=$${{APP_BASE_URL}}"
  echo "NEXT_PUBLIC_APP_URL=$${{APP_BASE_URL}}"
  echo "NEXT_PUBLIC_BASE_URL=$${{APP_BASE_URL}}"
  echo "VITE_APP_URL=$${{APP_BASE_URL}}"
  echo "REACT_APP_URL=$${{APP_BASE_URL}}"
  echo "REACT_APP_API_URL=$${{APP_BASE_URL}}"
  echo "VITE_API_URL=$${{APP_BASE_URL}}"
}} >> "$APP_DIR/.env"
: > /tmp/deplai-oauth-redirects.env
for path in {path_list}; do
  echo "OAUTH_REDIRECT_URI=$${{APP_BASE_URL}}$${{path}}" >> /tmp/deplai-oauth-redirects.env
done
if [ -s /tmp/deplai-oauth-redirects.env ]; then
  head -n 1 /tmp/deplai-oauth-redirects.env >> "$APP_DIR/.env" || true
  cat /tmp/deplai-oauth-redirects.env >> "$APP_DIR/.env" || true
fi
printf '%s\\n' "DeplAI public URL: $${{APP_BASE_URL}}" >> /var/log/deplai-bootstrap.log
printf '%s\\n' "Register OAuth callback URLs under $${{APP_BASE_URL}}/api/auth/callback/<provider> (or framework equivalent) in Google/GitHub consoles." >> /var/log/deplai-bootstrap.log
write_status "public_url_injected"
"""


def auth_warnings(requirements: AuthRequirements) -> list[str]:
    warnings: list[str] = []
    if requirements.providers:
        warnings.append(
            "Auth providers detected: "
            + ", ".join(requirements.providers)
            + ". Live APP_URL/NEXTAUTH_URL will be set from the instance public IP."
        )
    if requirements.missing_secret_keys:
        warnings.append(
            "Missing OAuth/auth secrets (supply via App Secrets tab → AWS Secrets Manager): "
            + ", ".join(requirements.missing_secret_keys)
            + ". Without these, Google/GitHub/platform login buttons will fail after deploy."
        )
    if requirements.callback_paths:
        warnings.append(
            "After deploy, register these callback paths on your OAuth apps (prefixed with the live URL): "
            + ", ".join(requirements.callback_paths[:6])
        )
    return warnings
