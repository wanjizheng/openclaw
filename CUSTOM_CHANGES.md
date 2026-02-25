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
