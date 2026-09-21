#!/usr/bin/env bash
# Install only the external local lease sweeper, not a public execution API.
set -euo pipefail
[[ $(id -u) == 0 && $(uname -s) == Linux ]] || exit 1
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -d -m 0700 /var/lib/deplai-preview-runtime
install -d -m 0755 /opt/deplai-preview-runtime
install -m 0644 "$source_dir/runtime.py" "$source_dir/contracts.py" "$source_dir/gc.py" /opt/deplai-preview-runtime/
install -m 0644 "$source_dir/deplai-preview-runtime-gc.service" "$source_dir/deplai-preview-runtime-gc.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now deplai-preview-runtime-gc.timer
