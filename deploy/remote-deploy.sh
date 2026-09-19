#!/usr/bin/env bash
# Deploy one already-reviewed repository commit on the existing EC2 host.
# The caller must fetch this script from the target commit before executing it.
set -euo pipefail

commit="${1:-}"
if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Deployment failed: expected a full 40-character commit SHA.\n' >&2
  exit 2
fi

repo_dir="${DEPLOY_APP_DIR:-$(pwd)}"
compose_file="$repo_dir/docker-compose.production.yml"
env_file="$repo_dir/deploy/.env"

cd -- "$repo_dir"
if [[ ! -d .git || ! -f "$compose_file" || ! -f "$env_file" ]]; then
  printf 'Deployment failed: expected a Git checkout, production Compose file, and deploy/.env in %s.\n' "$repo_dir" >&2
  exit 2
fi

if ! git diff --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  # deploy/.env is intentionally untracked; all other untracked files are unsafe
  # because they could enter a Docker build unexpectedly.
  unexpected="$(git ls-files --others --exclude-standard | grep -v '^deploy/\.env$' || true)"
  if [[ -n "$unexpected" ]]; then
    printf 'Deployment failed: tracked or unexpected untracked files exist in the deployment checkout.\n' >&2
    exit 2
  fi
fi

if ! git cat-file -e "$commit^{commit}" 2>/dev/null; then
  printf 'Deployment failed: commit was not fetched into the deployment checkout.\n' >&2
  exit 2
fi
git checkout --detach "$commit" >/dev/null

# Keep deploy/.env from the host. The production preflight validates its shape,
# secret separation, and Compose interpolation without printing secret values.
bash deploy/preflight.sh deploy/.env

compose=(docker compose --env-file deploy/.env -f "$compose_file")
"${compose[@]}" build --pull connector agentic-layer customization uiux-agent admin-console
"${compose[@]}" up -d --remove-orphans --wait --wait-timeout 1800
"${compose[@]}" ps

# This check reports only a safe storage category and confirms MongoDB/index
# availability for the scan path. It never prints the connection string.
bash deploy/check-scan-storage.sh

printf 'Deployment completed for %s.\n' "$commit"
