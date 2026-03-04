# GitHub Copilot Instructions — OpenClaw Fork

## Before Answering Any Question

1. Read `PROJECT_CONTEXT.md` — understand the system layout and three-directory structure
2. Read `ARCHITECTURE.md` — understand module map, data flow, and service topology
3. Follow `AGENTS.md` rules — ESPECIALLY the directory safety rules

## Critical Safety Rules

- **NEVER suggest edits** to `/home/linuxbrew/.linuxbrew/lib/node_modules/openclaw/` — this is the deployment runtime
- **ALWAYS** target `/home/wanjizheng/openclaw-fork/` for code changes
- **NEVER** commit or expose API keys, tokens, or credentials
- Changes require: edit source → `pnpm build` → deploy → restart services

## When Suggesting Code

1. **Modify existing modules first** — search for existing implementations before creating new files
2. **Avoid duplication** — import from centralized utilities (`src/infra/`, `src/terminal/`, `src/utils/`)
3. **Minimise structural changes** — prefer targeted fixes over large refactors
4. **Respect file size** — keep files under ~700 LOC; extract helpers when needed
5. **Follow TypeScript ESM conventions** — strict mode, no `any`, `.js` extensions in imports

## Tech Stack Quick Reference

- **Language**: TypeScript (ESM, strict mode)
- **Runtime**: Node.js ≥ 22
- **Package Manager**: pnpm 10.x (monorepo via `pnpm-workspace.yaml`)
- **Build**: `pnpm build` (tsdown → `dist/`)
- **Test**: `pnpm test` (Vitest, 70% V8 coverage threshold)
- **Lint**: `pnpm check` (Oxlint + Oxfmt)
- **Entry**: `openclaw.mjs` → `dist/index.js`
- **Gateway port**: 18789

## Source Locations

| What               | Where                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| Gateway server     | `src/gateway/`                                                           |
| CLI commands       | `src/cli/`, `src/commands/`                                              |
| AI providers       | `src/providers/`                                                         |
| Core channels      | `src/telegram/`, `src/discord/`, `src/slack/`, `src/signal/`, `src/web/` |
| Extension channels | `extensions/*/`                                                          |
| Voice calls        | `extensions/voice-call/`                                                 |
| Plugin SDK         | `src/plugin-sdk/`                                                        |
| Terminal utilities | `src/terminal/` (table, palette)                                         |
| Formatting         | `src/infra/` (time, etc.)                                                |
| Tests              | Colocated `*.test.ts`                                                    |
| Build output       | `dist/`                                                                  |
| Config             | `~/.openclaw/openclaw.json`                                              |

## Formatting & Linting

- Run `pnpm check` before suggesting commits
- Use `pnpm format` (Oxfmt) for auto-formatting
- Never add `@ts-nocheck` or disable `no-explicit-any`
- Use `import type { X }` for type-only imports

## Custom Fork Awareness

This is a **custom fork** on branch `custom-main`. When suggesting changes:

- Check `CUSTOM_CHANGES.md` for existing customizations
- Voice-call extension has significant custom modifications
- DeepSeek `<think>` tag stripping is a custom addition
- Discord voice multipart handling is custom
- The gateway dev-guard script is custom

## Plugin Development

- Extensions live in `extensions/<name>/`
- Each has its own `package.json`
- Runtime deps in `dependencies`, `openclaw` in `devDependencies` or `peerDependencies`
- Avoid `workspace:*` in `dependencies`
- SDK import: `openclaw/plugin-sdk`

## If Unsure

Ask the user. Do not guess about:

- Which directory to edit
- Whether a change affects the production runtime
- API key or credential handling
- Upstream merge conflicts
