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
