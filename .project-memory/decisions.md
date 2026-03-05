# Project Memory — Decision Log

> Persistent development memory for this OpenClaw fork.
> Tracks architectural decisions, design choices, and operational learnings.
> Last generated: 2026-03-04

---

## Decision #001 — Create custom fork with `custom-main` branch

- **Date**: 2026-02-25
- **Decision**: Fork openclaw/openclaw into openclaw-fork with a `custom-main` branch that layers custom commits on top of upstream `main`.
- **Reason**: Need custom behaviors (voice-call enhancements, DeepSeek fixes, Discord patches) while staying updatable from upstream.
- **Impact**: All custom work lives on `custom-main`. Upstream syncs come via automated PR workflow. Git `rerere` enabled for conflict memory reuse.
- **Source**: Commit `4596a9596` — "chore(custom): bootstrap fork workflow and change log"

---

## Decision #002 — Automated upstream sync via GitHub Actions

- **Date**: 2026-02-25
- **Decision**: Added `.github/workflows/sync-upstream.yml` to automatically fetch from `openclaw/openclaw` and create/update sync PRs into `custom-main`.
- **Reason**: Keep fork current automatically while preserving review control and custom commit history.
- **Impact**: Upstream updates appear as PRs; operator merges when ready. Reduces risk of falling too far behind.
- **Source**: Commit `ec254fd2f` — "chore(custom): add automated upstream sync PR workflow"

---

## Decision #003 — Strip DeepSeek `<think>` tags from user-facing replies

- **Date**: 2026-02-26
- **Decision**: Added `deepseek` to `isReasoningTagProvider()` in `src/utils/provider-utils.ts` so DeepSeek models are treated as tag-based reasoning providers.
- **Reason**: DeepSeek V3 (`deepseek-chat`) emits `<think>…</think>` blocks in the text stream (not via `reasoning_content`). Without this flag, raw thinking monologue leaked into Discord/WhatsApp replies.
- **Impact**: All DeepSeek models now have `<think>` tags stripped. Safe for `deepseek-reasoner` too (its thinking goes through `reasoning_content`). Conflict zone during upstream merges.
- **Source**: Commit `a4e35e6e3` — "fix: strip DeepSeek <think> blocks from user-facing replies"

---

## Decision #004 — Discord voice messages via multipart form-data

- **Date**: 2026-02-26
- **Decision**: Updated Discord voice upload to use explicit `ArrayBuffer` copy instead of raw `Buffer` in `Blob` constructor.
- **Reason**: After upstream type updates, `Buffer`/`Uint8Array<ArrayBufferLike>` failed TypeScript checks for `BlobPart`. Changed to: `new ArrayBuffer` → `set(audioBuffer)` → `new Blob([arrayBuffer])`.
- **Impact**: Build compatibility restored. No behavior change in actual uploads.
- **Source**: Commit `4b48052ac` — "fix(discord): send voice messages via multipart form-data"

---

## Decision #005 — Gateway dev-guard to prevent prod/dev conflicts

- **Date**: 2026-02-28
- **Decision**: Added `tools/custom/gateway-dev-guard.sh` and wired `pnpm gateway:dev` through it.
- **Reason**: Running dev gateway while production `openclaw-gateway.service` is active causes Discord interaction conflicts and model picker inconsistencies.
- **Impact**: `pnpm gateway:dev` now fails fast when prod is active. Override with `OPENCLAW_ALLOW_DEV_GATEWAY=1`.
- **Source**: Commit `c928ab017` — "chore(custom): guard gateway:dev and add rollback tag"

---

## Decision #006 — Voice-call: contact-aware inbound flow with personalized greetings

- **Date**: 2026-02-28
- **Decision**: Implemented file-based inbound contact parsing from `~/.openclaw/workspace/CONTACT_LIST.md` with per-contact name, phone, greeting template, and info block.
- **Reason**: Support personalized call handling for known contacts. Reduce inbound greeting latency via pre-generated audio. Prevent identity spoofing.
- **Impact**: Known callers get personalized greetings. Unknown callers use fallback. Post-call reports generated in `~/.openclaw/workspace/call_logs/`. Gateway restart deferred during active calls.
- **Source**: Commit `5bd423eff` — "feat(voice-call): contact-aware inbound flow and robust post-call reporting"

---

## Decision #007 — Voice-call: streaming LLM + incremental TTS with TAG-aware sentence buffer

- **Date**: 2026-03 (series of commits)
- **Decision**: Implemented streaming LLM responses with incremental TTS generation. Added TAG-aware sentence buffering to avoid splitting ElevenLabs SSML tags mid-stream.
- **Reason**: Reduce voice response latency by starting TTS generation before LLM completes. TAG-aware buffering prevents "tag soup" artifacts in voice output.
- **Impact**: Significantly faster voice responses. More natural conversation flow. Hybrid interrupt support allows users to interrupt while TTS is playing.
- **Source**: Commits `8832243b2`, `58bef3ec1`, `20e0c63fa`

---

## Decision #008 — Voice-call: LLM-based end-call detection

- **Date**: 2026-03
- **Decision**: Implemented LLM-based end-call detection instead of relying solely on Twilio signals.
- **Reason**: More natural call endings. The LLM can detect conversational cues that indicate the caller wants to end the call.
- **Impact**: Cleaner call termination. Combined with generation-based queue versioning to prevent race conditions between abort and pending requests.
- **Source**: Commit `d5d2506d9` — "voice-call: LLM-based end-call detection, outbound call reason in prompt, disable tools"

---

## Decision #009 — Voice-call: per-call session isolation

- **Date**: 2026-03
- **Decision**: Each voice call now gets its own isolated session. Persona markdown injection from `IDENTITY.md`. Post-call session cleanup.
- **Reason**: Prevent conversation bleed between calls. Support per-call persona customization. Clean up resources after calls end.
- **Impact**: Better conversation quality. Deterministic session lifecycle. Post-call cleanup prevents memory leaks.
- **Source**: Commit `9fde1642a` — "voice-call: per-call session isolation, persona MD injection, post-call session cleanup"

---

## Decision #010 — Use local LLM gateway proxy

- **Date**: Unknown (needs confirmation) — inferred from repository structure
- **Decision**: Route AI requests through a local Python FastAPI proxy (`llm-gateway/gateway.py`) at `http://127.0.0.1:8000/v1` rather than directly to provider APIs.
- **Reason**: Decision inferred from repository structure. Likely for: centralized API key management, request logging/auditing, provider abstraction, and cost tracking.
- **Impact**: All AI completions go through the local gateway. The `uob-ai` provider in `openclaw.json` points to this proxy. Models `gpt-5.1` and `text-embedding-3-large` are configured.
- **Source**: `llm-gateway/gateway.py` and `~/.openclaw/openclaw.json` configuration

---

## Decision #011 — systemd user services for daemon management

- **Date**: Unknown (needs confirmation) — inferred from system state
- **Decision**: Run OpenClaw gateway and node host as systemd user services rather than manual processes or screen/tmux sessions.
- **Reason**: Decision inferred from repository structure. Provides automatic restart on failure, boot-time startup, proper process management, and clean logging via journalctl.
- **Impact**: Services auto-start on user login: `openclaw-gateway.service` (port 18789), `openclaw-node.service` (worker). Voice reconciler runs on a timer.
- **Source**: `~/.config/systemd/user/openclaw-gateway.service`, `openclaw-node.service`

---

## Decision #012 — Release branch naming convention

- **Date**: 2026-02 (inferred from branch structure)
- **Decision**: Use `release-custom/vYYYY.M.D` branch naming for release cuts from `custom-main`.
- **Reason**: Decision inferred from repository structure. Separates release stabilization from ongoing development. Prefix `release-custom/` distinguishes from upstream releases.
- **Impact**: Release branches: `release-custom/v2026.2.26`, `release-custom/v2026.3.1`, `release-custom/v2026.3.2`. Each release is cut from `custom-main` and merged back.
- **Source**: Git branch structure

---

## Decision #013 — Auto-update version normalization

- **Date**: 2026-03
- **Decision**: Normalize `package.json` version for stable releases to prevent auto-update version mismatch issues.
- **Reason**: The auto-update system was comparing versions incorrectly when custom fork versions didn't match the upstream release format.
- **Impact**: Stable releases now have consistent version strings. See `AUTO_UPDATE_VERSION_ISSUE.md` for detailed explanation.
- **Source**: Commit `76a4d4690` — "fix(auto-update): normalize package.json version for stable releases"

---

## Decision #014 — Voice-call module-level singleton

- **Date**: 2026-03
- **Decision**: Use a module-level singleton for the voice-call extension to prevent `EADDRINUSE` errors from duplicate `register()` calls.
- **Reason**: Hot-reloads or multiple plugin registrations could create duplicate WebSocket/HTTP listeners on the same port.
- **Impact**: Only one voice-call instance can exist per process. Prevents port conflict crashes. Must be considered during hot-reload workflows.
- **Source**: Commit `416a0f063` — "fix(voice-call): module-level singleton to prevent EADDRINUSE from duplicate register()"

---

## Notes

- Entries marked "Unknown (needs confirmation)" or "Decision inferred from repository structure" are based on repository analysis, not explicit documentation. Confirm with the project operator.
- New decisions should be appended to this file with incrementing IDs.
- Format: Date, Decision, Reason, Impact, Source.
