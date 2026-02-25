# Custom OpenClaw Workflow

This repository is your long-lived custom fork workflow.

## Branch model

- `upstream/main`: official OpenClaw updates
- `custom-main`: your custom changes on top of upstream

All custom work should be committed on `custom-main`.

## One-time setup

1. Add your own fork as `origin`:
   ```bash
   git remote add origin <your-fork-url>
   ```
2. Push branch:
   ```bash
   git push -u origin custom-main
   ```

## Daily custom change process

1. Make code changes on `custom-main`.
2. Add an entry in `CUSTOM_CHANGES.md` (what changed, why, files).
3. Commit code + log together.

## Update from upstream

Run:
```bash
./tools/custom/update-upstream.sh
```

This will:
1. fetch latest `upstream/main`
2. rebase `custom-main` onto latest upstream
3. keep your custom commits re-applied

If conflicts happen, resolve once and continue rebase.
`rerere` is enabled, so repeated conflicts are auto-resolved in future updates.
