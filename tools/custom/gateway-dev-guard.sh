#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ALLOW="${OPENCLAW_ALLOW_DEV_GATEWAY:-}"

if systemctl --user is-active --quiet openclaw-gateway.service; then
  if [[ "$ALLOW" != "1" ]]; then
    echo "[custom] Refusing to start dev gateway while openclaw-gateway.service is active."
    echo "[custom] Stop prod first: systemctl --user stop openclaw-gateway.service"
    echo "[custom] Or override once: OPENCLAW_ALLOW_DEV_GATEWAY=1 pnpm gateway:dev"
    exit 1
  fi
fi

export OPENCLAW_SKIP_CHANNELS=1
export CLAWDBOT_SKIP_CHANNELS=1

if [[ "${1:-}" == "--reset" ]]; then
  exec node scripts/run-node.mjs --dev gateway --reset
fi

exec node scripts/run-node.mjs --dev gateway
