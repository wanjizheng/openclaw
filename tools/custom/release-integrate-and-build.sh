#!/usr/bin/env bash
# release-integrate-and-build.sh — Full custom release pipeline
#
# Workflow (matches user requirement exactly):
#   1. Require a clean worktree (never auto-commit or discard local changes)
#   2. Fetch upstream + tags
#   3. Find latest stable release tag (e.g. v2026.2.26)
#   4. Merge latest stable tag into custom-main (preserve custom-main history)
#   5. Collect ONLY custom commits (<latest-tag>..custom-main), excluding
#      upstream/main and filtering known legacy snapshot/update commits
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
SYNC_CUSTOM_MAIN="false"
MAX_CUSTOM_COMMITS="300"
AUTO_SLIM_COMMITS="false"
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
    --sync-custom-main)  SYNC_CUSTOM_MAIN="true"; shift ;;
    --max-custom-commits) MAX_CUSTOM_COMMITS="${2:-300}"; shift 2 ;;
    --auto-slim-commits) AUTO_SLIM_COMMITS="true"; shift ;;
    --no-auto-slim-commits) AUTO_SLIM_COMMITS="false"; shift ;;
    --conflict-strategy) CONFLICT_STRATEGY="${2:-stop}"; shift 2 ;;
    --reuse-existing)     REUSE_EXISTING="true"; shift ;;
    --no-strict-typecheck) STRICT_TYPECHECK="false"; shift ;;
    --deploy-target)     DEPLOY_TARGET="${2:?}"; shift 2 ;;
    *) die "unknown arg: $1" ;;
  esac
done

[[ "$CONFLICT_STRATEGY" =~ ^(prefer-custom|stop)$ ]] \
  || die "--conflict-strategy must be prefer-custom|stop"

if [[ "$CONFLICT_STRATEGY" == "prefer-custom" ]]; then
  log "WARN: --conflict-strategy=prefer-custom is unsafe across re-port chains (cross-file symbol drop)."
  log "      Maintain it manually and run verify_cross_file_symbols after the build, or set OPENCLAW_ALLOW_PREFER_CUSTOM=true explicitly to suppress this message."
fi

[[ "$MAX_CUSTOM_COMMITS" =~ ^[0-9]+$ ]] \
  || die "--max-custom-commits must be a non-negative integer"

[[ "$AUTO_SLIM_COMMITS" =~ ^(true|false)$ ]] \
  || die "auto-slim commit option parse failed"

if [[ "$AUTO_SLIM_COMMITS" == "true" ]]; then
  log "WARN: --auto-slim-commits deduplicates commits by subject and may omit intentional repeated changes"
fi

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
ORIGINAL_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"

# ══════════════════════════════════════════════════════════════════════════════
# 1. Require a clean worktree
# ══════════════════════════════════════════════════════════════════════════════
if [[ -n "$(git status --porcelain)" ]]; then
  die "dirty worktree; commit or move local changes before release integration"
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

# Refuse to replay a custom commit train across calendar release trains.
# vYYYY.M.patch -> train YYYY.M. Re-porting across trains requires semantic
# review because upstream may have moved or deleted fork-touched symbols.
BASE_TAG="$(git tag --merged custom-main -l 'v*' \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+' \
  | grep -Evi 'alpha|beta|rc|pre' \
  | sort -V | tail -n 1 || true)"
[[ -n "$BASE_TAG" ]] || die "cannot determine stable base tag reachable from custom-main"
LATEST_TRAIN="$(printf '%s' "${LATEST_TAG#v}" | cut -d. -f1,2)"
BASE_TRAIN="$(printf '%s' "${BASE_TAG#v}" | cut -d. -f1,2)"
if [[ "$BASE_TRAIN" != "$LATEST_TRAIN" ]]; then
  if [[ "${OPENCLAW_ALLOW_MAJOR_DRIFT:-false}" != "true" ]]; then
    die "release-train drift: custom-main base=$BASE_TAG, latest=$LATEST_TAG. Semantic re-port required; set OPENCLAW_ALLOW_MAJOR_DRIFT=true only after manual review"
  fi
  log "WARN: release-train drift override accepted: base=$BASE_TAG latest=$LATEST_TAG"
else
  log "[ok] release-train check passed: base=$BASE_TAG latest=$LATEST_TAG"
fi

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
      git merge --abort 2>/dev/null || true
      die "merge $LATEST_TAG into custom-main failed"
    fi
  fi
  log "custom-main sync finished"
else
  log "skip latest-tag merge (use --sync-custom-main to enable)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 5. Collect custom-only commits
#    Use first-parent mainline only; exclude commits already reachable from
#    upstream/main or any upstream/release/* branch (those are upstream
#    release-engineering commits, not fork changes). Then slim noisy repeated
#    subjects.
# ══════════════════════════════════════════════════════════════════════════════
step "collecting custom commits"
UPSTREAM_EXCLUDES=("^upstream/main")
while IFS= read -r rb; do
  rb="${rb#"${rb%%[![:space:]]*}"}"
  [[ -n "$rb" ]] || continue
  UPSTREAM_EXCLUDES+=("^${rb}")
done < <(git branch -r --list 'upstream/release/*' 2>/dev/null | sed 's/^[[:space:]]*//')
log "excluding $((${#UPSTREAM_EXCLUDES[@]} - 1)) upstream release branch(es) from cherry-pick list"
mapfile -t CUSTOM_COMMITS < <(
  git --no-pager log --first-parent --reverse --no-merges --pretty=%H "${LATEST_TAG}..custom-main" "${UPSTREAM_EXCLUDES[@]}"
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

# Upstream re-port commits (`feat(upgrade): re-port <old-tag> custom changes
# onto <new-tag>`) capture a stale snapshot of the fork vs an OLD upstream
# base. Re-applying them onto a much newer base via cherry-pick re-creates
# the very cross-file drift that broke the 2026-07-01 release-custom build
# (the `feat(upgrade): re-port v2026.5.28 custom changes onto v2026.6.1`
# commit, cherry-picked onto v2026.6.11, caused timers.ts to lose its
# upstream `ensureMaxDurationTimerForLiveCall` export while events.ts
# kept its new caller of that function). Drop these from the cherry-pick
# list. If the cherry-pick is genuinely needed for a specific file path,
# it'll be picked up via the per-file diff in the integration script's
# branch creation step (release branch from <LATEST_TAG>); the re-port
# itself is NOT needed because the fork's custom-main already reflects
# the merged state.
is_upstream_re_port_subject() {
  local subject="$1"
  [[ "$subject" =~ ^feat\(upgrade\):[[:space:]]+re-port[[:space:]].+custom[[:space:]]changes[[:space:]]+onto[[:space:]] ]] \
    && return 0
  return 1
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
      git checkout custom-main -- "$script_path" 2>/dev/null \
        || die "failed to restore protected helper from custom-main: $script_path"
      git add "$script_path" 2>/dev/null \
        || die "failed to stage protected helper: $script_path"
      changed=1
    fi
  done

  if [[ "$changed" -eq 1 ]] && ! git diff --cached --quiet 2>/dev/null; then
    git -c core.hooksPath=/dev/null commit \
      -m "chore(custom): keep protected helper scripts from custom-main" \
      --no-verify 2>/dev/null \
      || die "failed to commit protected helper scripts on the release branch"
  fi
}

FILTERED_CUSTOM_COMMITS=()
for sha in "${CUSTOM_COMMITS[@]}"; do
  subject="$(git --no-pager show -s --format=%s "$sha")"
  if is_legacy_autoupdate_subject "$subject"; then
    log "  skip (legacy auto-update commit): $(git --no-pager log --oneline -1 "$sha")"
    continue
  fi
  if is_upstream_re_port_subject "$subject"; then
    log "  skip (re-port commit; unsafe across major-version drift): $(git --no-pager log --oneline -1 "$sha")"
    continue
  fi
  FILTERED_CUSTOM_COMMITS+=("$sha")
done
CUSTOM_COMMITS=("${FILTERED_CUSTOM_COMMITS[@]}")

if (( ${#CUSTOM_COMMITS[@]} == 0 )); then
  die "all candidate custom commits were filtered out as legacy auto-update / re-port commits"
fi

log "found ${#CUSTOM_COMMITS[@]} custom commit(s) to cherry-pick:"
for sha in "${CUSTOM_COMMITS[@]}"; do
  log "  $(git --no-pager log --oneline -1 "$sha")"
done

# ══════════════════════════════════════════════════════════════════════════════
# 6. Create release branch from tag + cherry-pick custom commits
# ══════════════════════════════════════════════════════════════════════════════
TARGET_BRANCH="release-custom/${LATEST_TAG}"

# ── --reuse-existing fast-path ────────────────────────────────────────────────
# Used by the auto-update orchestrator when it has detected that custom-main
# already contains the integration for $LATEST_TAG (release-custom/<tag> has
# been merged into custom-main's first-parent). In that case the cherry-pick
# step would be a no-op duplicated work — skip straight to rebuilding the
# existing release branch (still re-running pnpm install + pnpm build to
# refresh dist/ before deploy).
#
# Pre-conditions for skipping:
#   1. $REUSE_EXISTING = "true" (set by `--reuse-existing`)
#   2. refs/heads/$TARGET_BRANCH exists locally
#   3. The branch's first non-merge parent is exactly $LATEST_TAG (i.e. it's
#      an integration for this tag, not for some older tag the user forgot
#      to clean up)
#   4. The branch has at least one commit past $LATEST_TAG (i.e. it isn't an
#      empty branch pointing right at the tag)
if [[ "$REUSE_EXISTING" == "true" ]]; then
  if ! git show-ref --verify --quiet "refs/heads/$TARGET_BRANCH"; then
    log "[warn] --reuse-existing requested but refs/heads/$TARGET_BRANCH missing; falling back to full pipeline"
    REUSE_EXISTING="false"
  elif ! git merge-base --is-ancestor "$LATEST_TAG" "$TARGET_BRANCH"; then
    log "[warn] --reuse-existing but $TARGET_BRANCH doesn't descend from $LATEST_TAG; falling back to full pipeline"
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

discard_cherry_pick_attempt() {
  if git rev-parse --verify -q CHERRY_PICK_HEAD >/dev/null 2>&1; then
    git cherry-pick --abort \
      || die "failed to abort the current cherry-pick"
  else
    git restore --source=HEAD --staged --worktree -- . \
      || die "failed to restore the clean generated release branch"
  fi
}

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
      discard_cherry_pick_attempt
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
    discard_cherry_pick_attempt
    return 0
  fi

  if ! HUSKY=0 LEFTHOOK=0 git -c core.hooksPath=/dev/null \
    commit -C "$sha" --no-verify 2>/dev/null; then
    discard_cherry_pick_attempt
    die "failed to commit resolved cherry-pick: $short"
  fi
}

for sha in "${CUSTOM_COMMITS[@]}"; do
  cherry_pick_one "$sha"
done

sync_protected_scripts_from_custom_main

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
    if [[ "$CONFLICT_STRATEGY" == "stop" ]]; then
      git merge --abort 2>/dev/null || true
      die "merge conflict while integrating $TARGET_BRANCH into custom-main"
    fi
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
    git commit --no-edit --no-verify 2>/dev/null \
      || die "failed to commit resolved merge into custom-main"
  fi
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
