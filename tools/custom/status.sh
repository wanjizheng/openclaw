#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

CURRENT="$(git branch --show-current)"
LATEST_TAG="$({ git tag -l 'v*' | grep -E '^v[0-9]+' | grep -Evi 'alpha|beta|rc|pre' | sort -V | tail -n 1; } || true)"

if [[ -z "$LATEST_TAG" ]]; then
	echo "[error] no stable upstream tag found"
	exit 1
fi

MAINLINE_CUSTOM_COUNT="$(git rev-list --count --first-parent --no-merges "${LATEST_TAG}..custom-main" ^upstream/main 2>/dev/null || echo 0)"
UPSTREAM_DIVERGENCE_AHEAD="$(git rev-list --count upstream/main..custom-main 2>/dev/null || echo 0)"
UPSTREAM_DIVERGENCE_BEHIND="$(git rev-list --count custom-main..upstream/main 2>/dev/null || echo 0)"

echo "branch: $CURRENT"
echo "latest stable tag: $LATEST_TAG"
echo "custom commits since latest tag (mainline, excluding upstream): $MAINLINE_CUSTOM_COUNT"
echo "divergence vs upstream/main -> ahead: $UPSTREAM_DIVERGENCE_AHEAD, behind: $UPSTREAM_DIVERGENCE_BEHIND"

printf '\nRecent custom commits (mainline):\n'
git --no-pager log --first-parent --no-merges --oneline --max-count=10 "${LATEST_TAG}..custom-main" ^upstream/main || true
