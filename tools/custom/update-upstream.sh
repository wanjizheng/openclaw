#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [ "$(git branch --show-current)" != "custom-main" ]; then
  echo "[info] switching to custom-main"
  git checkout custom-main
fi

echo "[step] fetch upstream"
git fetch upstream --tags --prune

LATEST_TAG="$({ git tag -l 'v*' | grep -E '^v[0-9]+' | grep -Evi 'alpha|beta|rc|pre' | sort -V | tail -n 1; } || true)"
if [[ -z "$LATEST_TAG" ]]; then
  echo "[error] no stable upstream tag found"
  exit 1
fi

echo "[info] latest stable tag: $LATEST_TAG"

if git merge-base --is-ancestor "$LATEST_TAG" custom-main; then
  echo "[ok] custom-main already contains $LATEST_TAG"
else
  echo "[step] merge $LATEST_TAG into custom-main (preserve custom history)"
  if ! git merge --no-edit --no-ff -X ours "$LATEST_TAG"; then
    echo "[error] merge failed; aborting"
    git merge --abort || true
    exit 1
  fi
fi

echo "[ok] update complete"
git --no-pager log --oneline --decorate --max-count=8
