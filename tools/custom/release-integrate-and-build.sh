#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

JSON_MODE="false"
PUSH_BRANCH="true"
SKIP_INSTALL="false"
CONFLICT_STRATEGY="prefer-custom"

log() {
  echo "$*" >&2
}

extract_commits_inline() {
  local log_file="CUSTOM_CHANGES.md"
  mapfile -t commits < <(
    awk '
      /^### / { in_commits=0; next }
      /^- Commits:/ {
        in_commits=1
        line=$0
        sub(/^- Commits:[[:space:]]*/, "", line)
        if (line != "") print line
        next
      }
      in_commits == 1 {
        if ($0 ~ /^  - /) {
          line=$0
          sub(/^  -[[:space:]]*/, "", line)
          if (line != "") print line
          next
        }
        if ($0 ~ /^- /) {
          in_commits=0
        }
      }
    ' "$log_file" \
      | tr ', ' '\n\n' \
      | sed '/^$/d' \
      | grep -E '^[0-9a-f]{7,40}$' \
      | awk '!seen[$0]++'
  )
  printf '%s\n' "${commits[@]:-}"
}

while (($#)); do
  case "$1" in
    --json)
      JSON_MODE="true"
      shift
      ;;
    --no-push)
      PUSH_BRANCH="false"
      shift
      ;;
    --skip-install)
      SKIP_INSTALL="true"
      shift
      ;;
    --conflict-strategy)
      CONFLICT_STRATEGY="${2:-prefer-custom}"
      shift 2
      ;;
    *)
      echo "[error] unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "$CONFLICT_STRATEGY" != "prefer-custom" && "$CONFLICT_STRATEGY" != "stop" ]]; then
  echo "[error] --conflict-strategy must be one of: prefer-custom|stop" >&2
  exit 1
fi

auto_commit_and_push_if_dirty() {
  if [[ -z "$(git status --porcelain)" ]]; then
    return 0
  fi

  local current_branch
  current_branch="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$current_branch" == "HEAD" ]]; then
    echo "[error] dirty worktree on detached HEAD; cannot auto-commit safely" >&2
    exit 6
  fi

  log "[step] dirty worktree detected; auto-commit and push before integration"
  git add -A >&2

  if [[ -z "$(git diff --cached --name-only)" ]]; then
    log "[warn] dirty worktree had no stageable changes; continuing"
    return 0
  fi

  git commit -m "chore(auto-update): snapshot fork changes before release integrate ($(date -u +%Y-%m-%dT%H:%M:%SZ))" >&2

  if git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
    local upstream_ref remote_name branch_name
    upstream_ref="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')"
    remote_name="${upstream_ref%%/*}"
    branch_name="${upstream_ref#*/}"

    if ! git push "$remote_name" "$branch_name" >&2; then
      log "[warn] push rejected for ${remote_name}/${branch_name}; trying pull --rebase then push"
      git pull --rebase "$remote_name" "$branch_name" >&2
      git push "$remote_name" "$branch_name" >&2
    fi
  else
    log "[warn] no upstream set on ${current_branch}; pushing to origin/${current_branch}"
    git push -u origin "$current_branch" >&2
  fi
}

log "[step] parse custom commits from CUSTOM_CHANGES.md"
if [[ -x "./tools/custom/extract-commits-from-log.sh" ]]; then
  mapfile -t COMMITS < <(./tools/custom/extract-commits-from-log.sh)
else
  mapfile -t COMMITS < <(extract_commits_inline)
fi

if (( ${#COMMITS[@]} == 0 )) || [[ -z "${COMMITS[0]}" ]]; then
  log "[warn] no Commits parsed from CUSTOM_CHANGES.md; falling back to non-merge commits in upstream/main..custom-main"
  mapfile -t COMMITS < <(git --no-pager log --reverse --no-merges --pretty=%H upstream/main..custom-main)
fi

if (( ${#COMMITS[@]} == 0 )) || [[ -z "${COMMITS[0]}" ]]; then
  echo "[error] no candidate commits found (CUSTOM_CHANGES.md and fallback range are both empty)" >&2
  exit 5
fi

auto_commit_and_push_if_dirty

log "[step] sync custom-main with upstream/main"
./tools/custom/update-upstream.sh >/tmp/openclaw-update-upstream.log

log "[step] fetch upstream tags"
git fetch upstream --tags --prune

LATEST_TAG="$({ git tag -l 'v*' | grep -E '^v[0-9]+' | grep -Evi 'alpha|beta|rc|pre' | sort -V | tail -n 1; } || true)"
if [[ -z "$LATEST_TAG" ]]; then
  echo "[error] no stable upstream tag found" >&2
  exit 3
fi

TARGET_BRANCH="release-custom/${LATEST_TAG}"
log "[step] checkout ${TARGET_BRANCH} from ${LATEST_TAG}"
git checkout -B "$TARGET_BRANCH" "$LATEST_TAG" >&2

log "[step] cherry-pick custom commits in order"
for commit in "${COMMITS[@]}"; do
  if git merge-base --is-ancestor "$commit" HEAD; then
    log "[skip] already included: $commit"
    continue
  fi
  log "[pick] $commit"
  if ! git cherry-pick -x "$commit" >&2; then
    if [[ "$CONFLICT_STRATEGY" == "prefer-custom" ]]; then
      log "[warn] conflict on $commit; auto-resolving with custom commit changes (theirs)"
      if git diff --name-only --diff-filter=U >/tmp/openclaw-conflict-files.txt && [[ -s /tmp/openclaw-conflict-files.txt ]]; then
        while IFS= read -r conflicted_file; do
          [[ -n "$conflicted_file" ]] || continue
          git checkout --theirs -- "$conflicted_file" >&2
          git add "$conflicted_file" >&2
        done </tmp/openclaw-conflict-files.txt
        if ! git cherry-pick --continue >&2; then
          if git rev-parse -q --verify CHERRY_PICK_HEAD >/dev/null 2>&1 \
            && [[ -z "$(git diff --name-only --diff-filter=U)" ]] \
            && git diff --quiet \
            && git diff --cached --quiet; then
            log "[warn] $commit becomes empty after auto-resolve; skipping"
            git cherry-pick --skip >&2
          else
            echo "[error] auto-resolve failed while continuing cherry-pick for $commit" >&2
            exit 4
          fi
        fi
      else
        if git rev-parse -q --verify CHERRY_PICK_HEAD >/dev/null 2>&1 \
          && [[ -z "$(git diff --name-only --diff-filter=U)" ]] \
          && git diff --quiet \
          && git diff --cached --quiet; then
          log "[warn] $commit already empty after conflict resolution; skipping"
          git cherry-pick --skip >&2
        else
          echo "[error] conflict detected but no unmerged files listed" >&2
          exit 4
        fi
      fi
    else
      echo "[error] cherry-pick conflict on $commit" >&2
      echo "[hint] resolve conflict then run: git cherry-pick --continue" >&2
      exit 4
    fi
  fi
done

if [[ "$PUSH_BRANCH" == "true" ]]; then
  log "[step] push release branch"
  git push --force-with-lease -u origin "$TARGET_BRANCH" >&2
fi

if [[ "$SKIP_INSTALL" != "true" ]]; then
  log "[step] install dependencies"
  pnpm install --frozen-lockfile >&2
fi

log "[step] build on release branch"
pnpm build >&2

log "[step] build control-ui assets"
pnpm ui:build >&2

HEAD_SHA="$(git rev-parse --short HEAD)"
if [[ "$JSON_MODE" == "true" ]]; then
  printf '{"status":"ok","tag":"%s","branch":"%s","head":"%s","dist":"%s/dist"}\n' \
    "$LATEST_TAG" "$TARGET_BRANCH" "$HEAD_SHA" "$ROOT_DIR"
else
  log "[ok] release integration complete"
  log "[info] tag=$LATEST_TAG branch=$TARGET_BRANCH head=$HEAD_SHA"
fi
