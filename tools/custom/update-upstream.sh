#!/usr/bin/env bash
# update-upstream.sh — Sync custom-main with upstream/main via rebase
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

# Ensure clean worktree
if [[ -n "$(git status --porcelain)" ]]; then
  log "stashing dirty changes"
  git stash push -m "update-upstream auto-stash $(date -u +%Y%m%d-%H%M%S)"
  STASHED=1
else
  STASHED=0
fi

# Switch to custom-main
if [[ "$(git branch --show-current)" != "custom-main" ]]; then
  log "switching to custom-main"
  git checkout custom-main --quiet
fi

log "fetch upstream"
git fetch upstream --quiet

# Check if rebase is needed
if git merge-base --is-ancestor upstream/main custom-main; then
  log "custom-main already contains upstream/main — no rebase needed"
else
  log "rebase custom-main onto upstream/main"
  if ! git rebase upstream/main --quiet; then
    log "ERROR: rebase failed — aborting"
    git rebase --abort 2>/dev/null || true
    # Restore stash if we made one
    (( STASHED )) && git stash pop --quiet
    exit 1
  fi
fi

# Restore stash
(( STASHED )) && { log "restoring stash"; git stash pop --quiet; }

AHEAD="$(git rev-list --count upstream/main..custom-main)"
log "done — custom-main has $AHEAD custom commit(s) on top of upstream/main"
git --no-pager log --oneline --decorate --max-count=8
