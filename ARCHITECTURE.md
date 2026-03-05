# ARCHITECTURE.md — OpenClaw System Architecture

> System architecture documentation for this OpenClaw fork.
> Last generated: 2026-03-04

---

## High-Level System Diagram（系统架构总览）

```
  ┌────────────────────────────────────────────────────────────────────┐
  │                        Messaging Channels                          │
  │                                                                    │
  │  Discord  Telegram  WhatsApp  Slack  Signal  iMessage  Feishu     │
  │  Matrix   MS Teams  Google Chat  IRC  LINE  Mattermost  Nostr     │
  │  Twitch   Tlon  Zalo  Synology Chat  Nextcloud Talk  WebChat      │
  └──────────────────────────┬─────────────────────────────────────────┘
                             │  Inbound messages / webhooks
                             ▼
  ┌────────────────────────────────────────────────────────────────────┐
  │                      OpenClaw Gateway                              │
  │                   (Port 18789 — HTTP + WS)                         │
  │                                                                    │
  │  ┌──────────────┐  ┌──────────────┐  ┌─────────────────────────┐  │
  │  │  Channel      │  │  AI Router   │  │  Control UI (Lit)       │  │
  │  │  Router       │  │  + Providers │  │  Web dashboard          │  │
  │  └──────┬───────┘  └──────┬───────┘  └─────────────────────────┘  │
  │         │                 │                                        │
  │  ┌──────┴───────┐  ┌─────┴────────┐  ┌─────────────────────────┐  │
  │  │  Routing &   │  │  Agent       │  │  Hooks & Cron           │  │
  │  │  Pairing     │  │  Runtime     │  │  Engine                 │  │
  │  └──────────────┘  └──────────────┘  └─────────────────────────┘  │
  │                                                                    │
  │  ┌──────────────┐  ┌──────────────┐  ┌─────────────────────────┐  │
  │  │  Plugin      │  │  Node Host   │  │  Security & Auth        │  │
  │  │  Manager     │  │  (Workers)   │  │  (device-pair, roles)   │  │
  │  └──────────────┘  └──────────────┘  └─────────────────────────┘  │
  └────────────────────────────┬───────────────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │  LLM Models  │  │  Voice Call  │  │  Browser     │
  │  (via proxy) │  │  (Twilio)    │  │  (Playwright)│
  └──────────────┘  └──────────────┘  └──────────────┘
       │
       ▼
  ┌──────────────────────────────────────┐
  │  LLM Gateway (Python FastAPI)        │
  │  Port 8000 — /v1/chat/completions    │
  │  Routes to: OpenAI, DeepSeek, etc.   │
  └──────────────────────────────────────┘
```

---

## Service Topology（服务拓扑）

```
  systemd user services
  ═══════════════════════════════════════════════════

  openclaw-gateway.service  (enabled, always)
      │
      │  ExecStart: node .../dist/index.js gateway --port 18789
      │  Restarts: always (5s delay)
      │
      └──► HTTP/WS on 127.0.0.1:18789

  openclaw-node.service     (enabled, always)
      │
      │  ExecStart: node .../dist/index.js node run --host 127.0.0.1 --port 18789
      │  Connects to gateway as worker
      │
      └──► Runs agent tasks, tool execution, browser sessions

  openclaw-voice-reconcile.timer  (enabled)
      │
      └──► Triggers oneshot service every N minutes
           Runs: python3 openclaw-voice-reconcile.py --stale-seconds 900
```

---

## Module Map（模块地图）

### Source Directory: `src/`

```
src/
├── entry.ts / index.ts        # Main entry points
├── runtime.ts                 # Runtime bootstrap
├── globals.ts                 # Global constants
│
├── cli/                       # CLI wiring and option parsing
├── commands/                  # CLI command implementations
│
├── gateway/                   # ★ CORE: Gateway server
│   ├── server.ts              #   Main server orchestration
│   ├── server.impl.ts         #   Server implementation
│   ├── auth.ts                #   Authentication
│   ├── boot.ts                #   Gateway startup
│   ├── hooks.ts               #   Hook system
│   ├── call.ts                #   Call handling
│   └── server-*               #   Server subsystems
│
├── providers/                 # AI model providers (OpenAI, Anthropic, etc.)
├── routing/                   # Message routing engine
├── channels/                  # Channel abstraction layer
│
├── telegram/                  # Telegram channel (core)
├── discord/                   # Discord channel (core)
├── slack/                     # Slack channel (core)
├── signal/                    # Signal channel (core)
├── imessage/                  # iMessage channel (core)
├── web/                       # WhatsApp Web channel (core)
├── whatsapp/                  # WhatsApp utilities
│
├── agents/                    # Agent runtime and orchestration
├── acp/                       # Agent Client Protocol
├── sessions/                  # Session management
├── memory/                    # Memory/context system
│
├── plugins/                   # Plugin loading and management
├── plugin-sdk/                # Plugin SDK for extensions
├── node-host/                 # Node worker host
│
├── tts/                       # Text-to-speech pipeline
├── media/                     # Media processing pipeline
├── media-understanding/       # Media analysis
├── link-understanding/        # URL/link analysis
├── browser/                   # Browser automation (Playwright)
│
├── canvas-host/               # Canvas rendering
├── tui/                       # Terminal UI
├── terminal/                  # Terminal utilities (table, palette)
│
├── infra/                     # Infrastructure utilities
├── config/                    # Configuration management
├── hooks/                     # Hook definitions
├── cron/                      # Scheduled tasks
├── daemon/                    # Daemon/service management
├── process/                   # Process management
│
├── security/                  # Security policies
├── pairing/                   # Device pairing
├── secrets/                   # Secret management
│
├── i18n/                      # Internationalization
├── logging/                   # Logging infrastructure
├── utils/                     # Shared utilities
├── shared/                    # Shared types and helpers
├── types/                     # TypeScript type definitions
└── test-helpers/              # Test utilities
```

### Extensions Directory: `extensions/`

```
extensions/
├── voice-call/        # ★ Twilio voice calls (heavily customized in this fork)
├── discord/           # Additional Discord features
├── telegram/          # Additional Telegram features
├── slack/             # Additional Slack features
├── signal/            # Additional Signal features
├── imessage/          # Additional iMessage features
├── whatsapp/          # WhatsApp extension
│
├── matrix/            # Matrix protocol
├── msteams/           # Microsoft Teams
├── googlechat/        # Google Chat
├── feishu/            # Feishu/Lark
├── irc/               # IRC protocol
├── line/              # LINE
├── mattermost/        # Mattermost
├── nostr/             # Nostr protocol
├── tlon/              # Tlon
├── twitch/            # Twitch
├── bluebubbles/       # BlueBubbles (iMessage bridge)
├── synology-chat/     # Synology Chat
├── nextcloud-talk/    # Nextcloud Talk
├── zalo/              # Zalo
├── zalouser/          # Zalo Personal
│
├── memory-core/       # Core memory system
├── memory-lancedb/    # LanceDB vector memory
├── lobster/           # Lobster TUI extension
├── diffs/             # Diff viewer
├── open-prose/        # Prose editor
├── llm-task/          # LLM task runner
├── talk-voice/        # Voice chat
├── phone-control/     # Phone control
│
├── acpx/              # ACP extension
├── copilot-proxy/     # Copilot proxy
├── device-pair/       # Device pairing
├── diagnostics-otel/  # OpenTelemetry diagnostics
├── thread-ownership/  # Thread ownership
├── shared/            # Shared extension utilities
└── test-utils/        # Extension test helpers
```

---

## Plugin Architecture（插件架构）

```
  ┌─────────────────────────────────────────────────┐
  │           OpenClaw Plugin SDK                    │
  │         (src/plugin-sdk/index.ts)                │
  │                                                  │
  │  Provides: register(), hooks, config, logging    │
  └───────────────────────┬─────────────────────────┘
                          │
            ┌─────────────┼──────────────┐
            ▼             ▼              ▼
  ┌──────────────┐ ┌─────────────┐ ┌──────────────┐
  │ Channel      │ │ Feature     │ │ Integration  │
  │ Plugin       │ │ Plugin      │ │ Plugin       │
  │              │ │             │ │              │
  │ e.g. Matrix, │ │ e.g. mem,  │ │ e.g. copilot │
  │ MS Teams,    │ │ diffs,     │ │ proxy, OTEL  │
  │ Feishu       │ │ voice-call │ │              │
  └──────────────┘ └─────────────┘ └──────────────┘
```

**Plugin rules:**

- Each extension lives in `extensions/<name>/` with its own `package.json`
- Runtime deps go in `dependencies`; avoid `workspace:*` in dependencies
- `openclaw` should be in `devDependencies` or `peerDependencies`
- Plugin install runs `npm install --omit=dev` in the plugin dir
- SDK resolves via jiti alias at runtime

---

## Data Flow — Message Processing（消息处理流程）

```
  User sends message via Discord/Telegram/WhatsApp/etc.
          │
          ▼
  Channel adapter receives message (webhook/polling/WS)
          │
          ▼
  Routing engine determines target handler
          │
          ├── Auth check (pairing, allowlist, roles)
          │
          ▼
  Agent runtime processes message
          │
          ├── Context assembly (session, memory, hooks)
          ├── Tool selection (if needed)
          │
          ▼
  AI Provider request (via model router)
          │
          ├── Provider selection (primary → fallback)
          ├── Request to LLM (local gateway or API)
          │
          ▼
  Response processing
          │
          ├── Strip reasoning tags (DeepSeek <think>)
          ├── Format for channel
          │
          ▼
  Deliver response back to user's channel
```

---

## Data Flow — Voice Call（语音通话流程）

```
  Inbound call (Twilio webhook) or Outbound initiation
          │
          ▼
  Voice-call webhook handler
          │
          ├── Contact lookup (CONTACT_LIST.md)
          ├── Greeting selection (personalized or fallback)
          │
          ▼
  WebSocket audio stream (Twilio ↔ OpenClaw)
          │
          ├── STT (Speech-to-Text) with suppression during TTS
          ├── LLM streaming response generation
          ├── TAG-aware sentence buffering
          ├── Incremental TTS (ElevenLabs)
          ├── Hybrid interrupt support
          │
          ▼
  Call end detection (LLM-based)
          │
          ▼
  Post-call pipeline
          │
          ├── Audio cleanup
          ├── Transcript formatting
          ├── LLM summary generation
          ├── Markdown report → ~/.openclaw/workspace/call_logs/
          └── Discord DM notification (for inbound)
```

---

## Build & Deploy Pipeline（构建部署流程）

```
  openclaw-fork/ (source)
       │
       │  pnpm build
       │    ├── tsdown (TS → JS in dist/)
       │    ├── plugin-sdk DTS generation
       │    ├── canvas A2UI bundle
       │    ├── hook metadata copy
       │    ├── build info write
       │    └── CLI compat scripts
       │
       ▼
  dist/                         (built output)
       │
       │  deploy (sync files)
       │
       ▼
  /home/linuxbrew/.linuxbrew/lib/node_modules/openclaw/dist/
       │
       │  systemctl --user restart openclaw-gateway.service
       │  systemctl --user restart openclaw-node.service
       │
       ▼
  Production runtime active
```

---

## Fork Branch Strategy（分支策略）

```
  upstream/main  (openclaw/openclaw)
       │
       │  auto-sync PR (.github/workflows/sync-upstream.yml)
       │
       ▼
  main           (local tracking of upstream)
       │
       │  merge + custom commits
       │
       ▼
  custom-main    (★ primary development branch)
       │
       │  release branch per version
       │
       ├── release-custom/v2026.2.26
       ├── release-custom/v2026.3.1
       └── release-custom/v2026.3.2

  Conflict resolution: git rerere enabled for memory reuse
```

---

## External Dependencies（外部依赖）

| Service      | Purpose                                  | Config Location           |
| ------------ | ---------------------------------------- | ------------------------- |
| Twilio       | Voice calls (inbound + outbound)         | `~/.openclaw/service.env` |
| Discord API  | Discord bot integration                  | `~/.openclaw/service.env` |
| OpenAI API   | LLM provider                             | `~/.openclaw/service.env` |
| DeepSeek API | LLM provider                             | `~/.openclaw/service.env` |
| Brave Search | Web search tool                          | `~/.openclaw/service.env` |
| ElevenLabs   | Text-to-speech for voice calls           | Extension config          |
| Mintlify     | Documentation hosting (docs.openclaw.ai) | `docs/` directory         |

---

## Security Model（安全模型）

- Gateway token authentication (`OPENCLAW_GATEWAY_TOKEN`)
- Device pairing system for channel authorization
- Role-based access control
- Allowlist/blocklist per channel
- Exec approval system for dangerous tool invocations
- Browser sandbox isolation (optional Docker-in-Docker)
- See `SECURITY.md` for full security policy
