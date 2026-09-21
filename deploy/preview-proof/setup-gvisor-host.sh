#!/usr/bin/env bash
# Dedicated Ubuntu/Debian proof host only. Does not alter production Compose.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root on the dedicated Linux proof host.' >&2; exit 1; }
[[ $(uname -s) == Linux ]] || exit 1
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg docker.io docker-cli nodejs npm git openssl
key_file=$(mktemp)
trap 'rm -f -- "$key_file"' EXIT
curl --fail --silent --show-error https://gvisor.dev/archive.key -o "$key_file"
gpg --batch --yes --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg "$key_file"
printf 'deb [arch=%s signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main\n' "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/gvisor.list
apt-get update
apt-get install -y --no-install-recommends runsc
proof_source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
python3 "$proof_source/configure_gvisor.py"
systemctl enable --now docker
systemctl reload docker
install -d -m 0700 /var/lib/deplai-preview-proof
install -d -m 0755 /opt/deplai-preview-proof
install -m 0644 "$proof_source"/*.py /opt/deplai-preview-proof/
install -m 0644 "$proof_source"/deplai-preview-proof-gc.service "$proof_source"/deplai-preview-proof-gc.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now deplai-preview-proof-gc.timer
runsc --version
docker info --format '{{json .Runtimes}}'
