#!/usr/bin/env bash
# Check the running production container, including its actual env and network.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
docker compose --env-file "${1:-$SCRIPT_DIR/.env}" \
  -f "$REPO_DIR/docker-compose.production.yml" \
  exec -T agentic-layer python - < "$SCRIPT_DIR/check-scan-storage.py"
