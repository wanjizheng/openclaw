#!/usr/bin/env bash
# release-integrate-and-build.sh — Full custom release pipeline
#
# Workflow (matches user requirement exactly):
#   1. Save any dirty worktree changes
#   2. Fetch upstream + tags
#   3. Rebase custom-main onto upstream/main (keep only custom commits on top)
#   4. Find latest stable release tag (e.g. v2026.2.26)
#   5. Collect ONLY the custom commits (upstream/main..custom-main)
#   6. Create release-custom/<tag> from that tag + cherry-pick custom commits
#   7. Build (pnpm install + build + ui:build)
#   8. Deploy built artifacts to global install + restart gateway
#   9. Merge release-custom/<tag> back into custom-main
#  10. Push everything & switch to custom-main
#
# Speed note: Only your ~11 custom commits get cherry-picked (not hundreds).
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# ── Configuration ─────────────────────────────────────────────────────────────
DEPLOY_TARGET="/home/linuxbrew/.linuxbrew/lib/node_modules/openclaw"
BACKUP_DIR="/home/wanjizheng/openclaw-install-backups"
SERVICE_NAME="openclaw-gateway.service"
MAX_BACKUPS=3

# ── Defaults ──────────────────────────────────────────────────────────────────
JSON_MODE="false"
PUSH="true"
SKIP_INSTALL="false"
SKIP_BUILD="false"
SKIP_DEPLOY="false"
CONFLICT_STRATEGY="prefer-custom"

# ── Helpers ───────────────────────────────────────────────────────────────────
log()  { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die()  { log "ERROR: $*"; exit 1; }
step() { log "── $* ──"; }
elapsed() { printf '%dm%ds' $(( SECONDS/60 )) $(( SECONDS%60 )); }

# ── Arg parsing ───────────────────────────────────────────────────────────────
while (( $# )); do
  case "$1" in
    --json)              JSON_MODE="true"; shift ;;
    --no-push)           PUSH="false"; shift ;;
    --skip-install)      SKIP_INSTALL="true"; shift ;;
    --skip-build)        SKIP_BUILD="true"; shift ;;
    --skip-deploy)       SKIP_DEPLOY="true"; shift ;;
    --conflict-strategy) CONFLICT_STRATEGY="${2:-prefer-custom}"; shift 2 ;;
    --deploy-target)     DEPLOY_TARGET="${2:?}"; shift 2 ;;
    *) die "unknown arg: $1" ;;
  esac
done

[[ "$CONFLICT_STRATEGY" =~ ^(prefer-custom|stop)$ ]] \
  || die "--conflict-strategy must be prefer-custom|stop"

SECONDS=0
ORIGINAL_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"

# ══════════════════════════════════════════════════════════════════════════════
# 1. Save dirty worktree
# ══════════════════════════════════════════════════════════════════════════════
if [[ -n "$(git status --porcelain)" ]]; then
  branch="$(git rev-parse --abbrev-ref HEAD)"
  [[ "$branch" == "HEAD" ]] && die "dirty worktree on detached HEAD"
  step "auto-commit dirty changes on $branch"
  git add -A
  if ! git diff --cached --quiet; then
    git commit -m "chore: snapshot WIP before release integrate ($(date -u +%Y%m%d-%H%M%S))" --no-verify
    if [[ "$PUSH" == "true" ]]; then
      git push origin "$branch" --force-with-lease 2>/dev/null || true
    fi
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# 2. Fetch upstream + tags
# ══════════════════════════════════════════════════════════════════════════════
step "fetch upstream + origin"
git fetch upstream --tags --prune --quiet
git fetch origin --prune --quiet

# ══════════════════════════════════════════════════════════════════════════════
# 3. Rebase custom-main onto upstream/main
# ══════════════════════════════════════════════════════════════════════════════
step "rebase custom-main onto upstream/main"
git checkout custom-main --quiet 2>/dev/null \
  || git checkout -b custom-main upstream/main --quiet

if ! git merge-base --is-ancestor upstream/main custom-main; then
  # Need rebase: custom-main is behind upstream/main
  if ! git rebase upstream/main --quiet; then
    git rebase --abort 2>/dev/null || true
    die "rebase custom-main onto upstream/main failed — resolve manually then re-run"
  fi
fi
log "custom-main is up-to-date with upstream/main"

# ══════════════════════════════════════════════════════════════════════════════
# 4. Find latest stable tag
# ══════════════════════════════════════════════════════════════════════════════
LATEST_TAG="$(git tag -l 'v*' \
  | grep -E '^v[0-9]+' \
  | grep -Evi 'alpha|beta|rc|pre' \
  | sort -V | tail -n 1 || true)"
[[ -n "$LATEST_TAG" ]] || die "no stable upstream tag found"
log "latest stable tag: $LATEST_TAG"

# ══════════════════════════════════════════════════════════════════════════════
# 5. Collect custom-only commits
#    These are the commits ABOVE upstream/main on custom-main.
#    After rebase, this is exactly your custom work — typically ~11 commits,
#    NOT hundreds. This is why the new script is fast.
# ══════════════════════════════════════════════════════════════════════════════
step "collecting custom commits"
mapfile -t CUSTOM_COMMITS < <(
  git --no-pager log --reverse --no-merges --pretty=%H upstream/main..custom-main
)
if (( ${#CUSTOM_COMMITS[@]} == 0 )) || [[ -z "${CUSTOM_COMMITS[0]:-}" ]]; then
  die "no custom commits found between upstream/main and custom-main"
fi
log "found ${#CUSTOM_COMMITS[@]} custom commit(s) to cherry-pick:"
for sha in "${CUSTOM_COMMITS[@]}"; do
  log "  $(git --no-pager log --oneline -1 "$sha")"
done

# ══════════════════════════════════════════════════════════════════════════════
# 6. Create release branch from tag + cherry-pick custom commits
# ══════════════════════════════════════════════════════════════════════════════
TARGET_BRANCH="release-custom/${LATEST_TAG}"
step "create $TARGET_BRANCH from $LATEST_TAG"
git checkout -B "$TARGET_BRANCH" "$LATEST_TAG" --quiet

cherry_pick_one() {
  local sha="$1"
  local short
  short="$(git --no-pager log --oneline -1 "$sha")"

  # Already an ancestor of HEAD (tag already contains it)
  if git merge-base --is-ancestor "$sha" HEAD 2>/dev/null; then
    log "  skip (ancestor): $short"
    return 0
  fi

  # Try clean cherry-pick (--no-commit to detect empty results)
  if git cherry-pick -x --no-commit "$sha" 2>/dev/null; then
    if git diff --cached --quiet 2>/dev/null; then
      log "  skip (empty):    $short"
      git reset --hard HEAD 2>/dev/null
      return 0
    fi
    HUSKY=0 LEFTHOOK=0 git -c core.hooksPath=/dev/null \
      commit -C "$sha" --no-verify 2>/dev/null
    log "  applied:         $short"
    return 0
  fi

  # ── Conflict handling ──
  if [[ "$CONFLICT_STRATEGY" == "stop" ]]; then
    die "conflict on $short — resolve then: git cherry-pick --continue"
  fi

  log "  conflict:        $short — auto-resolving (prefer custom)"
  local conflicted
  conflicted="$(git diff --name-only --diff-filter=U 2>/dev/null || true)"
  if [[ -n "$conflicted" ]]; then
    while IFS= read -r f; do
      [[ -n "$f" ]] || continue
      git checkout --theirs -- "$f" 2>/dev/null && git add "$f" 2>/dev/null
    done <<< "$conflicted"
  fi
  # Stage any remaining non-conflicting changes
  git add -A 2>/dev/null || true

  if git diff --cached --quiet 2>/dev/null; then
    log "  skip (empty after resolve): $short"
    git reset --hard HEAD 2>/dev/null
    return 0
  fi

  HUSKY=0 LEFTHOOK=0 git -c core.hooksPath=/dev/null \
    commit -C "$sha" --no-verify 2>/dev/null \
    || { git reset --hard HEAD 2>/dev/null
         log "  WARN skip (commit failed): $short"; }
}

for sha in "${CUSTOM_COMMITS[@]}"; do
  cherry_pick_one "$sha"
done
log "cherry-pick complete ($(elapsed))"

# ══════════════════════════════════════════════════════════════════════════════
# 7. Build
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$SKIP_BUILD" != "true" ]]; then
  if [[ "$SKIP_INSTALL" != "true" ]]; then
    step "pnpm install"
    pnpm install --frozen-lockfile 2>&1 | tail -5
  fi
  step "pnpm build"
  pnpm build 2>&1 | tail -10
  step "pnpm ui:build"
  pnpm ui:build 2>&1 | tail -5
  log "build complete ($(elapsed))"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 8. Deploy + restart gateway
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$SKIP_DEPLOY" != "true" ]]; then
  step "deploy to $DEPLOY_TARGET"

  # ── Backup current install ──
  mkdir -p "$BACKUP_DIR"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  BACKUP_FILE="$BACKUP_DIR/openclaw-pre-${LATEST_TAG}-${STAMP}.tar.gz"
  if [[ -d "$DEPLOY_TARGET/dist" ]]; then
    log "backup → $BACKUP_FILE"
    tar czf "$BACKUP_FILE" \
      -C "$(dirname "$DEPLOY_TARGET")" \
      "$(basename "$DEPLOY_TARGET")/dist" \
      "$(basename "$DEPLOY_TARGET")/openclaw.mjs" \
      "$(basename "$DEPLOY_TARGET")/package.json" \
      2>/dev/null || log "WARN: backup tar had warnings (non-fatal)"
    # Rotate: keep only last N backups
    ls -1t "$BACKUP_DIR"/openclaw-pre-*.tar.gz 2>/dev/null \
      | tail -n +$(( MAX_BACKUPS + 1 )) | xargs -r rm -f
  fi

  # ── Sync built artifacts ──
  log "syncing dist/, openclaw.mjs, package.json, extensions/, skills/"
  rsync -a --delete dist/ "$DEPLOY_TARGET/dist/"
  cp -f openclaw.mjs "$DEPLOY_TARGET/openclaw.mjs"
  cp -f package.json "$DEPLOY_TARGET/package.json"
  [[ -d "$DEPLOY_TARGET/extensions" ]] && rsync -a --delete extensions/ "$DEPLOY_TARGET/extensions/"
  [[ -d "$DEPLOY_TARGET/skills" ]]     && rsync -a --delete skills/ "$DEPLOY_TARGET/skills/"
  log "artifacts synced"

  # ── Restart gateway service ──
  step "restart $SERVICE_NAME"
  if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    systemctl --user restart "$SERVICE_NAME"
    sleep 3
    if systemctl --user is-active --quiet "$SERVICE_NAME"; then
      log "gateway restarted successfully"
    else
      log "WARN: gateway may have failed to start"
      log "  check: journalctl --user -u $SERVICE_NAME -n 40"
    fi
  else
    log "WARN: $SERVICE_NAME not running; skip restart"
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# 9. Merge release branch → custom-main, then switch to custom-main
# ══════════════════════════════════════════════════════════════════════════════
step "merge $TARGET_BRANCH → custom-main"
git checkout custom-main --quiet

# Check if merge is needed (release-custom might already be an ancestor)
if git merge-base --is-ancestor "$TARGET_BRANCH" custom-main 2>/dev/null; then
  log "custom-main already contains $TARGET_BRANCH — skip merge"
else
  if ! git merge "$TARGET_BRANCH" --no-edit --no-verify \
    -m "chore: merge $TARGET_BRANCH into custom-main" 2>/dev/null; then
    log "merge conflict — auto-resolving (prefer release-custom)"
    conflicted="$(git diff --name-only --diff-filter=U 2>/dev/null || true)"
    if [[ -n "$conflicted" ]]; then
      while IFS= read -r f; do
        [[ -n "$f" ]] || continue
        git checkout --theirs -- "$f" && git add "$f"
      done <<< "$conflicted"
    fi
    git commit --no-edit --no-verify 2>/dev/null || true
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# 10. Push + cleanup
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$PUSH" == "true" ]]; then
  step "push branches"
  git push origin custom-main --force-with-lease --quiet
  git push origin "$TARGET_BRANCH" --force-with-lease --quiet 2>/dev/null || true

  # Clean up stale auto-update/snapshot-* remote branches (leftovers from old script)
  while IFS= read -r ref; do
    [[ -n "$ref" ]] || continue
    local_name="${ref#origin/}"
    log "cleanup stale remote branch: $local_name"
    git push origin --delete "$local_name" 2>/dev/null || true
  done < <(git for-each-ref --format='%(refname:short)' refs/remotes/origin/auto-update/)
fi

# ══════════════════════════════════════════════════════════════════════════════
# Done — now on custom-main
# ══════════════════════════════════════════════════════════════════════════════
HEAD_SHA="$(git rev-parse --short HEAD)"
TOTAL="$(elapsed)"

if [[ "$JSON_MODE" == "true" ]]; then
  cat <<EOF
{"status":"ok","tag":"$LATEST_TAG","branch":"$TARGET_BRANCH","head":"$HEAD_SHA","elapsed":"$TOTAL","deployed":$([ "$SKIP_DEPLOY" = "true" ] && echo false || echo true),"customCommits":${#CUSTOM_COMMITS[@]}}
EOF
else
  log ""
  log "═══════════════════════════════════════════════════"
  log "  Release integration complete!"
  log "  tag:       $LATEST_TAG"
  log "  release:   $TARGET_BRANCH"
  log "  head:      $HEAD_SHA"
  log "  commits:   ${#CUSTOM_COMMITS[@]} custom"
  log "  elapsed:   $TOTAL"
  log "  deployed:  $([ "$SKIP_DEPLOY" = "true" ] && echo no || echo yes)"
  log "  branch:    custom-main (current)"
  log "═══════════════════════════════════════════════════"
fi
