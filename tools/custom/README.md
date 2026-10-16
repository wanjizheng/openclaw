# Custom release workflow

Preparation and deployment have separate commands. Neither merges custom-main
or pushes. The retired update-upstream.sh refuses its old -X ours workflow.

## Prepare from a clean fork

Commit the reviewed tools/custom/upstream-base.json alongside customization. It
identifies the exact previous npm version and packaged source commit. The tool
checks the receipt against the registry tarball, then verifies the official tag
and available release branch. Numeric npm revisions retain their exact identity
and use the base version's Git anchor.

```
tools/custom/release-integrate-and-build.sh \
  --out "$HOME/.openclaw-custom-releases/prepare-2026.10.4"
```

Preparation clones into the output directory, creates releasecandidate/v..., and
replays only previous official source -> customization HEAD. It never uses the
target's merge-base to identify customization. Conflicts stop with the candidate
and conflicts.json intact. The original branch remains unchanged. A future
same-version force preparation follows this same isolated process. Even a clean
three-way apply stops at semantic-review-required, without committing/building.
Inspect integration.json and the full staged diff; then explicitly build the
reviewed candidate using stage. Automatic text merging is never semantic review.

The candidate engines.node and packageManager are authoritative. Set
OPENCLAW_CUSTOM_NODE and OPENCLAW_CUSTOM_PNPM to compatible executables when
host defaults differ. There is no Node 25 fallback.

## Package the isolated review tree

```
python3 tools/custom/custom-release.py stage \
  --repo "$PWD" --allow-dirty-review \
  --out "$HOME/.openclaw-custom-releases/review-packages"
```

releasecandidate/ branches are accepted normally. An upgrade/ review branch
requires the explicit dirty-review flag. This records the complete source
inventory/hash, including uncommitted files; it never commits that checkout.
The build uses core/UI build and canonical Docker npm packaging, then separately
builds and npm-packs customized voice-call and Discord using each independent
plugin runtime builder and production package-manifest owner. Dependency manifests come from those
packagers; no source package.json overlay or manually copied dist is used.

--skip-build additionally requires --build-receipt naming a generated
build-source.json with the same HEAD and source hash. A commit match alone does
not establish dirty-build freshness.

```
python3 tools/custom/custom-release.py verify \
  --receipt /absolute/packages/release.json --check-source
```

The release contract is `openclaw.custom-release.v2`: exactly three roles are
required: core=`openclaw`, voice=`@openclaw/voice-call`, and
Discord=`@openclaw/discord`. Each package name, version, archive and member hash
is checked independently; swapped roles are refused. Historical v1 core+voice
receipts remain historical evidence and are refused for verify/deploy/publication
by this tool. Build a fresh complete v2 release; do not edit old receipts or fill
the missing role from the public registry. Previously captured transaction
checkpoints can still be recovered without adopting the new release contract.
Review receipts contain source paths/hashes, never live config or databases.

## Explicit deployment and recovery

Copy deploy-plan.example.json and replace every path with the host layout.
Review all includes, agent/workspace/plugin roots and dependency links. External
paths, systemd metadata and binary metadata must be explicit. Dependency links
escaping that recovery closure cause refusal. Declare `pluginProjectsDir` as
the physical managed npm projects directory (normally state/npm/projects),
covered in full by the checkpoint. This replaces the v1 `voiceProjectsDir` field.
The entire tree, including both plugins' rotated/retired generations and their
dependencies, is checked for links escaping the reviewed recovery scope.

After each native CLI npm-pack installation, the tool independently resolves its
plugins-list rootDir inside that reviewed projects directory, requires the exact
node_modules/@openclaw/voice-call or node_modules/@openclaw/discord layout, a
contained packaged source entry, exact package name/version and every runtime
member hash. Symlinked package members/roots and out-of-scope shadows are refused.
Project generation names are intentionally not pinned.

The plan's configPath must identify a reviewed configuration adapted to the
candidate. Do not promote an old configuration unchanged or assume Doctor can
migrate every custom field. In particular, the former messages.tts location must
be adapted to top-level tts for this baseline. Review and validate that adaptation
in isolated rehearsal first; this tool does not silently rewrite this custom
migration. Existing explicit voice-call/Discord plugin enablement and channel
configuration must select the reviewed custom packages. Deployment validates the
configuration after installation; failure triggers rollback before old services
restart.

```
python3 tools/custom/custom-release.py deploy \
  --receipt /absolute/packages/release.json \
  --plan /absolute/private/deploy-plan.json \
  --transaction /absolute/private/transaction \
  --execute-deployment
```

Deployment stops both services and verifies they stopped, then archives the full
core installation/dependencies, state (SQLite/WAL/SHM), external roots, binary
links and service metadata. Unrelated npm-prefix packages are excluded. Private
checkpoints must live outside archived paths and never enter review ZIPs.

Deployment requires a reviewed npm 11.x executable (plan npmExecutable or
OPENCLAW_CUSTOM_NPM). Node/pnpm build pins are independent. npm 12 blocks core
postinstall and native dependency lifecycle scripts by default and is rejected
before stopping services. Do not enable wildcard/global scripts to bypass this
gate; select npm 11.x explicitly.

The exact core tarball uses the selected npm 11 installation with the scoped
--ignore-scripts=false flag, overriding an inherited ignore-scripts setting
without changing global npm configuration. Local npm-pack archives retain their
local-source trust class; custom naming never implies official/ClawHub trust. Both
custom plugin tarballs use managed npm-pack: installation; no registry fallback
is allowed. Plugin install and Doctor receive
OPENCLAW_SERVICE_REPAIR_POLICY=external and cannot activate services. Services
must remain stopped through migration. Plugin installation uses the explicit
package-swap phase. After both custom packages are verified, the final Doctor
runs with the native post-core-convergence marker, with Gateway activation and
service repair forbidden. Ordinary catalog/readiness calls clear inherited
update-phase markers. No second external Doctor handoff is required.
After config validation the tool starts
services and waits for the readiness deadline. Success requires matching
core/CLI/Gateway identities and CLI physical root/source/member hashes for both
plugins. The Gateway plugins.list RPC returns projected catalog metadata and
active-registry state, without rootDir/source. The tool checks both required IDs,
fixed package names, version and origin matching the CLI record, installed/enabled
flags and active state; it does not claim RPC path equivalence or actual loaded
JavaScript module source identity. The CLI record need not have packageName: its
package name/version are checked directly in the physical package.json. Real
adapter sending/voice acceptance remains a separate runtime gate.

For the isolated real-call fixture, OPENCLAW_SKIP_CHANNELS=1 skips inbound
channel network startup while still registering the enabled Discord plugin and
its outbound adapter. An active Discord registry owner does not by itself prove
a report was delivered; verify the official adapter send and explicit target in
the authorized real-call acceptance.

A failure restores state and the complete install closure before starting old
services. Restored archive bytes and metadata are compared before restart,
including both managed plugin generations. Failed rollback retains journal/checkpoints and reports failure.
Recover a killed transaction explicitly:

```
python3 tools/custom/custom-release.py recover \
  --transaction /absolute/private/transaction --execute-deployment
```

Recovery restores the saved generation; it never reinstalls, rebuilds, migrates
again or publishes. Verified/rolled-back transactions are idempotent no-ops.

Publication is a separate publish command requiring a verified deployment,
unchanged source/packages, clean built generation and explicit releasecandidate/
destination. It never merges or publishes custom-main. Building alone never
authorizes deployment, publication or service actions.

## Verification boundary

```
python3 tools/custom/test_custom_release.py -v
```

Synthetic tests cover exact baseline selection, source branch isolation, numeric
revision anchors, Node bounds, hash tampering refusal, full state/dependency
rollback order, Discord dependency scope, strict three-role receipts and
canonical packaging, native Discord mismatch rollback before restart, both
plugin CLI member hashes, the actual path-free Gateway projection and rejected
package/version/origin/install/enable metadata mismatches, service repair policy
and bounded readiness. They do not prove
real npm installation, service activation, database bridge migration or telephony.
Those need a copied-state installation rehearsal and authorized maintenance
window.
