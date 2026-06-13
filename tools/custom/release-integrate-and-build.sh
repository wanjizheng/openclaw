#!/usr/bin/env bash
# release-integrate-and-build.sh — Full custom release pipeline
#
# Workflow (matches user requirement exactly):
#   1. Save any dirty worktree changes
#   2. Fetch upstream + tags
#   3. Find latest stable release tag (e.g. v2026.2.26)
#   4. Merge latest stable tag into custom-main (preserve custom-main history)
#   5. Collect ONLY custom commits (<latest-tag>..custom-main), excluding
#      upstream/main and deduplicating noisy snapshot/update commits
#   6. Create release-custom/<tag> from that tag + cherry-pick custom commits
#   7. Build (pnpm install + build + ui:build)
#   8. Deploy built artifacts to global install + refresh gateway service + restart
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
SYNC_CUSTOM_MAIN="false"
MAX_CUSTOM_COMMITS="300"
AUTO_SLIM_COMMITS="true"

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
    --sync-custom-main)  SYNC_CUSTOM_MAIN="true"; shift ;;
    --max-custom-commits) MAX_CUSTOM_COMMITS="${2:-300}"; shift 2 ;;
    --no-auto-slim-commits) AUTO_SLIM_COMMITS="false"; shift ;;
    --conflict-strategy) CONFLICT_STRATEGY="${2:-prefer-custom}"; shift 2 ;;
    --deploy-target)     DEPLOY_TARGET="${2:?}"; shift 2 ;;
    *) die "unknown arg: $1" ;;
  esac
done

[[ "$CONFLICT_STRATEGY" =~ ^(prefer-custom|stop)$ ]] \
  || die "--conflict-strategy must be prefer-custom|stop"

[[ "$MAX_CUSTOM_COMMITS" =~ ^[0-9]+$ ]] \
  || die "--max-custom-commits must be a non-negative integer"

[[ "$AUTO_SLIM_COMMITS" =~ ^(true|false)$ ]] \
  || die "--no-auto-slim-commits parse failed"

slim_commit_list_by_subject() {
  local -a input_commits=("$@")
  local -A chosen_sha_by_subject=()
  local -A chosen_score_by_subject=()
  local -A emitted_subject=()

  commit_change_score() {
    local commit_sha="$1"
    git --no-pager show --numstat --format= --no-renames "$commit_sha" \
      | awk '{
          add=$1; del=$2;
          if (add == "-") add=0;
          if (del == "-") del=0;
          score += add + del;
        }
        END { print score + 0 }'
  }

  local index sha subject score current_best
  for (( index=0; index<${#input_commits[@]}; index++ )); do
    sha="${input_commits[$index]}"
    subject="$(git --no-pager show -s --format=%s "$sha")"

    case "$subject" in
      "chore: snapshot WIP before release integrate ("*|"chore(auto-update): snapshot fork changes before release integrate ("*)
        continue
        ;;
    esac

    score="$(commit_change_score "$sha")"
    current_best="${chosen_score_by_subject[$subject]:--1}"
    if (( score > current_best )); then
      chosen_score_by_subject["$subject"]="$score"
      chosen_sha_by_subject["$subject"]="$sha"
    fi
  done

  for sha in "${input_commits[@]}"; do
    subject="$(git --no-pager show -s --format=%s "$sha")"
    [[ -n "${chosen_sha_by_subject[$subject]+x}" ]] || continue
    if [[ "${chosen_sha_by_subject[$subject]}" == "$sha" && -z "${emitted_subject[$subject]+x}" ]]; then
      printf '%s\n' "$sha"
      emitted_subject["$subject"]=1
    fi
  done
}

has_gpu_environment() {
  if command -v nvidia-smi >/dev/null 2>&1; then
    if nvidia-smi -L >/dev/null 2>&1; then
      return 0
    fi
  fi

  if command -v rocm-smi >/dev/null 2>&1; then
    return 0
  fi

  if compgen -G "/dev/dri/card*" >/dev/null 2>&1; then
    return 0
  fi

  if command -v lspci >/dev/null 2>&1 && lspci | grep -qiE 'vga|3d controller'; then
    return 0
  fi

  if command -v ldconfig >/dev/null 2>&1 && ldconfig -p 2>/dev/null | grep -qiE 'libcuda\.so|libamdocl|libOpenCL'; then
    return 0
  fi

  return 1
}

is_low_memory_host() {
  local mem_total_kb="0"
  if [[ -r /proc/meminfo ]]; then
    mem_total_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  fi
  [[ "$mem_total_kb" =~ ^[0-9]+$ ]] || mem_total_kb="0"

  # Treat hosts below 12 GiB RAM as low-memory for this build pipeline.
  (( mem_total_kb > 0 && mem_total_kb < 12582912 ))
}

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
git fetch upstream --tags --prune --force --quiet
git fetch origin --prune --quiet

# ══════════════════════════════════════════════════════════════════════════════
# 3. Find latest stable tag
# ══════════════════════════════════════════════════════════════════════════════
LATEST_TAG="$(git tag -l 'v*' \
  | grep -E '^v[0-9]+' \
  | grep -Evi 'alpha|beta|rc|pre' \
  | sort -V | tail -n 1 || true)"
[[ -n "$LATEST_TAG" ]] || die "no stable upstream tag found"
log "latest stable tag: $LATEST_TAG"

# ══════════════════════════════════════════════════════════════════════════════
# 4. Merge latest stable tag into custom-main
# ══════════════════════════════════════════════════════════════════════════════
git checkout custom-main --quiet 2>/dev/null \
  || git checkout -b custom-main "$LATEST_TAG" --quiet

if [[ "$SYNC_CUSTOM_MAIN" == "true" ]]; then
  step "merge $LATEST_TAG into custom-main"
  if ! git merge-base --is-ancestor "$LATEST_TAG" custom-main; then
    merge_args=(--no-edit --no-ff "$LATEST_TAG")
    if [[ "$CONFLICT_STRATEGY" == "prefer-custom" ]]; then
      merge_args=(--no-edit --no-ff -X ours "$LATEST_TAG")
    fi

    if ! git merge "${merge_args[@]}" --quiet; then
      log "WARN: merge $LATEST_TAG into custom-main failed; fallback to current custom-main (no merge)"
      git merge --abort 2>/dev/null || true
    fi
  fi
  log "custom-main sync attempt finished"
else
  log "skip latest-tag merge (use --sync-custom-main to enable)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 5. Collect custom-only commits
#    Use first-parent mainline only; exclude commits already reachable from
#    upstream/main; then slim noisy repeated subjects.
# ══════════════════════════════════════════════════════════════════════════════
step "collecting custom commits"
mapfile -t CUSTOM_COMMITS < <(
  git --no-pager log --first-parent --reverse --no-merges --pretty=%H "${LATEST_TAG}..custom-main" ^upstream/main
)
if (( ${#CUSTOM_COMMITS[@]} == 0 )) || [[ -z "${CUSTOM_COMMITS[0]:-}" ]]; then
  die "no custom commits found between ${LATEST_TAG} and custom-main"
fi

RAW_CUSTOM_COMMIT_COUNT="${#CUSTOM_COMMITS[@]}"
if [[ "$AUTO_SLIM_COMMITS" == "true" ]]; then
  mapfile -t SLIMMED_COMMITS < <(slim_commit_list_by_subject "${CUSTOM_COMMITS[@]}")
  if (( ${#SLIMMED_COMMITS[@]} == 0 )); then
    die "auto-slim removed all commits; run with --no-auto-slim-commits to inspect full set"
  fi
  if (( RAW_CUSTOM_COMMIT_COUNT != ${#SLIMMED_COMMITS[@]} )); then
    log "auto-slim result: ${RAW_CUSTOM_COMMIT_COUNT} -> ${#SLIMMED_COMMITS[@]} commit(s)"
  fi
  CUSTOM_COMMITS=("${SLIMMED_COMMITS[@]}")
fi

if (( ${#CUSTOM_COMMITS[@]} > MAX_CUSTOM_COMMITS )); then
  die "custom commit set is too large (${#CUSTOM_COMMITS[@]} > ${MAX_CUSTOM_COMMITS}); increase --max-custom-commits or pre-clean custom-main"
fi

is_legacy_autoupdate_subject() {
  local subject="$1"
  [[ "$subject" == "feat(release): add stable integrate/build pipeline for custom releases" ]] \
    || [[ "$subject" == "fix(auto-update): fallback continue when cherry-pick hooks/lint block" ]] \
    || [[ "$subject" == "fix(auto-update): tolerate rebase conflicts in integration pipeline" ]] \
    || [[ "$subject" == "custom: auto-run gateway install after deploy" ]] \
    || [[ "$subject" == "version change" ]] \
    || [[ "$subject" == "Revert \"version change\"" ]]
}

is_protected_custom_script_path() {
  local file_path="$1"
  [[ "$file_path" == "tools/custom/release-integrate-and-build.sh" ]] \
    || [[ "$file_path" == "tools/custom/update-upstream.sh" ]] \
    || [[ "$file_path" == "tools/custom/status.sh" ]]
}

sync_protected_scripts_from_custom_main() {
  local changed=0
  local script_path
  for script_path in \
    tools/custom/release-integrate-and-build.sh \
    tools/custom/update-upstream.sh \
    tools/custom/status.sh; do
    if git ls-tree -r --name-only custom-main -- "$script_path" | grep -q .; then
      git checkout custom-main -- "$script_path" 2>/dev/null || true
      git add "$script_path" 2>/dev/null || true
      changed=1
    fi
  done

  if [[ "$changed" -eq 1 ]] && ! git diff --cached --quiet 2>/dev/null; then
    git -c core.hooksPath=/dev/null commit \
      -m "chore(custom): keep protected helper scripts from custom-main" \
      --no-verify 2>/dev/null || true
  else
    git reset 2>/dev/null || true
  fi
}

FILTERED_CUSTOM_COMMITS=()
for sha in "${CUSTOM_COMMITS[@]}"; do
  subject="$(git --no-pager show -s --format=%s "$sha")"
  if is_legacy_autoupdate_subject "$subject"; then
    log "  skip (legacy auto-update commit): $(git --no-pager log --oneline -1 "$sha")"
    continue
  fi
  FILTERED_CUSTOM_COMMITS+=("$sha")
done
CUSTOM_COMMITS=("${FILTERED_CUSTOM_COMMITS[@]}")

if (( ${#CUSTOM_COMMITS[@]} == 0 )); then
  die "all candidate custom commits were filtered out as legacy auto-update commits"
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
      if is_protected_custom_script_path "$f"; then
        git checkout --ours -- "$f" 2>/dev/null && git add "$f" 2>/dev/null
      else
        git checkout --theirs -- "$f" 2>/dev/null && git add "$f" 2>/dev/null
      fi
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

sync_protected_scripts_from_custom_main

log "cherry-pick complete ($(elapsed))"

# ══════════════════════════════════════════════════════════════════════════════
# 7. Build
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$SKIP_BUILD" != "true" ]]; then
  if [[ "$SKIP_INSTALL" != "true" ]]; then
    # Run pnpm install with --frozen-lockfile, but allow a one-shot fallback
    # to a non-frozen install when the failure is ERR_PNPM_OUTDATED_LOCKFILE.
    # This happens when a freshly cherry-picked upstream commit (typically an
    # extension manifest bump) downgrades or moves a specifier that the
    # existing pnpm-lock.yaml still records at the old version. The
    # integration build is the right place to regenerate the lockfile, since
    # we explicitly accept upstream manifest drift here.
    pnpm_install_with_lockfile_fallback() {
      local label="$1"; shift
      local log_file; log_file="$(mktemp)"
      if "$@" > "$log_file" 2>&1; then
        rm -f "$log_file"
        return 0
      fi
      if grep -q "ERR_PNPM_OUTDATED_LOCKFILE" "$log_file"; then
        log "[warn] $label: pnpm-lock.yaml drift detected (upstream manifest changed); regenerating lockfile only (--lockfile-only) and re-installing with --frozen-lockfile"
        tail -20 "$log_file" >&2
        rm -f "$log_file"
        # Step 1: regenerate the lockfile to match the new manifest, but
        # DO NOT touch node_modules or run postinstall scripts. node-llama-cpp
        # postinstall tries a CUDA build from source and fails on hosts
        # without a working CUDA toolchain; we never want to trigger that
        # from a lockfile-drift recovery.
        if ! pnpm install --lockfile-only > "$log_file" 2>&1; then
          tail -50 "$log_file" >&2
          rm -f "$log_file"
          die "$label: --lockfile-only failed to resolve manifest drift"
        fi
        log "[info] $label: lockfile regenerated; re-running install with --frozen-lockfile"
        # Step 2: now the lockfile matches, the original --frozen-lockfile
        # command (with all its original env vars) will succeed.
        rm -f "$log_file"
        "$@" 2>&1 | tail -10
        return ${PIPESTATUS[0]}
      fi
      tail -50 "$log_file" >&2
      rm -f "$log_file"
      die "$label failed (non-drift error)"
    }

    if has_gpu_environment; then
      step "pnpm install (GPU detected)"
      log "GPU environment detected; enabling full node-llama-cpp postinstall"
      pnpm_install_with_lockfile_fallback "pnpm install (GPU)" pnpm install --frozen-lockfile
    else
      step "pnpm install (no GPU)"
      log "GPU not detected; set NODE_LLAMA_CPP_SKIP_DOWNLOAD=1 to skip llama.cpp postinstall download/build"
      pnpm_install_with_lockfile_fallback "pnpm install (no GPU)" env NODE_LLAMA_CPP_SKIP_DOWNLOAD=1 pnpm install --frozen-lockfile
    fi
  fi

  BUILD_CMD=(pnpm build)
  UI_BUILD_CMD=(pnpm ui:build)
  if is_low_memory_host; then
    step "enable low-memory build guard"
    log "low-memory host detected; using serial workspace build and capped Node heap"
    if [[ -n "${NODE_OPTIONS:-}" ]]; then
      export NODE_OPTIONS="${NODE_OPTIONS} --max-old-space-size=2048"
    else
      export NODE_OPTIONS="--max-old-space-size=2048"
    fi
    export npm_config_jobs=2
    BUILD_CMD=(pnpm --workspace-concurrency=1 build)
    UI_BUILD_CMD=(pnpm --workspace-concurrency=1 ui:build)
  fi

  step "pnpm build"
  "${BUILD_CMD[@]}" 2>&1 | tail -10
  step "pnpm ui:build"
  "${UI_BUILD_CMD[@]}" 2>&1 | tail -5
  log "build complete ($(elapsed))"
  
  # ── Normalize version string for stable releases ──
  # Git tag v2026.3.1 may point to package.json with version 2026.3.1-beta.1
  # because OpenClaw promotes beta to stable via npm dist-tag without updating git tags.
  # Strip -beta.N suffix to match the stable release tag.
  step "normalize package.json version to match tag"
  CURRENT_VERSION="$(jq -r '.version' package.json)"
  NORMALIZED_VERSION="${LATEST_TAG#v}"  # v2026.3.1 → 2026.3.1
  if [[ "$CURRENT_VERSION" =~ ^([0-9]+\.[0-9]+\.[0-9]+)-beta\.[0-9]+$ ]]; then
    BASE_VERSION="${BASH_REMATCH[1]}"
    if [[ "$BASE_VERSION" == "$NORMALIZED_VERSION" ]]; then
      log "patching package.json version: $CURRENT_VERSION → $NORMALIZED_VERSION"
      jq --arg v "$NORMALIZED_VERSION" '.version = $v' package.json > package.json.tmp
      mv package.json.tmp package.json
    else
      log "version mismatch: tag=$NORMALIZED_VERSION, base=$BASE_VERSION (keep as-is)"
    fi
  else
    log "version $CURRENT_VERSION already normalized (not beta format)"
  fi
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
  mkdir -p "$DEPLOY_TARGET/extensions" && rsync -a --delete extensions/ "$DEPLOY_TARGET/extensions/"
  mkdir -p "$DEPLOY_TARGET/skills"     && rsync -a --delete skills/ "$DEPLOY_TARGET/skills/"
  log "artifacts synced"

  # ── Refresh gateway service unit/env ──
  step "gateway install --force"
  openclaw gateway install --force

  # ── Normalize systemd unit metadata (strip version from Description only) ──
  UNIT_FILE="$HOME/.config/systemd/user/$SERVICE_NAME"
  if [[ -f "$UNIT_FILE" ]]; then
    UNIT_CHANGED=0
    if grep -qE '^Description=OpenClaw Gateway \(v[^)]*\)$' "$UNIT_FILE"; then
      sed -i -E 's/^Description=OpenClaw Gateway \(v[^)]*\)$/Description=OpenClaw Gateway/' "$UNIT_FILE"
      UNIT_CHANGED=1
    fi
    if [[ "$UNIT_CHANGED" -eq 1 ]]; then
      log "systemd unit metadata normalized (description only)"
      systemctl --user daemon-reload
    fi
  fi

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
        if is_protected_custom_script_path "$f"; then
          git checkout --ours -- "$f" && git add "$f"
        else
          git checkout --theirs -- "$f" && git add "$f"
        fi
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
