# Custom Changes Log

Track every custom behavior you add.
Each entry should explain:
- What changed
- Why it was needed
- Which files were touched
- User-visible behavior

## 2026-02-25

### Bootstrap: custom-fork maintenance workflow
- What changed:
  - Added persistent custom workflow docs and scripts.
  - Created `custom-main` branch on top of upstream.
  - Enabled git `rerere` for conflict reuse.
- Why:
  - Keep custom behavior maintainable across OpenClaw updates.
- Files:
  - `docs/custom/CUSTOM_WORKFLOW.md`
  - `tools/custom/update-upstream.sh`
  - `tools/custom/status.sh`
  - `tools/custom/new-change.sh`
  - `CUSTOM_CHANGES.md`
- User-visible behavior:
  - You can now update upstream and reapply custom commits predictably.

### Add automated upstream sync PR workflow
- What changed:
  - Added a scheduled GitHub Action to fetch `openclaw/openclaw` and create/update a sync PR into `custom-main`.
  - Extended workflow documentation with auto-sync behavior and conflict expectations.
- Why:
  - Keep fork current automatically while preserving review control and custom commit history.
- Files:
  - `.github/workflows/sync-upstream.yml`
  - `docs/custom/CUSTOM_WORKFLOW.md`
- User-visible behavior:
  - Upstream updates appear as PRs automatically; you merge when ready.
