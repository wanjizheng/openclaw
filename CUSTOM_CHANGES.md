# Custom Changes Log

Track every custom behavior you add.
Each entry should explain:

- What changed

## 2026-08-18

### Pre-generate outbound greeting audio before dialing (hybrid mode)

Outbound hybrid-mode calls used to dial first, then synthesize the opening
line's mp3 (ElevenLabs via `sag`) only after Twilio reported the call
answered. The callee heard several seconds of dead air before the greeting
started.

`extensions/voice-call/src/manager/outbound.ts` now calls
`generateHybridAudioUrl` for the initial message **before** placing the
Twilio call (in `initiateCall`), storing the resulting URL in
`callRecord.metadata.initialMessageAudioUrl`. `speak()` gained a
`preGeneratedAudioUrl` option that skips synthesis and reuses that URL;
`speakInitialMessage()` passes it through and clears it from metadata after
successful playback. Falls back to the original on-answer generation if
pre-generation fails or hybrid mode is off. Notify mode is unaffected (it
already speaks immediately via inline Polly `<Say>`).

**Files touched (1):**

- `extensions/voice-call/src/manager/outbound.ts`

## 2026-06-03

### Hybrid mode fixes (queue-driven endCall + empty-call filter + replay-detection fix)

Three issues were fixed against the v2026.5.28 fork base. None of them touched
upstream code semantics; they only adjust how the voice-call plugin reacts to
hybrid-mode call events.

**Fix 1 — queue-driven `endCall` (no more premature hangup)**

Before, when the LLM said goodbye, the webhook handler used a hard-coded
`setTimeout(endCall, 4000)`. Short goodbyes (~1.5s) left the line open
unnecessarily; long goodbyes with v3 audio tags (5–7s) were cut off mid-word.

Now the end-of-call signal is plumbed through the play queue:

1. `types.ts` — `PlayTtsInput` gains `endCall?: boolean`.
2. `providers/twilio.ts` — `playTts` calls
   `queue.markDone(providerCallId, input.endCall === true)`.
3. `manager/outbound.ts` — `speak(text, { endCall })` forwards the flag to
   `provider.playTts`.
4. `manager.ts` — public `speak(callId, text, { endCall })` wrapper.
5. `webhook.ts` — drops the `setTimeout`; instead calls
   `manager.speak(callId, text, { endCall: shouldEndCall })`.

`HybridPlayQueue.handlePlayNextAction` already returns `HYBRID_HANGUP_TWIML`
when `q.done && q.endCall`, so the goodbye audio plays to completion, then
Twilio gets `<Hangup/>` on the next playNextUrl redirect. Race-free with
respect to audio playback.

End-of-call is also detected by a **goodbye phrase** pattern in addition to
the optional `[END_CALL]` marker:

- 中文: 拜拜 / 拜啦 / 掰掰 / 白白 / 再见 / 先这样 / 没事了 / 挂了 / 挂啦 / 挂了吧 / mua
- 英文: bye / goodbye / see you

Triggers only when the user JUST said goodbye AND the bot's response also
contains a goodbye phrase. This avoids false positives during normal
conversation. The system prompt in `~/.openclaw/openclaw.json` still asks
the LLM to emit `[END_CALL]` explicitly, but the pattern is the
authoritative fallback.

**Fix 2 — empty-call filter (no more phantom 0-second records)**

Each Twilio call.ended status callback is followed 200–300ms later by a
different webhook with a new `providerCallId` and a different `dedupeKey`,
which the gateway dutifully processed as a brand-new call. The result was
two Discord DMs per real call: one `(无通话记录)` phantom and one with the
real transcript.

`post-call-pipeline.ts → buildOnCallEndedHandler` now short-circuits when
`transcript.length === 0 && durationSec === 0`, logging
`Skipping post-call report for empty phantom call`. The phantom's
`gateway-supervisor-restart-handoff.json` and the call's activeCalls map
are still cleaned up — only the Discord DM and `call_logs/*.md` are
suppressed.

**Fix 3 — replay detection skips `playAction=1`**

`webhook.ts` (verifyReplay) was matching the 2nd+ `playNextUrl` redirect
against the 1st's replay key (`sha256(url + body + signature)`). Since
both redirects have the SAME URL+body (callId and playAction=1 are
constant per call), the 2nd was rejected as a duplicate and got the
empty `<Response></Response>` TwiML — Twilio then ended the call because
it had no active TwiML. Result: the bot's first response hung up the
call.

Now the replay check is bypassed when `ctx.query?.playAction === "1"`,
because that endpoint is hybrid's internal callback, not a real Twilio
business event. Real `call.ended` / `call.completed` events still go
through the normal replay path.

**Files touched (6):**

- `extensions/voice-call/src/types.ts` — `PlayTtsInput.endCall?`
- `extensions/voice-call/src/providers/twilio.ts` — pass `endCall` to
  `queue.markDone`
- `extensions/voice-call/src/manager.ts` — `speak(... { endCall? })` wrapper
- `extensions/voice-call/src/manager/outbound.ts` — same wrapper, plumbed
  through to `provider.playTts`
- `extensions/voice-call/src/webhook.ts` — goodbye-pattern detector +
  queue-driven endCall (drops `setTimeout`) + replay-detection bypass
  for `playAction=1`
- `extensions/voice-call/src/post-call-pipeline.ts` — empty-call filter

**Verified by**: 78-second inbound call, 4 exchanges, goodbye at 1m18s
("我先挂啦" → `hangup-bot` 4s after goodbye audio finished, single
Discord report, no `(无通话记录)` phantom).

---

## 2026-05-16

### Upgrade: v2026.5.7 → v2026.5.12 (cherry-pick with conflict resolution)

**Base tag**: v2026.5.12
**Method**: cherry-pick of custom-main commit onto v2026.5.12; one conflict in
`response-generator.ts` resolved by merging upstream `resolveVoiceAgentToolsAllow`
with our `resolveVoiceAgentId` + contact loading block.

- Created branch `upgrade/v2026.5.12` from `v2026.5.12` tag
- Cherry-picked `019b43efe7` (all v2026.5.7 custom changes) onto v2026.5.12
- Resolved conflict: kept `resolveVoiceAgentId` + contact loading (custom),
  added upstream `toolsAllow = resolveVoiceAgentToolsAllow(cfg, agentId)`,
  removed `disableTools: true` workaround (no longer needed since v2026.5.7
  `enforceWhenToolsDisabled` fix in tool-allowlist-guard.ts)
- Fixed `_callSid` unused-param TS error in `providers/twilio.ts`

---

## 2026-05-14

### Upgrade: v2026.4.26 → v2026.5.7 (manual re-port)

**Base tag**: v2026.5.7
**Method**: manual semantic re-port (not cherry-pick; minor version drift 4.x→5.x)

- Created branch `upgrade/v2026.5.7` from `v2026.5.7` tag
- Upstream changed 54 voice-call files (+4800 lines) and also independently
  fixed `tool-allowlist-guard.ts` with `enforceWhenToolsDisabled` (cleaner
  than our label-based workaround — no custom change needed for that file)
- Re-ported all hybrid mode (Phase 8) custom changes onto new upstream structure
- Re-ported post-call pipeline, contact-aware response-generator, and
  stripLlmReasoningTags into the updated `response-generator.ts`
- `custom-main` force-pushed to this re-ported branch

## 2026-05-01

### Re-port: full hybrid voice-call mode (Phase 8)

- What changed:
  - The Apr 29 v2026.5.7 rebase dropped the entire hybrid voice-call mode
    (echo-free TTS via Twilio Call Update `<Play>` injection, with
    `<Start><Stream>` for STT and `<Connect><ConversationRelay>` for events).
    The replacement Media-Streams-only TTS path had no echo cancellation,
    so the bot's own voice triggered the VAD as if it were the user. This
    re-port restores hybrid mode while keeping the new SDK shape.

  - New module `extensions/voice-call/src/hybrid/`:
    1. `audio-pipeline.ts` — generates ElevenLabs v3 mp3 files via the
       `sag` CLI (with plugin-sdk `textToSpeech` as fallback), resolves the
       public audio URL (`${publicUrl-origin}/audio/<file>` by default),
       and exposes `deleteCallAudioFiles(callId)` for post-call cleanup.
    2. `twiml.ts` — pure TwiML builders: `buildHybridInitialTwiml`,
       `buildResumeRelayTwiml`, `buildConversationRelayTwiml`,
       `buildPlayThenRedirectTwiml`, `buildPauseThenRedirectTwiml`.
       CR defaults: `language=multi`, `ttsProvider=ElevenLabs`,
       `voice=bhJUNIXWQQ94l8eI2VUf`, `transcriptionProvider=Deepgram`,
       `speechModel=nova-3-general`, `interruptible=true`, `dtmfDetection=true`.
    3. `play-queue.ts` — `HybridPlayQueue` class managing per-call mp3
       URL queues. `triggerFirst` issues `POST /Calls/{sid}.json` with
       `<Play><Redirect>` TwiML to inject the first sentence; `abort`
       increments the generation counter (invalidating in-flight redirects)
       and switches the call back to `<Connect><CR>` via Call Update.
       `handlePlayNextAction` returns TwiML for the next sentence,
       resumes CR when drained, or hangs up when `endCall` is set.
    4. `cr-handler.ts` — `HybridCrHandler` mounting the `/voice/cr`
       WebSocket. Handles `setup` (synthesizes `call.answered` if ringing,
       triggers initial-message playback), ignores `prompt` (CR's
       Deepgram transcripts are dropped — STT comes from the fork stream),
       handles `interrupt` and `dtmf`, and suppresses `call.ended` when
       a CR socket disconnect is caused by `<Play>` injection.

  - Modified files:
    - `src/types.ts`: added `audioUrl?: string` to `PlayTtsInput`.
    - `src/config.ts`: added `streaming.hybridMode: boolean` (default
      `false`) and `streaming.crPath: string` (default `/voice/cr`).
    - `extensions/voice-call/openclaw.plugin.json`: added matching schema
      properties to `streaming` (otherwise the loader rejects them).
    - `src/providers/twilio.types.ts`: added `hybridMode?: boolean` and
      `crPath?: string` to `TwilioProviderOptions`.
    - `src/providers/twilio.ts`:
      - Added `hybridQueue: HybridPlayQueue | null`, `hybridInitialAudio`
        map, and the public methods `isHybridMode`, `getHybridQueue`,
        `hasActiveHybridQueue`, `abortHybridPlay`, `markHybridSentencesDone`,
        `handlePlayNextAction`, `updateCallTwiml`,
        `getConversationRelayOptions`, `setHybridInitialAudioUrl`.
      - `generateTwimlResponse`: when hybrid is on, the `playAction=1`
        query routes to `handlePlayNextAction`; otherwise the initial
        webhook hit emits `buildHybridInitialTwiml` (Stream + optional
        `<Play>` greeting + Connect CR) instead of the standard
        Media-Stream TwiML.
      - `playTts`: when hybrid is on and `input.audioUrl` is supplied,
        the URL is enqueued in the play queue and (for the first sentence
        of a turn) injected via Twilio Call Update.
    - `src/manager/outbound.ts`: `speak()` now pre-generates the audio
      URL via `generateHybridAudioUrl` when `streaming.hybridMode` is on,
      and passes it through to `provider.playTts`.
    - `src/runtime.ts`: forwards `streaming.hybridMode` and
      `streaming.crPath` from the voice-call config to
      `TwilioProviderOptions`.
    - `src/webhook.ts`:
      - Added `crHandler: HybridCrHandler | null` (lazy via
        `ensureCrHandler`). The `start()` upgrade dispatcher now also
        listens on `streaming.crPath` and routes upgrades to the CR
        handler when `streaming.hybridMode` is enabled.
      - `onSpeechStart`: when hybrid is on and a play queue is active,
        calls `abortHybridPlay(providerCallId)` instead of
        `clearTtsQueue` (which is a Media-Streams-only operation).
    - `src/post-call-pipeline.ts`: when hybrid is on, also runs
      `deleteCallAudioFiles(callId)` to clean up generated mp3 files.

  - User config (`~/.openclaw/openclaw.json`): set
    `plugins.entries.voice-call.config.streaming.hybridMode = true`
    and `crPath = "/voice/cr"`.

  - Infrastructure: cloudflared tunnel routes `voice.ontoai.com/audio/*`
    to nginx (`127.0.0.1:8088` → `~/.openclaw/workspace/voice_messages/`)
    and `voice.ontoai.com/voice/*` (incl. `/voice/cr`, `/voice/stream`)
    to the gateway on `127.0.0.1:3334`. `sag` (ElevenLabs v3) is at
    `/home/linuxbrew/.linuxbrew/bin/sag`.

- Why:
  - Twilio Media Streams have no echo cancellation. The bot's own TTS,
    sent over the same media WebSocket, fed back into the inbound
    transcript and tripped the VAD, causing the bot to "interrupt
    itself". Hybrid mode plays TTS via a separate Twilio media channel
    (Call Update `<Play>`), so the bot's voice is never on the inbound
    track. This also enables true barge-in (VAD on the fork stream
    aborts the play queue + switches back to CR within ~200 ms).

- Status: built, installed, gateway restarted, validated startup.
  Pending live-call smoke test (inbound + outbound, barge-in).

- What changed:
  - The Apr 29 v2026.5.7 rebase silently dropped the post-call reporting
    pipeline (call_logs/\*.md writer + Discord auto-summary DM + per-call
    session cleanup). Calls succeeded but produced no record. Re-applied: 1. `extensions/voice-call/src/manager/context.ts`: added
    `firedEndIds: Set<CallId>` to runtime state and `onCallEnded?:
(call: CallRecord) => void` to `CallManagerHooks`. 2. `extensions/voice-call/src/manager/lifecycle.ts`: `finalizeCall`
    now fires `ctx.onCallEnded` exactly once per call (de-duped via
    `firedEndIds`) AFTER `persistCallRecord` and AFTER cleanup, with a
    try/catch so hook errors never break call cleanup. 3. `extensions/voice-call/src/manager.ts`: added public
    `onCallEnded?: (call: CallRecord) => void` field on `CallManager`
    and wired it through `getContext()`. Also added private
    `firedEndIds` set. 4. `extensions/voice-call/src/post-call-pipeline.ts` (new): exposes
    `buildOnCallEndedHandler({ api, config })`. Pipeline: - Per-call session file deletion via
    `api.runtime.agent.session.*` (using `voice:<callId>` key). - Contact resolution via `loadContactsFileAsync` +
    `findContactByPhone`. - Bot display name from `IDENTITY.md` `**NickName**` /
    `**Name**` (falls back to `resolveAgentIdentity`, then "诺岚"). - LLM summary (3-5 sentences, Chinese) via
    `api.runtime.agent.runEmbeddedPiAgent` using the same model as
    voice responses (`resolveVoiceResponseModel`). - Markdown report written to
    `<workspaceDir>/call_logs/{IN|OUT}-YYYY-MM-DD-HHMMSS-<name>.md`. - Discord DM sent to first `channels.discord.allowFrom` ID via
    the new SDK pattern
    `api.runtime.channel.outbound.loadAdapter("discord")`
    (replaces the old `api.runtime.channel.discord.sendMessageDiscord`
    call which no longer exists in v2026.5.7). 5. `extensions/voice-call/index.ts`: `start:` lifecycle now wires
    `rt.manager.onCallEnded = buildOnCallEndedHandler({ api, config })`
    after `ensureRuntime()` resolves.
  - Audio cleanup intentionally NOT re-ported: upstream v2026.5.7 streams
    TTS audio via Twilio Media Streams (mu-law over WebSocket) and never
    writes per-call mp3 files to disk, so the old
    `deleteCallAudioFiles(...)` is moot.
  - Other dropped customizations NOT re-ported in this pass (lower
    priority, can be re-added later if pain returns):
    - Pre-generated greeting audio (latency optimization).
    - Restart deferral when active calls exist.
    - Identity-hardening prompt text additions.

- Why:
  - Primary user pain after the Apr 29 rebase was that calls produced no
    `call_logs/` entries and no Discord summary; restoring this pipeline
    was the highest-leverage fix.

- Verified:
  - `npm run build` clean, `openclaw config validate` passes,
    `systemctl --user restart openclaw-gateway.service` starts cleanly
    with all 9 plugins loaded (voice-call included).

## 2026-04-29

### Upgrade: v2026.3.13-1 → v2026.5.7 (semantic re-application)

- What changed:
  - Created branch `upgrade/v2026.5.7` from upstream tag `v2026.5.7` and
    semantically re-applied the fork's voice-call + DeepSeek customizations
    onto upstream's heavily-restructured architecture (cherry-pick was
    impossible: upstream rewrote 1531 files / +232k LOC, including DELETING
    `streaming-response.ts`, `stt-openai-realtime.ts`, `tts-openai.ts`,
    `src/discord/voice/manager.ts`, and MOVING `src/memory/embeddings.ts` to
    `extensions/memory-core/`).
  - Ports applied (in scope):
    1. `src/utils/provider-utils.ts`: re-applied DeepSeek + MiniMax
       `<think>`-tag fallback inside upstream's plugin-aware
       `resolveReasoningOutputMode`. Substring match for `deepseek` /
       `minimax` returns `"tagged"` when no plugin override declares
       otherwise.
    2. `extensions/voice-call/src/agent-routing.ts` (new, ported as-is):
       `extractAgentIdFromSessionKey` + `resolveVoiceAgentId` so per-agent
       voice sessions resolve correctly.
    3. `extensions/voice-call/src/contact-file.ts` (new, ported as-is):
       loads `~/.openclaw/workspace/CONTACT_LIST.md`, exposes
       `findContactByPhone` and `resolveInboundGreeting` with `{name}`
       template substitution.
    4. `extensions/voice-call/src/llm-tag-cleanup.ts` (new, ported as-is):
       `stripLlmReasoningTags` removes well-formed and malformed
       `<think>/<thinking>/<thought>/<antthinking>/<final>` blocks.
    5. `extensions/voice-call/src/response-generator.ts`:
       - applied `stripLlmReasoningTags(text, { isFinal: true })` before
         JSON / plain-text spoken-text extraction so DeepSeek chain-of-
         thought never reaches TTS.
       - call-time agent ID now resolved via `resolveVoiceAgentId` (honors
         `agent:<id>:` session-key prefix).
       - if the caller is in `CONTACT_LIST.md`, the contact name is used in
         the system prompt as the caller label and the per-contact `info`
         block is appended for relational context.
    6. `extensions/voice-call/src/manager/events.ts`:
       - inbound-call greeting now resolved via `resolveInboundGreeting`
         (per-contact greeting > `config.inboundGreeting` > built-in
         fallback) with `{name}` substitution. Falls through cleanly when
         `CONTACT_LIST.md` is missing.
  - Restored docs: `CUSTOM_CHANGES.md`, `ARCHITECTURE.md`, `PROJECT_CONTEXT.md`,
    `AUTO_UPDATE_VERSION_ISSUE.md`, and prepended the fork's directory-
    safety/custom-fork preamble onto upstream's `AGENTS.md` (keeps upstream
    body intact).
- Why:
  - Upgrade gap was 27 stable releases with massive upstream restructuring
    of voice-call, gateway, memory, and Discord voice. A direct rebase /
    cherry-pick was infeasible.
- Dropped (per user scope decision):
  - Discord voice DAVE timeout / multipart blob fixes (file deleted
    upstream; revisit if Discord voice regresses).
  - Auto-reply DeepSeek harden + dedupe (likely superseded by upstream
    v2026.3.28 JSON-envelope suppression + iMessage tag stripping).
  - Memory search node-llama-cpp embedding tweaks (file moved + upstream
    v2026.4.22 sqlite-vec KNN restructure).
  - Gateway probe loopback device-identity (upstream v2026.3.22 reworked
    probe timeout handling).
  - Auto-update build tooling shims (no longer needed when starting from a
    clean v2026.5.7 base).
  - Custom `tools/custom/` workflow scripts (revisit when establishing
    next maintenance cadence).
- Files:
  - `src/utils/provider-utils.ts`
  - `extensions/voice-call/src/agent-routing.ts` (new)
  - `extensions/voice-call/src/contact-file.ts` (new)
  - `extensions/voice-call/src/llm-tag-cleanup.ts` (new)
  - `extensions/voice-call/src/response-generator.ts`
  - `extensions/voice-call/src/manager/events.ts`
  - `AGENTS.md`, `CUSTOM_CHANGES.md`, `ARCHITECTURE.md`, `PROJECT_CONTEXT.md`,
    `AUTO_UPDATE_VERSION_ISSUE.md`
- User-visible behavior:
  - DeepSeek `<think>` blocks no longer leak into voice/TTS responses.
  - Inbound calls from contacts in `CONTACT_LIST.md` are greeted by name
    using the per-contact greeting template, and the model receives the
    contact's `info` block in its system prompt.
- When merging from upstream:
  - Conflict-prone files: `extensions/voice-call/src/response-generator.ts`,
    `extensions/voice-call/src/manager/events.ts`,
    `src/utils/provider-utils.ts`. These all carry small fork additions —
    re-apply by intent if upstream rewrites them.

## 2026-03-10

### Fix: Discord voice DAVE handshake timeout

- What changed:
  - `PLAYBACK_READY_TIMEOUT_MS`: `30_000` → `45_000`
  - Disconnected recovery race: `5_000` → `15_000` (both Signalling + Connecting)
- Why:
  - Discord's DAVE (E2EE audio/video encryption) MLS session setup takes 13–22s.
  - The previous 30s timeout was too close to the edge, causing intermittent
    "Failed to join voice channel: The operation was aborted" errors.
  - The 5s reconnect race was also too tight when the bot briefly disconnected.
- Files:
  - `src/discord/voice/manager.ts`
- User-visible behavior:
  - Bot reliably joins and stays in voice channels with DAVE encryption enabled.
  - `daveEncryption` must remain `true` in config — Discord requires DAVE and
    will not send SessionDescription if `max_dave_protocol_version` is 0.

- What changed:
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
  - Added file-based inbound contact parsing from `~/.openclaw/workspace/CONTACT_LIST.md`.
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
    - contacts file path: `~/.openclaw/workspace/CONTACT_LIST.md`
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

## 2026-03-06

### Discord reply pipeline: DeepSeek final-tag fix, duplicate-reply guard, and fallback hardening

- What changed:
  - Split provider capabilities so DeepSeek keeps reasoning-tag handling but does not enable `<final>`-only enforcement.
    - Added `isEnforceFinalTagProvider()` and switched final-tag gating to this new helper.
    - Kept `isReasoningTagProvider()` behavior for stripping `<think>` content.
  - Hardened message-end fallback path when parsed assistant text is empty.
    - Removed the guard that disabled fallback under `enforceFinalTag`.
    - Added defensive stripping of `<think>...</think>` and `<final>` markers before fallback parse.
  - Fixed duplicate assistant sends when the messaging tool already delivered similar text.
    - `buildReplyPayloads()` now always applies text-level dedupe against `messagingToolSentTexts`.
    - Media dedupe behavior remains target-aware (unchanged intent).
  - Added provider utility tests for final-tag enforcement behavior.
- Why:
  - DeepSeek Chat does not wrap user-facing output with `<final>...</final>` tags.
  - Enforcing `<final>` for DeepSeek could collapse valid output to empty text and skip normal delivery.
  - In mixed tool + default reply paths, target-metadata mismatch could bypass dedupe and produce duplicated user-visible replies.
  - Fallback hardening prevents silent drops when tag parsing and model output format diverge.
- Files:
  - `src/utils/provider-utils.ts`
  - `src/utils/utils-misc.test.ts`
  - `src/auto-reply/reply/agent-runner-utils.ts`
  - `src/auto-reply/reply/get-reply-run.ts`
  - `src/agents/pi-embedded-subscribe.handlers.messages.ts`
  - `src/auto-reply/reply/agent-runner-payloads.ts`
- User-visible behavior:
  - Default Discord replies from DeepSeek no longer disappear due to `<final>` enforcement mismatch.
  - Duplicate identical replies (message tool + default send) are suppressed more reliably.
  - Fewer silent empty-reply outcomes when provider output formatting is inconsistent.
