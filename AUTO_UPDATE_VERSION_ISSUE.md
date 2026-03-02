# Auto-Update Version Mismatch Issue & Fix

## Problem Summary

When running auto-update skill, users saw version `2026.3.1-beta.1` installed instead of expected stable `2026.3.1`, despite:

- Config set to `"update": { "channel": "stable" }`
- GitHub release showing `v2026.3.1` as latest stable
- npm `latest` tag pointing to `2026.3.1`

## Root Cause

**OpenClaw's release promotion strategy:**

1. They publish beta builds to npm with version `X.Y.Z-beta.N`
2. After testing, they **promote** the beta to stable via `npm dist-tag add openclaw@X.Y.Z-beta.N latest`
3. They **do NOT** update git tags or create new commits with stable version numbers

Result:

- npm `latest` → `2026.3.1` ✓ (dist-tag management)
- Git tag `v2026.3.1` → commit with `package.json` version `2026.3.1-beta.1` ✗

This is documented in their release strategy:

> "We ship builds to beta, test them, then **promote a vetted build to `latest` without changing the version number**"

## Why This Affects Fork Builds

The auto-update skill workflow:

1. Calls `openclaw update --channel stable` → installs from npm `latest` tag ✓
2. Runs `release-integrate-and-build.sh` → checks out git tag `v2026.3.1`
3. Builds from source → `package.json` has `2026.3.1-beta.1` ✗
4. Deploys built artifacts → `openclaw --version` shows `2026.3.1-beta.1` ✗

## Solution Implemented

Added version normalization step in `tools/custom/release-integrate-and-build.sh` (commit `2fc43c07a9`):

```bash
# After build, before deploy:
CURRENT_VERSION="$(jq -r '.version' package.json)"
NORMALIZED_VERSION="${LATEST_TAG#v}"  # v2026.3.1 → 2026.3.1

if [[ "$CURRENT_VERSION" =~ ^([0-9]+\.[0-9]+\.[0-9]+)-beta\.[0-9]+$ ]]; then
  BASE_VERSION="${BASH_REMATCH[1]}"
  if [[ "$BASE_VERSION" == "$NORMALIZED_VERSION" ]]; then
    # Strip -beta.N suffix to match stable release tag
    jq --arg v "$NORMALIZED_VERSION" '.version = $v' package.json > package.json.tmp
    mv package.json.tmp package.json
  fi
fi
```

## Testing

```bash
# Verify v2026.3.1 tag has beta version:
$ git show v2026.3.1:package.json | jq -r '.version'
2026.3.1-beta.1

# Test normalization logic:
$ CURRENT_VERSION="2026.3.1-beta.1"
$ LATEST_TAG="v2026.3.1"
$ NORMALIZED_VERSION="${LATEST_TAG#v}"
$ # Pattern match → BASE_VERSION="2026.3.1"
$ # BASE_VERSION == NORMALIZED_VERSION → patch to 2026.3.1 ✓
```

## Next Auto-Update

On the next auto-update run:

1. `openclaw update` installs from npm (if new version available)
2. `release-integrate-and-build.sh` builds from git tag
3. **NEW:** Version normalization strips `-beta.N` suffix
4. Deployed version matches stable release tag ✓

## Upstream Issue Tracking

This behavior is by design in OpenClaw's release process, but creates confusion for git-based builds. Consider reporting to upstream:

- Suggest creating separate stable git tags when promoting beta to stable
- Or document this in release notes for fork maintainers

## Related Files

- Fix: [tools/custom/release-integrate-and-build.sh](tools/custom/release-integrate-and-build.sh#L355-L373)
- Commit: `2fc43c07a9` on `custom-main`
- Auto-update skill: `~/.openclaw/workspace/skills/auto-update/`

## References

- OpenClaw docs: [Development Channels](https://docs.openclaw.ai/install/development-channels)
- npm registry: https://registry.npmjs.org/openclaw/latest → `"version": "2026.3.1"`
- npm registry: https://registry.npmjs.org/openclaw/beta → `"version": "2026.3.1-beta.1"`
- GitHub releases: https://github.com/openclaw/openclaw/releases/tag/v2026.3.1
