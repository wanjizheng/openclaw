#!/usr/bin/env bash
# release-integrate-and-build.sh — Full custom release pipeline
#
# Workflow (matches user requirement exactly):
#   1. Require a clean worktree (never auto-commit or discard local changes)
#   2. Fetch upstream + tags
#   3. Find latest stable release tag (e.g. v2026.2.26)
#   4. Find the newest stable upstream tag already contained by custom-main
#   5. Materialize the exact net tree delta (<base-tag>..custom-main) as one
#      synthetic commit (no subject/history heuristics)
#   6. Create release-custom/<tag> from the latest tag + cherry-pick that delta
#   7. Build (pnpm install + build + ui:build)
#   8. Merge the validated release tree back into custom-main
#   9. Deploy built artifacts to global install + refresh gateway service + restart
#  10. Push everything & switch to custom-main
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
# Conflict strategy: by default FAIL-LOUD on the first conflict instead of
# silently picking one side. The previous prefer-custom default silently
# broke cross-file symbol references when a cherry-pick conflict happened
# in a "near-uncontested" file (auto-resolve dropped an upstream function
# while a parallel non-conflicting file kept its new caller of that
# function). See `verify_cross_file_symbols` for the catching layer.
#
# Escape hatch: set OPENCLAW_ALLOW_PREFER_CUSTOM=true (or pass
# --conflict-strategy prefer-custom) to fall back to the legacy
# auto-resolve. Only do this when you have reviewed the resulting
# release branch and confirmed every import resolves; the lint is
# authoritative.
if [[ "${OPENCLAW_ALLOW_PREFER_CUSTOM:-false}" == "true" ]]; then
  CONFLICT_STRATEGY="prefer-custom"
else
  CONFLICT_STRATEGY="stop"
fi
REUSE_EXISTING="false"
STRICT_TYPECHECK="true"

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
    --conflict-strategy) CONFLICT_STRATEGY="${2:-stop}"; shift 2 ;;
    --reuse-existing)     REUSE_EXISTING="true"; shift ;;
    --no-strict-typecheck) STRICT_TYPECHECK="false"; shift ;;
    --deploy-target)     DEPLOY_TARGET="${2:?}"; shift 2 ;;
    *) die "unknown arg: $1" ;;
  esac
done

[[ "$CONFLICT_STRATEGY" =~ ^(prefer-custom|stop)$ ]] \
  || die "--conflict-strategy must be prefer-custom|stop"

if [[ "$CONFLICT_STRATEGY" == "prefer-custom" \
  && "${OPENCLAW_ALLOW_PREFER_CUSTOM:-false}" != "true" ]]; then
  log "WARN: --conflict-strategy=prefer-custom is unsafe across release trains (cross-file symbol drop)."
  log "      Maintain it manually and run verify_cross_file_symbols after the build, or set OPENCLAW_ALLOW_PREFER_CUSTOM=true explicitly to suppress this message."
fi

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

# ── Cross-file symbol lint ────────────────────────────────────────────────────
# Static cross-file import→export integrity check for the voice-call extension
# (where fork customisation concentrates). Runs after cherry-picks and before
# pnpm install. tsdown's bundler does validate imports — but only after a
# 100-second compile, and only at build time. This pre-build lint catches the
# exact failure mode where:
#   * cherry-pick A conflicts on `manager/timers.ts` (auto-resolved to
#     "ours" → drops an upstream function)
#   * cherry-pick B has no conflict on `manager/events.ts` (gets the new
#     caller of that function)
#   * Result: events.ts imports a non-existent symbol → tsdown exits with
#     [MISSING_EXPORT] 100 seconds later.
#
# Scans all .ts files under extensions/voice-call/src/manager/, extracts named
# imports from relative paths, then resolves each name against the target
# file's `export` statements. Missing symbols fail with rc=10 and a clear
# file:line list. Cheap (pure bash + grep), exit-fast.
#
# This check is INTENTIONALLY conservative — false positives are acceptable
# at 0%; false negatives are not (we'd rather block a build than deploy a
# broken dist). The lint catches dangling imports; downstream semantics are
# still on the operator (the lint will not catch "wrong constant value").

verify_cross_file_symbols() {
  local root="extensions/voice-call/src"
  [[ -d "$root" ]] || { log "[ok] cross-file symbol lint skipped: $root not present"; return 0; }

  local exit_code=0
  local -a missing_refs=()

  # Collect all .ts files under the manager/ subtree (most-forked surface)
  # and the wider src/ tree (anything `from "./..."` could point to).
  local -a ts_files
  mapfile -t ts_files < <(find "$root" -type f -name '*.ts' -not -path '*/node_modules/*' 2>/dev/null)

  for src_file in "${ts_files[@]}"; do
    # Pull every `import { ... } from "./relative/path"` statement, joining
    # multi-line imports (which span `import {\n  ...\n} from "..."`) into a
    # single virtual line. The bug we're hunting (7/1 cross-file drift) was
    # inside a multi-line import in events.ts that a single-line grep would
    # miss.
    #
    # Approach: read the whole file into a bash array of lines, find each
    # line that opens an `import {` without a `from` on the same line, then
    # walk forward collecting continuation lines until we hit `} from`.
    # Avoids the fd-3 dance and process-substitution stdin entanglement
    # that bit the earlier `while read <&3` attempt.
    local -a file_lines=()
    mapfile -t file_lines < "$src_file"
    local -a import_lines=()
    local i
    for ((i=0; i<${#file_lines[@]}; i++)); do
      local line="${file_lines[$i]}"
      # Only consider import statements.
      [[ "$line" =~ ^[[:space:]]*import[[:space:]] ]] || continue
      if [[ "$line" =~ ^[[:space:]]*import[[:space:]]+(type[[:space:]]+)?\{[[:space:]]*$ ]]; then
        # Multi-line opener — walk forward until we find `} from "..."`.
        local accum="$line"
        local j
        for ((j=i+1; j<${#file_lines[@]}; j++)); do
          local next_line="${file_lines[$j]}"
          accum="${accum}
${next_line}"
          if [[ "$next_line" =~ \}[[:space:]]+from[[:space:]]+[\"\'] ]]; then
            break
          fi
          # Safety cap: don't read forever if we never find the close.
          if [[ ${#accum} -gt 4096 ]]; then
            break
          fi
        done
        import_lines+=("$accum")
      else
        import_lines+=("$line")
      fi
    done

    for import_line in "${import_lines[@]}"; do
      [[ -z "$import_line" ]] && continue

      # ── Form 1: `import { X, Y as Z, type T } from "./spec"`
      #              captures group 1 = brace list, group 2 = specifier
      local brace_list="" specifier=""
      if [[ "$import_line" =~ from[[:space:]]+\"([^\"]+)\" ]] || \
         [[ "$import_line" =~ from[[:space:]]+\'([^\']+)\' ]]; then
        specifier="${BASH_REMATCH[1]}"
      fi
      # Multi-line imports: collapse to one line for the brace-list sed.
      # `import {` on line 1 + `}` on the last line + intervening names —
      # we want `import { A, B, C } from "./spec"` to match the sed regex.
      local flat_import_line
      flat_import_line="$(printf '%s' "$import_line" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
      # Extract brace list separately
      local bl=""
      bl="$(printf '%s\n' "$flat_import_line" | sed -nE 's/^import[[:space:]]+(type[[:space:]]+)?\{([^}]*)\}[[:space:]]+from.*/\2/p')"
      if [[ -n "$bl" && -n "$specifier" ]]; then
        brace_list="$bl"
      else
        # ── Form 2: `import Foo from "./spec"` (default import)
        local default_name=""
        default_name="$(printf '%s\n' "$flat_import_line" | sed -nE 's/^import[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)[[:space:]]+from.*/\1/p')"
        if [[ -n "$default_name" && "$default_name" != "type" && -n "$specifier" ]]; then
          brace_list="default"
        else
          # Form 3 (`import * as X from "./spec"`) and Form 4
          # (side-effect `import "./spec"`) — no symbols to verify.
          continue
        fi
      fi

      # Only relative specifiers carry the cross-file risk that broke us.
      case "$specifier" in
        .*|/*) ;;
        *) continue ;;
      esac

      # Resolve relative to the importing file's directory.
      local src_dir
      src_dir="$(dirname "$src_file")"
      local resolved=""
      # shellcheck disable=SC2162  # we want word-splitting on /, intentional
      local piece
      local -a segs=()
      # Split src_dir on /
      local IFS='/'
      # shellcheck disable=SC2206
      segs=( $src_dir )
      unset IFS
      # Normalize the specifier's leading "./"
      local spec_norm="$specifier"
      spec_norm="${spec_norm#./}"
      # Split specifier on /
      local -a pieces=()
      local IFS='/'
      # shellcheck disable=SC2206
      pieces=( $spec_norm )
      unset IFS
      for piece in "${pieces[@]}"; do
        case "$piece" in
          ""|".") ;;
          "..") [[ ${#segs[@]} -gt 0 ]] && unset 'segs[${#segs[@]}-1]' ;;
          *) segs+=("$piece") ;;
        esac
      done
      # Join segments
      resolved=""
      local s
      for s in "${segs[@]}"; do
        resolved="${resolved}/${s}"
      done
      # Drop the leading slash we just prepended
      resolved="${resolved#/}"

      # Add .ts if no extension (.js paths are TS source under pnpm).
      case "$resolved" in
        *.ts|*.tsx|*.mts|*.cts|*.js|*.mjs|*.cjs) ;;
        *) resolved="${resolved}.ts" ;;
      esac

      # TypeScript resolves `./foo.js` to `./foo.ts` (ESM-style .js import
      # against .ts source under pnpm). If the literal `.js` file is missing
      # but the `.ts` sibling exists, rewrite $resolved to the .ts path so
      # the export-grep finds the actual symbol declarations.
      if [[ ! -f "$resolved" && "$resolved" == *.js ]]; then
        local ts_candidate="${resolved%.js}.ts"
        if [[ -f "$ts_candidate" ]]; then
          resolved="$ts_candidate"
        fi
      fi

      [[ -f "$resolved" ]] || {
        # Bail silently — TypeScript will surface module-not-found at build
        # time, and we already have a separate [MISSING_EXPORT] check there.
        # Don't pile a false positive onto this lint.
        continue
      }

      # For each name in the brace list (split on commas, trim, drop
      # `type X` prefix). Aliases (`X as Y`) are checked by their underlying
      # name X — the export side just needs to declare X.
      local raw_name
      local -a raw_names=()
      local IFS=','
      # shellcheck disable=SC2206
      raw_names=( $brace_list )
      unset IFS
      for raw_name in "${raw_names[@]}"; do
        # Trim whitespace
        raw_name="${raw_name#"${raw_name%%[![:space:]]*}"}"
        raw_name="${raw_name%"${raw_name##*[![:space:]]}"}"
        [[ -z "$raw_name" ]] && continue
        # Strip `type ` prefix (type-only imports — nothing to runtime-check)
        raw_name="${raw_name#type }"
        raw_name="${raw_name#"${raw_name%%[![:space:]]*}"}"
        raw_name="${raw_name%"${raw_name##*[![:space:]]}"}"
        [[ -z "$raw_name" ]] && continue
        # Take left side of `as alias` — the actual imported name
        local name="${raw_name%% *}"
        [[ "$name" == "type" ]] && continue

        # Search the target file for either:
        #   - `export (function|const|let|var|class|interface|type|<NAME>) <name>`
        #   - `export { ... <name> ... }`
        #   - `export type { ... <name> ... }`
        #   - `export default` (when name == "default")
        if [[ "$name" == "default" ]]; then
          if grep -qE '^[[:space:]]*export[[:space:]]+default[[:space:]]' "$resolved" \
             || grep -qE '^[[:space:]]*export[[:space:]]+\{[[:space:]]*default[[:space:]]*\}' "$resolved"; then
            continue
          fi
          missing_refs+=("${src_file}: default from \"${specifier}\" -> ${resolved} (no default export)")
          exit_code=10
          continue
        fi

        # Escaped name for the regex (defensive — symbols are usually
        # [A-Za-z_$][\w$]* but we don't want to assume)
        local esc_name
        esc_name="$(printf '%s' "$name" | sed -E 's/[][^$.*+?(){}|\\]/\\&/g')"

        # export <decl-keyword>? <name> <boundary>
        if grep -qE "^[[:space:]]*export[[:space:]]+(async[[:space:]]+|abstract[[:space:]]+|declare[[:space:]]+|const[[:space:]]+|let[[:space:]]+|var[[:space:]]+|function[[:space:]]+|class[[:space:]]+|interface[[:space:]]+|type[[:space:]]+|enum[[:space:]]+|namespace[[:space:]]+)*${esc_name}[[:space:]]*[\\(\\<\\{;,=[:space:]]" "$resolved"; then
          continue
        fi
        # export { ... <name> ... } — single-line and multi-line (barrel
        # re-export `export { X, Y } from "./other";`). Pre-flatten the
        # target file to one logical line so an `[^}]*` pattern can span
        # what was originally multiple lines, then run ordinary grep. We
        # do NOT anchor with `^` because after flattening the line may start
        # with a leading comment — `export {` will appear mid-line and we
        # want to match it regardless of position.
        local flat_resolved
        flat_resolved="$(tr '\n' ' ' < "$resolved")"
        if grep -qE "export[[:space:]]+\\{[^}]*\\b${esc_name}\\b[^}]*\\}" <<<"$flat_resolved"; then
          continue
        fi
        # export type { ... <name> ... }
        if grep -qE "export[[:space:]]+type[[:space:]]+\\{[^}]*\\b${esc_name}\\b[^}]*\\}" <<<"$flat_resolved"; then
          continue
        fi

        missing_refs+=("${src_file}: import { ${raw_name} } from \"${specifier}\" -> ${resolved}")
        exit_code=10
      done
    done
  done

  if (( exit_code != 0 )); then
    log "[error] cross-file symbol lint failed with ${#missing_refs[@]} missing reference(s):"
    local ref
    for ref in "${missing_refs[@]}"; do
      log "  - ${ref}"
    done
    log "[hint]  these are imports that don't resolve to any export in the target file. Common cause:"
    log "        a forked re-port commit conflicted on the target file and auto-resolve picked"
    log "        \"ours\" (custom-main version), dropping an upstream symbol while a sibling file"
    log "        kept its non-conflicting call site. Rebuild by cherry-picking the upstream commit"
    log "        that added the missing symbol, or remove the dangling call site manually."
    log "[hint]  set OPENCLAW_ALLOW_PREFER_CUSTOM=true to fall back to legacy auto-resolve (NOT"
    log "        recommended — at minimum, re-run the build to confirm import drift is benign)."
    return 10
  fi
  log "[ok] cross-file symbol lint passed (${#ts_files[@]} files scanned)"
  return 0
}

# ── Strict typecheck gate ─────────────────────────────────────────────────────
# Runs after `pnpm install` and before `pnpm build` to surface strict-mode
# type regressions on the voice-call package. pnpm build is transpile-only,
# which silently drops type errors that would otherwise have caught the
# cherry-pick drift that produced the 2026-07-01 build failure. We diff
# against a baseline captured from custom-main (which carries known fork
# typecheck debt); NEW errors fail the integration build.
#
# Toggle: --no-strict-typecheck to disable, or env OPENCLAW_SKIP_STRICT_TYPECHECK=1.

verify_strict_typecheck() {
  if [[ "$STRICT_TYPECHECK" != "true" ]]; then
    log "[skip] strict typecheck disabled (--no-strict-typecheck)"
    return 0
  fi
  local baseline_branch="${OPENCLAW_TYPECHECK_BASELINE_BRANCH:-custom-main}"
  local filter_args=(--filter "@openclaw/voice-call" --filter "@openclaw/voice-call-plugin")
  local ts_err_file; ts_err_file="$(mktemp)"
  local typecheck_state_dir="${WORKSPACE_STATE_DIR:-$ROOT_DIR/tools/custom/.update}"
  local baseline_err_file="$typecheck_state_dir/_strict-typecheck-baseline.txt"
  mkdir -p "$typecheck_state_dir"

  log "running strict typecheck (voice-call package)"
  local typecheck_rc
  if pnpm tsgo "${filter_args[@]}" >"$ts_err_file" 2>&1 </dev/null; then
    typecheck_rc=0
  else
    typecheck_rc=$?
  fi

  if (( typecheck_rc == 0 )) && [[ ! -s "$ts_err_file" ]]; then
    rm -f "$ts_err_file"
    log "[ok] strict typecheck passed (no errors emitted)"
    return 0
  fi

  # New error filter: tsgo errors look like
  #   extensions/voice-call/src/.../X.ts:NN:SS - error TSnnnn: <message>
  # We compare against the baseline's error set by hashable signature.
  local -A current_sigs=()
  local sig
  while IFS= read -r line; do
    [[ "$line" =~ \.ts:[0-9]+:[0-9]+[[:space:]]+-?[[:space:]]*error[[:space:]]+TS[0-9]+ ]] || continue
    sig="$(printf '%s' "$line" | sed -E 's/^[^:]+extensions\/voice-call/extensions\/voice-call/' | sed -E 's/[0-9]+:[0-9]+/<pos>/g')"
    current_sigs["$sig"]=1
  done <"$ts_err_file"

  if (( typecheck_rc != 0 )) && (( ${#current_sigs[@]} == 0 )); then
    log "[error] strict typecheck command failed with rc=$typecheck_rc and emitted no recognized TypeScript diagnostics:"
    tail -50 "$ts_err_file" >&2
    rm -f "$ts_err_file"
    return 12
  fi

  if [[ ! -f "$baseline_err_file" ]]; then
    log "[error] strict typecheck baseline missing: $baseline_err_file"
    log "[hint]  create and review the baseline explicitly from $baseline_branch; the release branch is never auto-approved as its own baseline"
    rm -f "$ts_err_file"
    return 12
  fi

  local -A baseline_sigs=()
  while IFS= read -r line; do
    [[ "$line" =~ \.ts:[0-9]+:[0-9]+[[:space:]]+-?[[:space:]]*error[[:space:]]+TS[0-9]+ ]] || continue
    sig="$(printf '%s' "$line" | sed -E 's/^[^:]+extensions\/voice-call/extensions\/voice-call/' | sed -E 's/[0-9]+:[0-9]+/<pos>/g')"
    baseline_sigs["$sig"]=1
  done <"$baseline_err_file"

  local -a new_errors=()
  local -a fixed_errors=()
  for sig in "${!current_sigs[@]}"; do
    [[ -z "${baseline_sigs[$sig]+x}" ]] && new_errors+=("$sig")
  done
  for sig in "${!baseline_sigs[@]}"; do
    [[ -z "${current_sigs[$sig]+x}" ]] && fixed_errors+=("$sig")
  done

  if (( ${#new_errors[@]} > 0 )); then
    log "[error] strict typecheck introduced ${#new_errors[@]} new error signature(s) vs baseline:"
    for sig in "${new_errors[@]}"; do
      log "  + $sig"
    done
    log "[hint]  these errors are absent from the reviewed $baseline_branch baseline."
    log "        The most common cause is a stale cross-file import (see verify_cross_file_symbols)."
    log "        Manually fix or extend baseline: $baseline_err_file"
    rm -f "$ts_err_file"
    return 11
  fi

  log "[ok] strict typecheck pass: ${#current_sigs[@]} current errors, ${#baseline_sigs[@]} baseline errors, ${#fixed_errors[@]} fixed since baseline"
  rm -f "$ts_err_file"
  return 0
}

SECONDS=0

# ══════════════════════════════════════════════════════════════════════════════
# 1. Require a clean worktree
# ══════════════════════════════════════════════════════════════════════════════
if [[ -n "$(git status --porcelain)" ]]; then
  die "dirty worktree; commit or move local changes before release integration"
fi

return_to_custom_main_on_exit() {
  local exit_code=$?
  trap - EXIT
  local current_branch
  current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if git rev-parse --verify -q CHERRY_PICK_HEAD >/dev/null 2>&1; then
    git -c core.hooksPath=/dev/null cherry-pick --abort 2>/dev/null || true
  fi
  if git rev-parse --verify -q MERGE_HEAD >/dev/null 2>&1; then
    git merge --abort 2>/dev/null || true
  fi
  if [[ "$current_branch" != "custom-main" ]]; then
    # The worktree was clean at entry and this script owns all tracked
    # changes made on release-custom/*, so failed build metadata is safe to
    # discard before returning the operator to the canonical branch.
    if ! git diff --quiet || ! git diff --cached --quiet; then
      git restore --source=HEAD --staged --worktree -- . 2>/dev/null || true
    fi
    if ! git checkout custom-main --quiet 2>/dev/null; then
      log "ERROR: failed to return to custom-main after pipeline exit"
      exit_code=1
    fi
  fi
  exit "$exit_code"
}
trap return_to_custom_main_on_exit EXIT

# ══════════════════════════════════════════════════════════════════════════════
# 2. Fetch upstream + tags
# ══════════════════════════════════════════════════════════════════════════════
step "fetch upstream + origin"
git fetch upstream --tags --prune --force --quiet
git fetch origin --prune --quiet

git show-ref --verify --quiet refs/heads/custom-main \
  || die "local custom-main is missing; refusing to recreate the canonical custom branch from an upstream tag"
git checkout custom-main --quiet
if git show-ref --verify --quiet refs/remotes/origin/custom-main; then
  if git merge-base --is-ancestor custom-main origin/custom-main; then
    git merge --ff-only origin/custom-main --quiet \
      || die "failed to fast-forward custom-main to origin/custom-main"
    log "[ok] custom-main fast-forwarded to origin/custom-main"
  elif git merge-base --is-ancestor origin/custom-main custom-main; then
    log "[ok] local custom-main contains origin/custom-main"
  else
    die "custom-main and origin/custom-main have diverged; reconcile them explicitly before release integration"
  fi
else
  log "WARN: origin/custom-main is missing; using the existing local custom-main"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 3. Find latest stable tag published by upstream
# ══════════════════════════════════════════════════════════════════════════════
mapfile -t UPSTREAM_STABLE_TAGS < <(
  git ls-remote --tags --refs upstream 'refs/tags/v*' \
    | awk '{print $2}' \
    | sed 's#^refs/tags/##' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -Vu
)
(( ${#UPSTREAM_STABLE_TAGS[@]} > 0 )) || die "no stable upstream tag found"
LATEST_TAG="${UPSTREAM_STABLE_TAGS[${#UPSTREAM_STABLE_TAGS[@]} - 1]}"
git rev-parse --verify -q "${LATEST_TAG}^{commit}" >/dev/null \
  || die "latest upstream tag was not fetched locally: $LATEST_TAG"
log "latest stable tag: $LATEST_TAG"

# vYYYY.M.patch -> train YYYY.M. Re-porting across trains requires semantic
# review because upstream may have moved or deleted fork-touched symbols.
BASE_TAG=""
for (( tag_index=${#UPSTREAM_STABLE_TAGS[@]} - 1; tag_index >= 0; tag_index-- )); do
  upstream_tag="${UPSTREAM_STABLE_TAGS[$tag_index]}"
  if git merge-base --is-ancestor "${upstream_tag}^{commit}" custom-main 2>/dev/null; then
    BASE_TAG="$upstream_tag"
    break
  fi
done
[[ -n "$BASE_TAG" ]] || die "cannot determine stable base tag reachable from custom-main"
BASE_COMMIT="$(git rev-parse "${BASE_TAG}^{commit}")"
LATEST_TRAIN="$(printf '%s' "${LATEST_TAG#v}" | cut -d. -f1,2)"
BASE_TRAIN="$(printf '%s' "${BASE_TAG#v}" | cut -d. -f1,2)"
if [[ "$BASE_TRAIN" != "$LATEST_TRAIN" ]]; then
  log "WARN: release-train drift: custom-main base=$BASE_TAG, latest=$LATEST_TAG"
  if [[ "$CONFLICT_STRATEGY" == "stop" ]]; then
    log "      exact custom delta will be replayed; stop mode will abort cleanly on the first semantic conflict"
  else
    log "      exact custom delta will be replayed with explicit prefer-custom conflict resolution"
  fi
  if [[ "$CONFLICT_STRATEGY" == "prefer-custom" && "${OPENCLAW_ALLOW_MAJOR_DRIFT:-false}" != "true" ]]; then
    die "automatic prefer-custom resolution across release trains requires OPENCLAW_ALLOW_MAJOR_DRIFT=true after manual review"
  fi
else
  log "[ok] release-train check passed: base=$BASE_TAG latest=$LATEST_TAG"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 4. Keep custom-main as the immutable source snapshot
# ══════════════════════════════════════════════════════════════════════════════
CUSTOM_SOURCE_HEAD="$(git rev-parse custom-main)"
CUSTOM_SOURCE_TREE="$(git rev-parse 'custom-main^{tree}')"
log "custom source: ${CUSTOM_SOURCE_HEAD:0:12} (base $BASE_TAG)"

# ══════════════════════════════════════════════════════════════════════════════
# 5. Materialize the exact custom-main delta
#    A synthetic commit with parent BASE_TAG and tree custom-main represents
#    every net fork change exactly once. This includes changes introduced by
#    re-port commits, merge-conflict resolutions, deletions, mode changes, and
#    custom-added paths. It deliberately does not infer intent from subjects.
# ══════════════════════════════════════════════════════════════════════════════
step "materialize exact custom delta"
CUSTOM_DELTA_COMMIT="$(
  printf '%s\n\n%s\n%s\n' \
    "chore(custom): replay custom-main delta from $BASE_TAG" \
    "Source custom-main: $CUSTOM_SOURCE_HEAD" \
    "Base upstream tag: $BASE_TAG" \
    | git commit-tree "$CUSTOM_SOURCE_TREE" -p "$BASE_COMMIT"
)"
CUSTOM_COMMITS=("$CUSTOM_DELTA_COMMIT")
CUSTOM_DELTA_PATHS="$(git diff-tree --no-commit-id --name-only -r "$CUSTOM_DELTA_COMMIT" | wc -l)"
log "synthetic delta: ${CUSTOM_DELTA_COMMIT:0:12} ($CUSTOM_DELTA_PATHS changed paths)"

# ══════════════════════════════════════════════════════════════════════════════
# 6. Create release branch from tag + cherry-pick custom commits
# ══════════════════════════════════════════════════════════════════════════════
TARGET_BRANCH="release-custom/${LATEST_TAG}"

# ── --reuse-existing fast-path ────────────────────────────────────────────────
# Used only for an explicit rebuild when custom-main already contains the
# integration for $LATEST_TAG. In that case the cherry-pick
# step would be a no-op duplicated work — skip straight to rebuilding the
# existing release branch (still re-running pnpm install + pnpm build to
# refresh dist/ before deploy).
#
# Pre-conditions for skipping:
#   1. $REUSE_EXISTING = "true" (set by `--reuse-existing`)
#   2. refs/heads/$TARGET_BRANCH exists locally
#   3. The branch descends from $LATEST_TAG and contains no merge commits
#      after the tag (a generated release branch must be a linear replay).
#   4. Its tree is byte-for-byte identical to current custom-main. An
#      ancestor-only check is insufficient: an old release branch is normally
#      an ancestor of custom-main precisely when it is stale.
#   5. The branch has at least one commit past $LATEST_TAG.
if [[ "$REUSE_EXISTING" == "true" ]]; then
  if ! git show-ref --verify --quiet "refs/heads/$TARGET_BRANCH"; then
    log "[warn] --reuse-existing requested but refs/heads/$TARGET_BRANCH missing; falling back to full pipeline"
    REUSE_EXISTING="false"
  elif ! git merge-base --is-ancestor "$LATEST_TAG" "$TARGET_BRANCH"; then
    log "[warn] --reuse-existing but $TARGET_BRANCH doesn't descend from $LATEST_TAG; falling back to full pipeline"
    REUSE_EXISTING="false"
  elif [[ -n "$(git rev-list --merges "$LATEST_TAG".."$TARGET_BRANCH")" ]]; then
    log "[warn] --reuse-existing but $TARGET_BRANCH is not a linear release replay; falling back to full pipeline"
    REUSE_EXISTING="false"
  elif ! git diff --quiet "$TARGET_BRANCH" custom-main; then
    log "[warn] --reuse-existing but $TARGET_BRANCH tree differs from current custom-main; falling back to full pipeline"
    REUSE_EXISTING="false"
  else
    # Count commits the branch has past the tag — must be > 0 to be a real
    # integration (otherwise it's just an empty pointer at the tag).
    commits_past_tag=$(git rev-list --count "$LATEST_TAG".."$TARGET_BRANCH" 2>/dev/null || echo 0)
    if (( commits_past_tag <= 0 )); then
      log "[warn] --reuse-existing but $TARGET_BRANCH has no commits past $LATEST_TAG; falling back to full pipeline"
      REUSE_EXISTING="false"
    fi
  fi
fi

if [[ "$REUSE_EXISTING" == "true" ]]; then
  step "reuse $TARGET_BRANCH (skip cherry-pick; re-run build)"
  log "[info] --reuse-existing: custom-main's integrator already produced $TARGET_BRANCH."
  log "[info] cherry-pick step skipped; will refresh pnpm install + pnpm build then deploy."
  git checkout "$TARGET_BRANCH" --quiet
else
  step "create $TARGET_BRANCH from $LATEST_TAG"
  if git show-ref --verify --quiet "refs/heads/$TARGET_BRANCH"; then
    SNAPSHOT_BRANCH="auto-update/snapshot-release-$(date -u +%Y%m%d-%H%M%S)-$$"
    git branch "$SNAPSHOT_BRANCH" "$TARGET_BRANCH"
    log "saved existing $TARGET_BRANCH at $SNAPSHOT_BRANCH before regeneration"
  fi
  git checkout -B "$TARGET_BRANCH" "$LATEST_TAG" --quiet
fi

abort_cherry_pick_attempt() {
  git -c core.hooksPath=/dev/null cherry-pick --abort \
    || die "failed to abort the current cherry-pick"
}

unmerged_path_has_stage() {
  local file_path="$1"
  local wanted_stage="$2"
  git ls-files -u -- "$file_path" \
    | awk -v wanted="$wanted_stage" '$3 == wanted { found=1 } END { exit(found ? 0 : 1) }'
}

resolve_conflicted_path() {
  local file_path="$1"
  local side="theirs"
  local stage=3

  if unmerged_path_has_stage "$file_path" "$stage"; then
    git checkout "--$side" -- "$file_path" \
      && git add -- "$file_path"
  else
    # The selected side deleted the path (modify/delete, rename/delete, etc.).
    # Staging the remaining worktree copy would silently choose the opposite
    # side, so record the deletion explicitly.
    git rm -f -- "$file_path"
  fi
}

cherry_pick_one() {
  local sha="$1"
  local short cherry_output
  short="$(git --no-pager log --oneline -1 "$sha")"

  # Already an ancestor of HEAD (tag already contains it)
  if git merge-base --is-ancestor "$sha" HEAD 2>/dev/null; then
    log "  skip (ancestor): $short"
    return 0
  fi

  # Let Git own the complete sequencer state. This preserves the -x
  # provenance trailer and guarantees CHERRY_PICK_HEAD exists on conflicts.
  local cherry_log
  cherry_log="$(mktemp)"
  if HUSKY=0 LEFTHOOK=0 git -c core.hooksPath=/dev/null \
    cherry-pick -x "$sha" >"$cherry_log" 2>&1; then
    rm -f "$cherry_log"
    log "  applied:         $short"
    return 0
  fi

  local conflicted
  conflicted="$(git diff --name-only --diff-filter=U 2>/dev/null || true)"
  if [[ -z "$conflicted" ]]; then
    # A patch already present upstream is a valid empty replay. Git leaves
    # sequencer state behind; --skip clears it without manufacturing a commit.
    if git rev-parse --verify -q CHERRY_PICK_HEAD >/dev/null 2>&1 \
      && git diff --cached --quiet; then
      git -c core.hooksPath=/dev/null cherry-pick --skip
      rm -f "$cherry_log"
      log "  skip (empty):    $short"
      return 0
    fi
    cherry_output="$(tail -40 "$cherry_log")"
    rm -f "$cherry_log"
    if git rev-parse --verify -q CHERRY_PICK_HEAD >/dev/null 2>&1; then
      abort_cherry_pick_attempt
    fi
    log "[error] cherry-pick failed without resolvable conflicts: $short"
    [[ -z "$cherry_output" ]] || log "$cherry_output"
    die "unexpected cherry-pick failure on $short"
  fi

  if [[ "$CONFLICT_STRATEGY" == "stop" ]]; then
    abort_cherry_pick_attempt
    rm -f "$cherry_log"
    die "conflict on $short — release branch restored cleanly; semantically re-port the conflicting change onto custom-main, commit it, then rerun"
  fi

  log "  conflict:        $short — auto-resolving (prefer custom)"
  local f
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    if ! resolve_conflicted_path "$f"; then
      abort_cherry_pick_attempt
      rm -f "$cherry_log"
      die "failed to resolve $f while cherry-picking $short"
    fi
  done <<< "$conflicted"

  if [[ -n "$(git ls-files -u)" ]]; then
    abort_cherry_pick_attempt
    rm -f "$cherry_log"
    die "unresolved index entries remain after auto-resolving $short"
  fi

  if git diff --cached --quiet; then
    git -c core.hooksPath=/dev/null cherry-pick --skip
    rm -f "$cherry_log"
    log "  skip (empty after resolve): $short"
    return 0
  fi

  if ! GIT_EDITOR=true HUSKY=0 LEFTHOOK=0 git -c core.hooksPath=/dev/null \
    cherry-pick --continue >>"$cherry_log" 2>&1; then
    abort_cherry_pick_attempt
    cherry_output="$(tail -40 "$cherry_log")"
    rm -f "$cherry_log"
    [[ -z "$cherry_output" ]] || log "$cherry_output"
    die "failed to commit resolved cherry-pick: $short"
  fi
  rm -f "$cherry_log"
  log "  applied (resolved): $short"
}

verify_custom_added_paths_survive() {
  local path custom_entry release_entry
  while IFS= read -r -d '' path; do
    # Only inspect paths added relative to the custom source's base tag.
    # Upstream may legitimately delete other paths in LATEST_TAG.
    custom_entry="$(git ls-tree custom-main -- "$path")"
    release_entry="$(git ls-tree HEAD -- "$path")"
    if [[ -z "$release_entry" ]]; then
      die "custom-added path missing after cherry-pick replay: $path"
    fi
    if [[ "${custom_entry%%$'\t'*}" != "${release_entry%%$'\t'*}" ]]; then
      die "custom-added path differs after cherry-pick replay: $path"
    fi
  done < <(
    git diff --no-renames --diff-filter=A --name-only -z \
      "$BASE_COMMIT" custom-main
  )
  log "[ok] all custom-added paths survived cherry-pick replay"
}

if [[ "$REUSE_EXISTING" != "true" ]]; then
  for sha in "${CUSTOM_COMMITS[@]}"; do
    cherry_pick_one "$sha"
  done
fi

verify_custom_added_paths_survive
log "cherry-pick complete ($(elapsed))"

# ── Cross-file symbol lint (post-cherry-pick, pre-install) ────────────────────
# Detects the failure mode where a cherry-pick conflict auto-resolved to
# drop an upstream symbol while a non-conflicting sibling file kept its
# new caller of that symbol. Runs in <1s on the voice-call subtree; fails
# with rc=10 before the 100-second `pnpm build` even starts.
verify_cross_file_symbols || {
  rc=$?
  if [[ "$rc" -eq 10 ]]; then
    die "cross-file symbol lint failed (rc=10); see [error] lines above for file:line list"
  fi
  exit "$rc"
}

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

  # ── Strict typecheck gate (post-build, pre-deploy) ────────────────────────
  # pnpm build is transpile-only and silently drops type errors. This catches
  # them BEFORE deploy, with a baseline diff against custom-main so the
  # known fork typecheck debt doesn't fail the build.
  verify_strict_typecheck || {
    rc=$?
    log "[error] strict typecheck gate failed (rc=$rc); the cherry-pick introduced"
    log "        new type errors that don't exist on custom-main. Manually fix the"
    log "        listed signatures, or explicitly review and update the baseline at"
    log "        ${WORKSPACE_STATE_DIR:-$ROOT_DIR/tools/custom/.update}/_strict-typecheck-baseline.txt."
    exit "$rc"
  }

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

  # Lockfile regeneration and stable-version normalization are source changes,
  # not build artifacts. Commit only these known files so the following branch
  # switch cannot fail or silently leave release metadata outside the branch.
  if ! git diff --quiet -- package.json pnpm-lock.yaml; then
    git add -- package.json pnpm-lock.yaml
    git -c core.hooksPath=/dev/null commit \
      -m "chore(release): normalize ${LATEST_TAG} build metadata" \
      --no-verify \
      || die "failed to commit release build metadata"
  fi
  if [[ -n "$(git status --porcelain)" ]]; then
    git status --short >&2
    die "build left unexpected worktree changes; refusing to deploy or switch branches"
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# 8. Merge validated release tree → custom-main
# ══════════════════════════════════════════════════════════════════════════════
step "merge $TARGET_BRANCH → custom-main"
git checkout custom-main --quiet

if git merge-base --is-ancestor "$TARGET_BRANCH" custom-main 2>/dev/null; then
  log "custom-main already contains $TARGET_BRANCH — skip merge"
else
  # The release branch has already passed replay checks and the build. Make
  # the merge commit's tree exactly that validated release tree. A normal
  # content merge can reintroduce pre-upgrade custom-main versions or stop on
  # conflicts that were already resolved during the cherry-pick.
  git merge "$TARGET_BRANCH" --no-ff --no-commit --no-verify >/dev/null 2>&1 || true
  git rev-parse --verify -q MERGE_HEAD >/dev/null 2>&1 \
    || die "failed to enter merge state for $TARGET_BRANCH"
  git read-tree --reset -u "$TARGET_BRANCH" \
    || { git merge --abort 2>/dev/null || true
         die "failed to stage the validated $TARGET_BRANCH tree"; }
  [[ -z "$(git ls-files -u)" ]] \
    || { git merge --abort 2>/dev/null || true
         die "unresolved index entries remain while integrating $TARGET_BRANCH"; }
  git -c core.hooksPath=/dev/null commit --no-verify \
    -m "chore: merge $TARGET_BRANCH into custom-main" >/dev/null \
    || { git merge --abort 2>/dev/null || true
         die "failed to commit $TARGET_BRANCH into custom-main"; }
fi

git diff --quiet "$TARGET_BRANCH" custom-main \
  || die "custom-main tree differs from validated $TARGET_BRANCH after merge"
log "[ok] custom-main now matches the validated release tree"

# ══════════════════════════════════════════════════════════════════════════════
# 9. Deploy + restart gateway
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$SKIP_DEPLOY" != "true" ]]; then
  step "deploy to $DEPLOY_TARGET"

  # ── Backup current install ──
  mkdir -p "$BACKUP_DIR"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  BACKUP_FILE="$BACKUP_DIR/openclaw-pre-${LATEST_TAG}-${STAMP}.tar.gz"
  if [[ -d "$DEPLOY_TARGET/dist" ]]; then
    log "backup → $BACKUP_FILE"
    DEPLOY_NAME="$(basename "$DEPLOY_TARGET")"
    BACKUP_MEMBERS=()
    for backup_item in dist openclaw.mjs package.json extensions skills; do
      [[ -e "$DEPLOY_TARGET/$backup_item" ]] \
        && BACKUP_MEMBERS+=("$DEPLOY_NAME/$backup_item")
    done
    tar czf "$BACKUP_FILE" \
      -C "$(dirname "$DEPLOY_TARGET")" \
      "${BACKUP_MEMBERS[@]}" \
      || die "failed to back up current deployment"
    # Rotate: keep only the newest N backups without whitespace-sensitive
    # ls/xargs parsing.
    mapfile -d '' BACKUP_ENTRIES < <(
      find "$BACKUP_DIR" -maxdepth 1 -type f -name 'openclaw-pre-*.tar.gz' \
        -printf '%T@ %p\0' | sort -z -nr
    )
    for (( backup_index = MAX_BACKUPS; backup_index < ${#BACKUP_ENTRIES[@]}; backup_index++ )); do
      backup_path="${BACKUP_ENTRIES[$backup_index]#* }"
      [[ "$(dirname "$backup_path")" == "$BACKUP_DIR" ]] \
        || die "refusing to prune backup outside $BACKUP_DIR: $backup_path"
      rm -f -- "$backup_path"
    done
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
  systemctl --user restart "$SERVICE_NAME" \
    || die "failed to restart $SERVICE_NAME"
  gateway_ready="false"
  for (( gateway_attempt=1; gateway_attempt<=10; gateway_attempt++ )); do
    if systemctl --user is-active --quiet "$SERVICE_NAME"; then
      gateway_ready="true"
      break
    fi
    sleep 3
  done
  [[ "$gateway_ready" == "true" ]] \
    || die "$SERVICE_NAME did not become active after restart; check: journalctl --user -u $SERVICE_NAME -n 40"
  log "gateway restarted successfully"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 10. Push + cleanup
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$PUSH" == "true" ]]; then
  step "push branches"
  git push origin custom-main --force-with-lease --quiet
  git push origin "$TARGET_BRANCH" --force-with-lease --quiet
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
