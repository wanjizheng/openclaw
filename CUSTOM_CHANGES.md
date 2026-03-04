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

## 2026-02-26

### Fix: strip DeepSeek `<think>` blocks from user-facing replies

- What changed:
  - Added `deepseek` to `isReasoningTagProvider()` so any provider whose id
    contains `"deepseek"` is treated as a tag-based reasoning provider.
- Why:
  - DeepSeek V3 (`deepseek-chat`) sometimes wraps its internal chain-of-thought
    in `<think>…</think>` tags inside the plain-text content stream (it does NOT
    use the native `reasoning_content` field like the Reasoner model does).
  - Without this flag, `stripBlockTags` never ran for DeepSeek providers, so the
    raw `<think>` monologue leaked into Discord/WhatsApp replies — very jarring
    in personal/roleplay conversations.
  - `deepseek-reasoner` is unaffected in practice (its thinking lives in
    `reasoning_content`, never in the text stream), but flagging the whole
    `deepseek` namespace is safe and future-proof.
- Files:
  - `src/utils/provider-utils.ts` — add `deepseek` branch in
    `isReasoningTagProvider()`
- When merging from upstream:
  - Open `src/utils/provider-utils.ts`, find `isReasoningTagProvider`.
  - After the `minimax` block (or wherever the last `return true` block is),
    add:
    ```ts
    // DeepSeek chat (V3) may emit <think>...</think> blocks in its text stream.
    if (normalized.includes("deepseek")) {
      return true;
    }
    ```
- User-visible behavior:
  - `<think>…</think>` thinking blocks from DeepSeek models are silently
    stripped; users only see the final reply text.

### Follow-up: Discord voice multipart Blob type-compat fix

- What changed:
  - Updated Discord voice upload payload construction in
    `sendDiscordVoiceMessage()` to avoid passing Node `Buffer` directly into
    `Blob`.
  - Replaced `new Blob([audioBuffer])` with explicit `ArrayBuffer` copy:
    ```ts
    const audioArrayBuffer = new ArrayBuffer(audioBuffer.byteLength);
    new Uint8Array(audioArrayBuffer).set(audioBuffer);
    form.append("files[0]", new Blob([audioArrayBuffer], { type: "audio/ogg" }), filename);
    ```
- Why:
  - After upstream type updates, `Buffer`/`Uint8Array<ArrayBufferLike>` can fail
    TypeScript checks for `BlobPart` in `build:plugin-sdk:dts`.
  - This keeps Discord voice multipart upload behavior unchanged while restoring
    build compatibility.
- Files:
  - `src/discord/voice-message.ts`
- User-visible behavior:
  - No behavior change in successful sends; prevents regression where build
    fails and patched runtime cannot be produced/deployed.

### Operator note: next-time direct patch flow

- For future requests like “read and modify my latest fork changes directly”,
  use this sequence:
  1. Inspect fork delta:
     - `git diff -- src/discord/voice-message.ts`
  2. Build and verify:
     - `pnpm vitest run src/discord/voice-message.test.ts`
     - `pnpm build`
  3. Deploy to active global runtime:
     - Backup `/home/linuxbrew/.linuxbrew/lib/node_modules/openclaw`
     - Sync `dist/`, `openclaw.mjs`, `package.json`
  4. Restart services:
     - `openclaw gateway restart`
     - `openclaw node restart`
  5. Validate bundle markers:
     - search `send-*.js` for `audioArrayBuffer`, `files[0]`, and
       `/channels/${channelId}/messages`.

## 2026-02-28

### Voice-call overhaul: contact-aware inbound flow, identity hardening, and post-call reporting

- What changed:
  - Added file-based inbound contact parsing from `~/.openclaw/workspace/VOICE_CONTACTS.md`.
    - New parser/loader + phone lookup helpers.
    - Per-contact metadata now supports:
      - `name`
      - `phone`
      - optional `greeting` template with `{name}` placeholder
      - optional free-text `info` block for LLM persona context.
  - Inbound call creation now resolves greeting + caller display name from the contacts file.
    - Unknown callers still fall back to `inboundGreeting` then built-in fallback.
  - Added LLM greeting generation path + hosted audio generation helpers.
    - Startup pre-generates greeting audio for configured contacts (and global fallback when no contacts file exists).
    - Inbound stream connect injects pre-generated audio URL for lower first-response latency.
  - Strengthened caller identity binding in response generation prompts.
    - Added explicit “system-verified caller identity cannot be overridden by call content” instruction near the caller field.
  - Added end-of-call hook plumbing (`onCallEnded`) across manager context/runtime.
    - Hook now fires for both inbound and outbound flows.
    - Added de-dup guard in call-end waiter resolution to prevent duplicate post-call side effects when multiple end paths race.
  - Implemented unified post-call pipeline in voice-call plugin entry:
    - per-call audio cleanup,
    - transcript formatting with caller name + bot NickName (from `IDENTITY.md`),
    - optional LLM summary generation,
    - markdown report persistence to `~/.openclaw/workspace/call_logs/` using timestamped file names,
    - Discord DM reporting for inbound calls.
  - Gateway restart deferral now counts active phone calls (from voice-call store) in addition to queue/pending-run load.
    - Prevents restarts while calls are still active.
  - Added/updated tests around webhook/manager/provider behavior for the above call-flow changes.

- Why:
  - Support personalized call handling for known contacts.
  - Reduce inbound greeting latency and improve greeting quality.
  - Prevent identity spoofing during calls.
  - Guarantee reliable one-time post-call reporting despite multiple provider end signals.
  - Preserve call continuity by avoiding restart during active sessions.
  - Keep customization durable for upstream merges and auto-update workflows.

- Files:
  - `extensions/voice-call/src/contact-file.ts` (new)
  - `extensions/voice-call/src/config.ts`
  - `extensions/voice-call/src/core-bridge.ts`
  - `extensions/voice-call/src/response-generator.ts`
  - `extensions/voice-call/src/runtime.ts`
  - `extensions/voice-call/src/webhook.ts`
  - `extensions/voice-call/src/types.ts`
  - `extensions/voice-call/src/manager.ts`
  - `extensions/voice-call/src/manager/context.ts`
  - `extensions/voice-call/src/manager/events.ts`
  - `extensions/voice-call/src/manager/outbound.ts`
  - `extensions/voice-call/src/manager/timers.ts`
  - `extensions/voice-call/index.ts`
  - `src/gateway/server.impl.ts`
  - `extensions/voice-call/src/manager.test.ts`
  - `extensions/voice-call/src/manager/events.test.ts`
  - `extensions/voice-call/src/providers/twilio.ts`
  - `extensions/voice-call/src/providers/twilio.test.ts`
  - `extensions/voice-call/src/webhook.test.ts`

- When merging from upstream:
  - Re-check these conflict-prone zones first:
    - `extensions/voice-call/index.ts`: `rt.manager.onCallEnded` wiring and report pipeline.
    - `extensions/voice-call/src/manager/timers.ts`: call-end de-dup guard (`firedCallEndIds`) around `resolveCallEndWaiter`.
    - `extensions/voice-call/src/webhook.ts`: inbound stream `onConnect`/`onDisconnect` behavior and pre-generated greeting injection.
    - `extensions/voice-call/src/response-generator.ts`: caller identity lock text in prompt construction.
    - `src/gateway/server.impl.ts`: restart deferral includes active voice call count.
  - Preserve compatibility assumptions:
    - contacts file path: `~/.openclaw/workspace/VOICE_CONTACTS.md`
    - call report dir: `~/.openclaw/workspace/call_logs/`
    - IDENTITY NickName extraction from `IDENTITY.md`
  - After merge, perform this smoke check:
    1. Start gateway and confirm voice-call runtime initializes.
    2. Place one inbound and one outbound call.
    3. Verify exactly one post-call report per call.
    4. Verify report file exists in `call_logs` and inbound Discord DM is sent.
    5. Verify known caller greeting is personalized and unknown caller uses fallback.

- User-visible behavior:
  - Known callers receive personalized greetings and identity-aware conversation handling.
  - Unknown callers still receive deterministic fallback greeting.
  - Each call now produces a persisted markdown record (plus inbound Discord summary).
  - Duplicate end-report spam is eliminated in race conditions.
  - Gateway avoids restarting while phone calls are active.

### Safety guard: block accidental `gateway:dev` while prod gateway is running

- What changed:
  - Added a custom guard script to wrap dev gateway startup.
  - Updated npm scripts so `pnpm gateway:dev` and `pnpm gateway:dev:reset` now go through this guard.
  - Guard behavior:
    - if `openclaw-gateway.service` is active, dev launch is blocked by default,
    - allows explicit override via `OPENCLAW_ALLOW_DEV_GATEWAY=1`.
- Why:
  - Prevent accidental dual-gateway runtime (prod + dev) that causes Discord interaction conflicts and model picker inconsistencies.
  - Keep operational behavior deterministic for daily usage.
- Files:
  - `tools/custom/gateway-dev-guard.sh` (new)
  - `package.json`
  - `CUSTOM_CHANGES.md`
- When merging from upstream:
  - Keep `package.json` scripts:
    - `gateway:dev`
    - `gateway:dev:reset`
      pointed to `tools/custom/gateway-dev-guard.sh`.
  - Keep the override contract unchanged:
    - `OPENCLAW_ALLOW_DEV_GATEWAY=1` bypasses the guard intentionally.
- User-visible behavior:
  - Running `pnpm gateway:dev` now fails fast with a clear instruction when prod gateway is active.
  - Accidental creation of parallel dev/prod gateway instances is prevented by default.

## 2026-03-01

### Voice-call: streaming LLM + incremental TTS pipeline

- What changed:
  - Implemented streaming LLM response generation with incremental TTS via ElevenLabs.
  - Added TAG-aware sentence buffer that avoids splitting ElevenLabs SSML tags mid-stream.
  - Added LLM-based end-call detection — the LLM can now detect conversational cues that the caller wants to hang up, instead of relying solely on Twilio signals.
  - Outbound call prompts now include the call reason; tools are disabled during calls to prevent unwanted side effects.
  - Added per-call session isolation: each voice call gets its own session context, persona markdown injection from `IDENTITY.md`, and post-call session cleanup.
  - Added startup reconciliation: on gateway boot, active calls are reconciled against the provider to catch orphaned sessions.
  - Added module-level singleton to prevent `EADDRINUSE` from duplicate `register()` calls during hot-reload.
- Why:
  - Reduce voice response latency by starting TTS before the full LLM response completes.
  - TAG-aware buffering prevents "tag soup" audio artifacts.
  - LLM-based end-call produces more natural call termination.
  - Session isolation prevents conversation bleed between calls and memory leaks.
  - Startup reconciliation catches zombie calls left over from unclean restarts.
- Files:
  - `extensions/voice-call/index.ts`
  - `extensions/voice-call/src/core-bridge.ts`
  - `extensions/voice-call/src/manager.ts`
  - `extensions/voice-call/src/manager/outbound.ts`
  - `extensions/voice-call/src/providers/base.ts`
  - `extensions/voice-call/src/providers/twilio.ts`
  - `extensions/voice-call/src/providers/twilio/api.ts`
  - `extensions/voice-call/src/response-generator.ts`
  - `extensions/voice-call/src/runtime.ts`
  - `extensions/voice-call/src/streaming-response.ts`
  - `extensions/voice-call/src/webhook.ts`
- User-visible behavior:
  - Voice responses start playing significantly faster (streaming, not wait-for-full).
  - Calls end more naturally when caller signals goodbye.
  - Each call is fully isolated; previous call context does not bleed through.

## 2026-03-02

### Voice-call: STT suppression, tag stripping hardening, and auto-update version fix

- What changed:
  - Added STT (speech-to-text) suppression during TTS playback — microphone input is now muted while the bot is speaking to prevent echo feedback.
  - Fixed `callReason` not being passed correctly to outbound call prompts.
  - Improved outbound call reporting.
  - Hardened tag stripping in the streaming response pipeline to prevent partial `</` and `</final` leakage when DeepSeek reasoning tags span chunk boundaries.
  - Fixed think output handling for DeepSeek models in the streaming voice path.
  - Fixed auto-update version normalization: `package.json` version is now normalized for stable releases to prevent the auto-update system from miscomparing versions.
  - Documented the auto-update version mismatch issue in `AUTO_UPDATE_VERSION_ISSUE.md`.
- Why:
  - STT suppression eliminates echo loops where the bot hears itself talking.
  - Tag stripping hardening prevents garbled audio artifacts from partial HTML/XML tags.
  - Version normalization prevents update-loop where the system repeatedly thinks an update is available.
- Files:
  - `extensions/voice-call/index.ts`
  - `extensions/voice-call/src/manager/outbound.ts`
  - `extensions/voice-call/src/media-stream.ts`
  - `extensions/voice-call/src/providers/twilio.ts`
  - `extensions/voice-call/src/response-generator.ts`
  - `extensions/voice-call/src/streaming-response.ts`
  - `extensions/voice-call/src/utils.ts`
  - `extensions/voice-call/src/webhook.ts`
  - `tools/custom/release-integrate-and-build.sh`
  - `AUTO_UPDATE_VERSION_ISSUE.md` (new)
- User-visible behavior:
  - No more echo during voice calls (bot doesn't hear itself).
  - Cleaner voice output without garbled tag fragments.
  - Auto-update no longer incorrectly reports updates available.

## 2026-03-03

### Voice-call: hybrid mode restoration, generation-based queue versioning, and interrupt hardening

- What changed:
  - Restored hybrid mode (streaming LLM + TTS) and removed dead old-mode code paths.
  - Hybrid interrupt now also aborts the in-flight LLM generation (not just TTS playback), preventing the system from generating a stale response after the user interrupts.
  - Implemented generation-based queue versioning to prevent a race condition between `abortHybridPlay` and pending Redirect requests — each generation gets a version ID so stale redirects are discarded.
  - Fixed a bug where the system could process additional LLM responses after the LLM had already signaled end-call, causing duplicate or ghost responses.
  - Extracted dedicated tag-cleaning logic into `llm-tag-cleanup.ts` with its own test file.
  - Improved DeepSeek reasoning tag stripping to preserve ElevenLabs SSML tags — previous logic was over-aggressively stripping `<` characters, breaking ElevenLabs `<break>` and `<prosody>` tags.
- Why:
  - Hybrid mode provides the best latency/quality balance for voice.
  - Generation versioning eliminates a class of race conditions that caused audio glitches or stale playback.
  - Post-end-call guard prevents confusing ghost responses after hang-up.
  - Separated tag-cleaning logic is easier to test and maintain across upstream merges.
- Files:
  - `extensions/voice-call/index.ts`
  - `extensions/voice-call/src/llm-tag-cleanup.ts` (new)
  - `extensions/voice-call/src/llm-tag-cleanup.test.ts` (new)
  - `extensions/voice-call/src/streaming-response.ts`
  - `extensions/voice-call/src/streaming-response.tag-cleaning.test.ts`
  - `extensions/voice-call/src/manager/outbound.ts`
  - `extensions/voice-call/src/media-stream.ts`
  - `extensions/voice-call/src/providers/twilio.ts`
  - `extensions/voice-call/src/response-generator.ts`
  - `extensions/voice-call/src/runtime.ts`
  - `extensions/voice-call/src/types.ts`
  - `extensions/voice-call/src/utils.ts`
  - `extensions/voice-call/src/webhook.ts`
- When merging from upstream:
  - `extensions/voice-call/src/llm-tag-cleanup.ts` is new — no upstream conflict expected.
  - `extensions/voice-call/src/streaming-response.ts` has heavy changes around hybrid mode — manual merge likely.
  - `extensions/voice-call/src/webhook.ts` generation versioning — check for upstream changes to `onConnect`/redirect logic.
- User-visible behavior:
  - Interrupting the bot mid-sentence now immediately stops both audio and LLM processing.
  - No more ghost responses after hanging up.
  - ElevenLabs voice quality preserved (SSML tags intact).
  - Cleaner DeepSeek reasoning tag removal without collateral damage.

## 2026-03-04

### Voice-call: echo suppression fix, queue abort, pipeline metrics, and extensionAPI export

- What changed:
  - Fixed echo suppression not activating correctly in certain edge cases.
  - Added queue abort capability — when a new user utterance arrives, any pending/in-flight TTS queue items from the previous response are aborted.
  - Added pipeline metrics tracking for voice call performance monitoring.
  - Exported `abortEmbeddedPiRun` from `src/extensionAPI.ts` so the voice-call extension can properly abort in-flight LLM generation when the user interrupts.
- Why:
  - Echo suppression edge cases caused occasional feedback loops.
  - Queue abort ensures the user isn't forced to listen to the tail end of a previous response when they've already said something new.
  - Pipeline metrics provide visibility into latency bottlenecks (STT → LLM → TTS → playback).
  - The extensionAPI export was required because voice-call needs to call `abortEmbeddedPiRun` to cleanly cancel LLM runs.
- Files:
  - `extensions/voice-call/src/core-bridge.ts`
  - `extensions/voice-call/src/response-generator.ts`
  - `extensions/voice-call/src/streaming-response.ts`
  - `extensions/voice-call/src/webhook.ts`
  - `src/extensionAPI.ts`
- User-visible behavior:
  - Echo issues further reduced.
  - Interrupting the bot is now fully responsive — old audio stops, new response begins.
  - No user-visible metric output (internal monitoring only).

### Docs: add project memory and architecture documentation

- What changed:
  - Created `PROJECT_CONTEXT.md` — system overview with tech stack, three-directory layout, commands, ports, known pitfalls (with Chinese section headers).
  - Created `ARCHITECTURE.md` — ASCII architecture diagrams, module map, plugin structure, data flow, build pipeline, branch strategy.
  - Updated `AGENTS.md` — prepended critical directory safety rules and custom fork rules while preserving all upstream guidelines.
  - Created `.github/copilot-instructions.md` — Copilot behavior and safety rules.
  - Created `.project-memory/decisions.md` — 14 decision entries extracted from commit history and repo structure.
- Why:
  - Provide persistent project memory for AI assistants and human developers.
  - Prevent accidental edits to the deployment directory.
  - Document architecture decisions that were previously only implicit in code.
- Files:
  - `PROJECT_CONTEXT.md` (new)
  - `ARCHITECTURE.md` (new)
  - `AGENTS.md` (updated)
  - `.github/copilot-instructions.md` (new)
  - `.project-memory/decisions.md` (new)
- User-visible behavior:
  - AI assistants now have full project context before suggesting changes.
  - Documentation serves as onboarding material for new contributors.

### Voice-call: Twilio XML warning + status callback hardening

- What changed:
  - Removed unsupported `inactivityTimeout` attribute from all Twilio `<ConversationRelay>` TwiML templates.
  - Rebuilt and redeployed runtime artifacts to the active global OpenClaw install used by systemd services.
  - Restarted `openclaw-gateway` and `openclaw-node` services after deployment.
- Why:
  - Twilio was returning `12200 XML Validation warning` because `inactivityTimeout` is not allowed on `ConversationRelay`.
  - Runtime needed redeploy to ensure the fix applied to the actual running instance.
- Files:
  - `extensions/voice-call/src/providers/twilio.ts`
- User-visible behavior:
  - Twilio Debugger should stop creating new `12200` warnings for ConversationRelay requests.

### Docs: enforce UI build before deploy/restart

- What changed:
  - Updated instruction docs to require explicit `pnpm ui:build` before deploy/restart.
  - Updated workflow text to: `pnpm build -> pnpm ui:build -> deploy -> restart`.
  - Corrected outdated wording that implied `pnpm build` alone always covers Control UI assets.
- Why:
  - Prevent runtime failure: `Control UI assets not found. Build them with 'pnpm ui:build'`.
- Files:
  - `AGENTS.md`
  - `.github/copilot-instructions.md`
  - `.github/instructions/copilot.instructions.md`
  - `PROJECT_CONTEXT.md`
- User-visible behavior:
  - Deployment/restart instructions now consistently include the required UI build step, reducing startup/runtime asset errors.
