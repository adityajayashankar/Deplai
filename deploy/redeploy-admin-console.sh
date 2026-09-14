#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
compose=(docker compose --env-file deploy/.env -f docker-compose.production.yml)
"${compose[@]}" build admin-console
# No service ports are published by run. Existing MySQL must already be healthy.
"${compose[@]}" run --rm --no-deps -T admin-console npm run migrate
"${compose[@]}" up -d --no-deps --wait admin-console
