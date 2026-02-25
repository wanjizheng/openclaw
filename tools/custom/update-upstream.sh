#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [ "$(git branch --show-current)" != "custom-main" ]; then
  echo "[info] switching to custom-main"
  git checkout custom-main
fi

echo "[step] fetch upstream"
git fetch upstream

echo "[step] rebase custom-main onto upstream/main"
git rebase upstream/main

echo "[ok] update complete"
git --no-pager log --oneline --decorate --max-count=8
