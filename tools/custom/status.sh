#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

CURRENT="$(git branch --show-current)"
AHEAD="$(git rev-list --count upstream/main..custom-main 2>/dev/null || echo 0)"
BEHIND="$(git rev-list --count custom-main..upstream/main 2>/dev/null || echo 0)"

echo "branch: $CURRENT"
echo "custom commits ahead of upstream/main: $AHEAD"
echo "upstream commits not yet rebased: $BEHIND"

echo "\nRecent custom commits:"
git --no-pager log --oneline --max-count=10 upstream/main..custom-main || true
