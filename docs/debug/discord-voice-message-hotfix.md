# Discord Voice Message Hotfix (Issue #16103)

## Background

Some Discord voice message sends failed with a generic `Error` when using `asVoice=true`.
The previous implementation used a three-step upload URL flow:

1. `POST /channels/{id}/attachments`
2. `PUT` file to CDN upload URL
3. `POST /channels/{id}/messages` with `uploaded_filename`

In bot-token contexts, this could fail and produce low-detail errors.

## What Changed

The voice send path now uses a direct multipart request:

- `POST https://discord.com/api/v10/channels/{id}/messages`
- `payload_json` contains:
  - `flags: 8192` (`IS_VOICE_MESSAGE`, plus `4096` when `silent=true`)
  - voice attachment metadata (`duration_secs`, `waveform`)
  - optional `message_reference` for replies
- `files[0]` includes the OGG/Opus audio blob (`voice-message.ogg`)

## Files Changed

- `src/discord/voice-message.ts`
  - replaced upload-URL flow with multipart direct send
  - improved failure message to include HTTP status + response body snippet
- `src/discord/send.outbound.ts`
  - updated call site to pass Discord bot token into voice sender
- `src/discord/voice-message.test.ts`
  - added unit tests for multipart payload and rich error messages

## Why This Helps

- Avoids dependency on the attachment upload URL flow for voice messages.
- Improves observability when Discord rejects the request.
- Keeps existing OGG conversion and waveform/duration metadata behavior.

## Suggested Verification

1. Send a voice reply via:
   - `message(action="send", channel="discord", target="user:<id>", path="/abs/path/file.mp3", asVoice=true)`
2. Confirm Discord renders a native voice bubble (not a file attachment).
3. If it fails, check logs; error should include HTTP code and response details.
