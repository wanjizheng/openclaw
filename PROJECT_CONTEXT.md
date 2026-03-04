# PROJECT_CONTEXT.md — OpenClaw System Overview

> Quick reference for anyone (human or AI) working on this system.
> Last generated: 2026-03-04

---

## Project Overview（项目概览）

**OpenClaw** is a personal AI assistant that runs on your own infrastructure. It answers you through the messaging channels you already use (Discord, WhatsApp, Telegram, Slack, Signal, iMessage, Google Chat, IRC, Microsoft Teams, Matrix, Feishu, LINE, Mattermost, Nextcloud Talk, Nostr, Synology Chat, Tlon, Twitch, Zalo, WebChat) and can speak/listen via voice calls (Twilio). The Gateway is the control plane — the product is the assistant.

This is a **custom fork** (`openclaw-fork`) of the upstream [openclaw/openclaw](https://github.com/openclaw/openclaw) repository. The fork adds:

- Voice-call enhancements (streaming LLM + TTS, contact-aware inbound, post-call reporting)
- DeepSeek `<think>` tag stripping for clean user-facing output
- Discord voice message multipart fixes
- Gateway dev-guard to prevent prod/dev conflicts
- Automated upstream sync workflow

### Main Goals（主要目标）

1. Personal, single-user AI assistant — local, fast, always-on
2. Multi-channel messaging (20+ platforms)
3. Voice call support via Twilio (inbound + outbound)
4. Privacy-first — runs on your own devices/servers
5. Extensible via a plugin/extension system

---

## Technology Stack（技术栈）

| Category        | Technology                                             |
| --------------- | ------------------------------------------------------ |
| Language        | TypeScript (ESM, strict mode)                          |
| Runtime         | Node.js ≥ 22 (Bun also supported for dev/scripts)      |
| Package Manager | pnpm 10.x (`pnpm-workspace.yaml` monorepo)             |
| Build           | tsdown → `dist/`                                       |
| Lint / Format   | Oxlint + Oxfmt (`pnpm check`)                          |
| Tests           | Vitest with V8 coverage (70% threshold)                |
| CLI Framework   | Commander + @clack/prompts                             |
| Web Framework   | Express 5.x (Gateway HTTP)                             |
| AI Providers    | OpenAI, DeepSeek, Anthropic, Google, Bedrock, etc.     |
| Voice           | Twilio (voice-call extension), ElevenLabs TTS          |
| Database        | SQLite (sqlite-vec for embeddings)                     |
| UI              | Lit (web components, `ui/` directory)                  |
| Mobile          | Swift (macOS/iOS), Kotlin (Android)                    |
| LLM Gateway     | Custom Python FastAPI proxy (`llm-gateway/gateway.py`) |
| Docs            | Mintlify (docs.openclaw.ai)                            |

---

## Key Components（核心组件）

| Component             | Location                                                                                             | Description                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Gateway Server        | `src/gateway/`                                                                                       | Central control plane, HTTP + WS server                |
| CLI                   | `src/cli/`, `src/commands/`                                                                          | Command-line interface and commands                    |
| Entry Point           | `openclaw.mjs` → `dist/index.js`                                                                     | CLI bootstrap and main entry                           |
| AI Router             | `src/providers/`                                                                                     | Multi-model AI provider routing                        |
| Channels (core)       | `src/telegram/`, `src/discord/`, `src/slack/`, `src/signal/`, `src/imessage/`, `src/web/` (WhatsApp) | Built-in messaging channels                            |
| Channels (extensions) | `extensions/*`                                                                                       | Plugin-based channels (Matrix, MS Teams, Feishu, etc.) |
| Voice Call            | `extensions/voice-call/`                                                                             | Twilio-based voice call system                         |
| Plugin SDK            | `src/plugin-sdk/`                                                                                    | SDK for building extensions                            |
| Node Host             | `src/node-host/`                                                                                     | Worker node execution host                             |
| Agent / Pi            | `src/agents/`, Pi agent deps                                                                         | AI agent runtime and coding agent                      |
| Canvas                | `src/canvas-host/`                                                                                   | Live canvas rendering                                  |
| TUI                   | `src/tui/`                                                                                           | Terminal UI interface                                  |
| Web UI                | `ui/`                                                                                                | Browser-based control UI (Lit)                         |
| LLM Gateway (custom)  | `~/llm-gateway/gateway.py`                                                                           | Python FastAPI proxy for local model routing           |
| Memory                | `extensions/memory-core/`, `extensions/memory-lancedb/`                                              | Persistent memory system                               |
| TTS                   | `src/tts/`                                                                                           | Text-to-speech pipeline                                |

---

## OpenClaw Architecture Overview（架构概览）

```
                 ┌─────────────┐
                 │  LLM Models │  (OpenAI, DeepSeek, local via llm-gateway)
                 └──────┬──────┘
                        │
  ┌─────────────────────┼─────────────────────┐
  │              OpenClaw Gateway              │  Port 18789
  │         (src/gateway/server.ts)            │
  │                                            │
  │  ┌──────────┐  ┌──────────┐  ┌─────────┐  │
  │  │AI Router │  │  Agent   │  │ Control  │  │
  │  │Providers │  │ Runtime  │  │   UI     │  │
  │  └──────────┘  └──────────┘  └─────────┘  │
  │                                            │
  │  ┌──────────┐  ┌──────────┐  ┌─────────┐  │
  │  │ Channels │  │  Plugins │  │  Node   │  │
  │  │ Routing  │  │ (exts)   │  │  Host   │  │
  │  └──────────┘  └──────────┘  └─────────┘  │
  └────┬────┬────┬────┬────┬────┬────┬────┬────┘
       │    │    │    │    │    │    │    │
   Discord Telegram Slack WhatsApp Signal Voice ...
```

---

## Three Directory Structure（三个目录结构）

### 1. Development Repository — Source Code（开发仓库）

```
/home/wanjizheng/openclaw-fork
```

- This is the Git repository where **all code changes** must be made
- Current branch: `custom-main` (fork of upstream `main`)
- Local branches: `custom-main`, `main`, `release-custom/v2026.2.26`, `release-custom/v2026.3.1`, `release-custom/v2026.3.2`

### 2. Deployment Directory — Production Runtime（部署目录）

```
/home/linuxbrew/.linuxbrew/lib/node_modules/openclaw
```

- Contains the **running production instance** (installed via npm)
- **DO NOT modify directly** — changes must go through build/deploy
- Version: 2026.3.2

### 3. Configuration Directory（配置目录）

```
/home/wanjizheng/.openclaw
```

- `openclaw.json` — Main configuration (models, providers, update settings)
- `service.env` — Environment variables (API keys, tokens)
- `.env` — Additional environment overrides
- `start-gateway.sh` — Gateway start script
- `agents/` — Agent session data
- `credentials/` — Authentication credentials
- `discord/` — Discord-specific config
- `extensions/` — Extension config
- `logs/` — Runtime logs
- `voice-calls/` — Voice call data/recordings
- `workspace/` — Workspace files (VOICE_CONTACTS.md, call_logs/, IDENTITY.md)

---

## Development Workflow（开发流程）

```
openclaw-fork (source) → pnpm build → deploy to runtime → restart services
```

### Step-by-step:

1. **Edit** code in `/home/wanjizheng/openclaw-fork`
2. **Build**: `pnpm build`
3. **Deploy**: Sync `dist/`, `openclaw.mjs`, `package.json` to deployment directory
4. **Restart** services:
   ```bash
   systemctl --user restart openclaw-gateway.service
   systemctl --user restart openclaw-node.service
   ```
5. **Validate**: `systemctl --user status openclaw-gateway.service`

### Custom release+deploy script:

```bash
tools/custom/release-integrate-and-build.sh
```

---

## Important Commands（重要命令）

| Command                                   | Description                                         |
| ----------------------------------------- | --------------------------------------------------- |
| `pnpm install`                            | Install dependencies                                |
| `pnpm build`                              | Full build (tsdown + plugin SDK + UI)               |
| `pnpm dev`                                | Run CLI in dev mode                                 |
| `pnpm test`                               | Run test suite (Vitest)                             |
| `pnpm test:coverage`                      | Run tests with coverage                             |
| `pnpm check`                              | Full checks (format + lint + typecheck)             |
| `pnpm format`                             | Auto-format with Oxfmt                              |
| `pnpm lint`                               | Lint with Oxlint                                    |
| `pnpm tsgo`                               | TypeScript type-check                               |
| `pnpm gateway:dev`                        | Start dev gateway (guarded, blocks if prod running) |
| `openclaw onboard`                        | Run onboarding wizard                               |
| `openclaw gateway --port 18789 --verbose` | Start gateway manually                              |
| `openclaw doctor`                         | Run diagnostic checks                               |
| `openclaw channels status --probe`        | Check channel connectivity                          |

---

## Services (systemd)（系统服务）

| Service                            | Status                  | Description                    |
| ---------------------------------- | ----------------------- | ------------------------------ |
| `openclaw-gateway.service`         | enabled                 | Gateway on port 18789          |
| `openclaw-node.service`            | enabled                 | Node Host (worker processes)   |
| `openclaw-voice-reconcile.service` | disabled (timer-driven) | Stale voice call cleanup       |
| `openclaw-voice-reconcile.timer`   | enabled                 | Timer for voice reconciliation |

### Service management:

```bash
systemctl --user status openclaw-gateway.service
systemctl --user restart openclaw-gateway.service
systemctl --user stop openclaw-gateway.service
journalctl --user -u openclaw-gateway.service -f   # follow logs
```

---

## Configuration Locations（配置位置）

| File/Directory              | Purpose                                         |
| --------------------------- | ----------------------------------------------- |
| `~/.openclaw/openclaw.json` | Main config (models, providers, update channel) |
| `~/.openclaw/service.env`   | API keys and service tokens                     |
| `~/.openclaw/.env`          | Additional env vars                             |
| `~/.openclaw/workspace/`    | Workspace files (contacts, identity, call logs) |
| `~/.openclaw/agents/`       | Agent session data                              |
| `~/.openclaw/credentials/`  | Web provider credentials                        |
| `~/.config/systemd/user/`   | systemd service unit files                      |

---

## Important Ports（重要端口）

| Port  | Service          | Description                   |
| ----- | ---------------- | ----------------------------- |
| 18789 | OpenClaw Gateway | Main gateway HTTP + WebSocket |
| 18790 | OpenClaw Bridge  | Bridge port (Docker compose)  |
| 8000  | LLM Gateway      | Local LLM proxy (llm-gateway) |
| 3000  | Fly.io deploy    | Production gateway (Fly only) |

---

## Model Configuration（模型配置）

The system uses a custom LLM gateway at `http://127.0.0.1:8000/v1` (see `llm-gateway/gateway.py`) to route AI requests. Models configured:

- `gpt-5.1` (via uob-ai provider) — primary completion model
- `text-embedding-3-large` — embeddings

Additional providers can be configured in `~/.openclaw/openclaw.json` under `models.providers`.

---

## Known Pitfalls（已知问题）

1. **Never edit the deployment directory directly** — changes will be overwritten on next update
2. **Dev gateway conflicts** — Running `pnpm gateway:dev` while production gateway is active causes Discord interaction conflicts. The guard script blocks this by default.
3. **DeepSeek `<think>` tags** — Custom fork strips these from user-facing replies; be aware during upstream merges
4. **Auto-update version mismatch** — See `AUTO_UPDATE_VERSION_ISSUE.md` for details on version normalization
5. **Voice call singleton** — The voice-call extension uses a module-level singleton to prevent `EADDRINUSE`; be careful with hot-reloads
6. **pnpm patches** — Any dependency with `pnpm.patchedDependencies` must use an exact version (no `^`/`~`)
7. **Node modules** — Never edit `node_modules` in any install; updates overwrite everything
8. **Upstream merges** — See `CUSTOM_CHANGES.md` for conflict-prone zones in voice-call, Discord, and provider-utils
9. **Memory pressure** — Use `OPENCLAW_TEST_PROFILE=low OPENCLAW_TEST_SERIAL_GATEWAY=1 pnpm test` if tests OOM
10. **API keys in service.env** — Never commit real credentials; `service.env` is local-only

---

## Fork Maintenance（分支维护）

- **Upstream remote**: `openclaw/openclaw` (GitHub)
- **Sync workflow**: `.github/workflows/sync-upstream.yml` auto-creates PRs
- **Manual sync**: `tools/custom/update-upstream.sh`
- **Status check**: `tools/custom/status.sh`
- **New custom change**: `tools/custom/new-change.sh`
- **Change log**: `CUSTOM_CHANGES.md` — tracks every custom deviation from upstream
- **Conflict resolution**: git `rerere` is enabled for conflict memory reuse
