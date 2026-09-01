#!/usr/bin/env bash
set -euo pipefail

INSTANCE_ID="${1:-}"
LOCAL_PORT="${2:-3100}"
REMOTE_PORT="${3:-3100}"

if [[ -z "$INSTANCE_ID" ]]; then
  echo "Usage: $0 <instance-id> [local-port] [remote-port]"
  exit 1
fi

aws ssm start-session \
  --target "$INSTANCE_ID" \
  --document-name AWS-StartPortForwardingSession \
  --parameters "{\"portNumber\":[\"$REMOTE_PORT\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}"
