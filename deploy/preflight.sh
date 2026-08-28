#!/usr/bin/env bash
# Validate the deployment contract without printing secret values.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${1:-$SCRIPT_DIR/.env}"
COMPOSE_FILE="$REPO_DIR/docker-compose.production.yml"

if [[ ! -f "$ENV_FILE" ]]; then
  printf 'Deployment preflight failed: missing environment file %s\n' "$ENV_FILE" >&2
  exit 1
fi

value_for() {
  local key="$1"
  local line
  line="$(grep -m1 -E "^${key}=" "$ENV_FILE" || true)"
  printf '%s' "${line#*=}" | tr -d '\r'
}

invalid=()
required=(
  APP_DOMAIN
  NEXT_PUBLIC_APP_URL
  NEXT_PUBLIC_AGENTIC_WS_URL
  CORS_ORIGINS
  DEPLAI_SERVICE_KEY
  WS_TOKEN_SECRET
  SESSION_SECRET
  ADMIN_ACCESS_KEY
  ADMIN_EMAILS
  AI_CREDENTIAL_ENCRYPTION_KEY
  MYSQL_DATABASE
  MYSQL_USER
  MYSQL_PASSWORD
  MYSQL_ROOT_PASSWORD
  GITHUB_CLIENT_ID
  GITHUB_CLIENT_SECRET
  GITHUB_APP_ID
  GITHUB_PRIVATE_KEY
  GITHUB_WEBHOOK_SECRET
  DOCKER_GID
)

for key in "${required[@]}"; do
  value="$(value_for "$key")"
  if [[ -z "$value" || "$value" =~ replace-with|example\.com|your-domain|placeholder|change-me ]]; then
    invalid+=("$key must be set to a non-placeholder value")
  fi
done

app_domain="$(value_for APP_DOMAIN)"
public_url="$(value_for NEXT_PUBLIC_APP_URL)"
agentic_ws_url="$(value_for NEXT_PUBLIC_AGENTIC_WS_URL)"
cors_origins="$(value_for CORS_ORIGINS)"

if [[ -n "$app_domain" && "$public_url" != "https://${app_domain}" ]]; then
  invalid+=("NEXT_PUBLIC_APP_URL must equal https://APP_DOMAIN")
fi
if [[ -n "$app_domain" && "$agentic_ws_url" != "wss://${app_domain}/agentic" ]]; then
  invalid+=("NEXT_PUBLIC_AGENTIC_WS_URL must equal wss://APP_DOMAIN/agentic")
fi
if [[ -n "$app_domain" ]] && ! printf '%s\n' "$cors_origins" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -Fqx "https://${app_domain}"; then
  invalid+=("CORS_ORIGINS must include https://APP_DOMAIN")
fi

if ! [[ "$(value_for DOCKER_GID)" =~ ^[0-9]+$ ]]; then
  invalid+=("DOCKER_GID must be numeric")
fi

provider_keys=(
  OPENAI_API_KEY
  ANTHROPIC_API_KEY
  CLAUDE_API_KEY
  GEMINI_API_KEY
  GROQ_API_KEY
  OPENROUTER_API_KEY
)
has_provider=0
for key in "${provider_keys[@]}"; do
  if [[ -n "$(value_for "$key")" ]]; then
    has_provider=1
    break
  fi
done
if (( has_provider == 0 )); then
  invalid+=("set at least one model provider key (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY)")
fi

distinct_pairs=(
  'DEPLAI_SERVICE_KEY:WS_TOKEN_SECRET'
  'DEPLAI_SERVICE_KEY:SESSION_SECRET'
  'DEPLAI_SERVICE_KEY:ADMIN_ACCESS_KEY'
  'WS_TOKEN_SECRET:SESSION_SECRET'
  'MYSQL_PASSWORD:MYSQL_ROOT_PASSWORD'
)
for pair in "${distinct_pairs[@]}"; do
  left="${pair%%:*}"
  right="${pair##*:}"
  left_value="$(value_for "$left")"
  right_value="$(value_for "$right")"
  if [[ -n "$left_value" && "$left_value" == "$right_value" ]]; then
    invalid+=("$left and $right must differ")
  fi
done

if (( ${#invalid[@]} > 0 )); then
  printf 'Deployment preflight failed:\n' >&2
  printf '  - %s\n' "${invalid[@]}" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  printf 'Deployment preflight failed: Docker Compose is required on the deployment host.\n' >&2
  exit 1
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --quiet
printf 'Deployment preflight passed.\n'
