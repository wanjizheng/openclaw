#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
git -C "$ROOT_DIR" status --short --branch
cat "$ROOT_DIR/tools/custom/upstream-base.json"
