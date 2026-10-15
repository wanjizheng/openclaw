# @openclaw/voice-call

Official Voice Call plugin for **OpenClaw**.

Providers:

- **Twilio** (Programmable Voice + Media Streams)
- **Telnyx** (Call Control v2)
- **Plivo** (Voice API + XML transfer + GetInput speech)
- **Mock** (dev/no network)

Docs: `https://docs.openclaw.ai/plugins/voice-call`
Plugin system: `https://docs.openclaw.ai/tools/plugin`

## Install

For this customized fork, use the repository custom deployment scripts to install
the locally built plugin artifact. The npm command below installs the official
upstream plugin; use it only when that is the intended artifact.

```bash
openclaw plugins install @openclaw/voice-call
```

Restart the Gateway afterwards.

## Local dev install

```bash
PLUGIN_HOME=~/.openclaw/extensions
mkdir -p "$PLUGIN_HOME"
cp -R <local-plugin-checkout> "$PLUGIN_HOME/voice-call"
cd "$PLUGIN_HOME/voice-call" && pnpm install
```

## Config

Put under `plugins.entries.voice-call.config`:

```json5
{
  provider: "twilio", // or "telnyx" | "plivo" | "mock"
  fromNumber: "+15550001234",
  toNumber: "+15550005678",
  sessionScope: "per-phone", // or "per-call" | "main"

  twilio: {
    accountSid: "ACxxxxxxxx",
    authToken: "your_token",
  },

  telnyx: {
    apiKey: "KEYxxxx",
    connectionId: "CONNxxxx",
    // Telnyx webhook public key from the Telnyx Mission Control Portal
    // (Base64 string; can also be set via TELNYX_PUBLIC_KEY).
    publicKey: "...",
  },

  plivo: {
    authId: "MAxxxxxxxxxxxxxxxxxxxx",
    authToken: "your_token",
  },

  // Webhook server
  serve: {
    port: 3334,
    path: "/voice/webhook",
  },

  // Public exposure (pick one):
  // publicUrl: "https://example.ngrok.app/voice/webhook",
  // tunnel: { provider: "ngrok" },
  // tailscale: { mode: "funnel", port: 8443, path: "/voice/webhook" }

  outbound: {
    defaultMode: "notify", // or "conversation"
  },

  // Optional response agent workspace. Defaults to "main".
  agentId: "main",

  streaming: {
    enabled: true,
    // optional; if omitted, Voice Call picks the first registered
    // realtime-transcription provider by autoSelectOrder
    provider: "<realtime-transcription-provider-id>",
    streamPath: "/voice/stream",
    providers: {
      "<realtime-transcription-provider-id>": {
        // provider-owned options
      },
    },
    preStartTimeoutMs: 5000,
    maxPendingConnections: 32,
    maxPendingConnectionsPerIp: 4,
    maxConnections: 128,
  },
}
```

Notes:

- Twilio/Telnyx/Plivo require a **publicly reachable** webhook URL.
- `tailscale.port` defaults to `443` and owns the external HTTPS port for both legacy `tailscale.mode` and unified Tailscale tunnel providers. Funnel supports `443`, `8443`, or `10000`; Serve accepts any valid TCP port.
- Twilio defaults to US1. For a non-US Region, set `twilio.region` to `ie1` or `au1` and use credentials created in that Region; see [Twilio's regional REST API guide](https://www.twilio.com/docs/global-infrastructure/using-the-twilio-rest-api-in-a-non-us-region).
- `mock` is a local dev provider (no network calls).
- Telnyx requires `telnyx.publicKey` (or `TELNYX_PUBLIC_KEY`) unless `skipSignatureVerification` is true.
- Runtime accepts canonical config only. If older configs still use `provider: "log"`, `twilio.from`, or legacy `streaming.*` OpenAI keys, run `openclaw doctor --fix` to rewrite them.
- advanced webhook, streaming, and tunnel notes: `https://docs.openclaw.ai/plugins/voice-call`
- `responseModel` is optional. When unset, voice responses use the runtime default model.
- `sessionScope` defaults to `per-phone`, preserving caller memory across calls. Use `per-call` for reception, booking, IVR, and bridge flows where each carrier call should start fresh. Use `main` to share the configured agent's main session (`agent:<agentId>:main`, or `global` when core `session.scope` is `"global"`). Custom core `session.mainKey` values are ignored.
- `realtime.consultThinkingLevel` is optional. When set, it overrides the thinking level used by the model behind realtime `openclaw_agent_consult` calls.
- `realtime.consultFastMode` is optional. When set, it toggles fast mode for realtime `openclaw_agent_consult` calls.

## Stale call reaper

See the plugin docs for recommended ranges and production examples:
`https://docs.openclaw.ai/plugins/voice-call#stale-call-reaper`

## TTS for calls

Voice Call uses the core `tts` configuration for
streaming speech on calls. Override examples and provider caveats live here:
`https://docs.openclaw.ai/plugins/voice-call#tts-for-calls`

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall speak --call-id <id> --message "One moment"
openclaw voicecall end --call-id <id>
openclaw voicecall status --json
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw voicecall expose --mode funnel
```

## Tool

Tool name: `voice_call`

Actions:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

## Gateway RPC

- `voicecall.initiate` (to?, message, mode?)
- `voicecall.continue` (callId, message)
- `voicecall.speak` (callId, message)
- `voicecall.end` (callId)
- `voicecall.status` (callId)

## Notes

- Uses webhook signature verification for Twilio/Telnyx/Plivo.
- Adds replay protection for Twilio and Plivo webhooks (valid duplicate callbacks are ignored safely).
- Twilio speech turns include a per-turn token so stale/replayed callbacks cannot complete a newer turn.
- `responseModel` / `responseSystemPrompt` control AI auto-responses.
- Voice-call auto-responses enforce a spoken JSON contract (`{"spoken":"..."}`) and filter reasoning/meta output before playback.
- While a Twilio stream is active, playback does not fall back to TwiML `<Say>`; stream-TTS failures fail the playback request.
- Outbound conversation calls suppress barge-in only while the initial greeting is actively speaking, then re-enable normal interruption.
- Twilio stream disconnect auto-end uses a short grace window so quick reconnects do not end the call.
- Realtime provider selection is generic. Configure `streaming.provider` / `realtime.provider` and put provider-owned options under `providers.<id>`.

## Custom fork behavior

This fork retains hybrid Twilio playback. Set `streaming.enabled` and
`streaming.hybridMode` to `true`, leave `realtime.enabled` false, and expose both
`streaming.streamPath` and `streaming.crPath` (default `/voice/cr`). Hybrid calls
use an authenticated inbound transcription stream and a signed ConversationRelay
event socket. Generated MP3s use `sag`, with host TTS as a fallback, and require
a public audio directory. `VOICE_MESSAGES_DIR` selects that directory;
`VOICE_CALL_AUDIO_BASE_URL` selects its public URL. The fallback public URL is
`<publicUrl origin>/audio`. Files are readable by the audio server; this plugin
does not relax permissions on the rest of the state directory.

Opening audio is prepared before outbound dialing and reused when the call
answers. A preparation failure retries synthesis on answer. Playback callbacks
carry a distinct turn token and callback index; signed duplicate callbacks reuse
their cached response. `[END_CALL]` and mutual farewells in hybrid replies hang
up after the final audio finishes, rather than during playback.

ConversationRelay URLs carry a random, one-use grant tied to the exact call and
current service instance. Each grant expires after five minutes, allowing initial
playback/network setup without leaving an unlimited admission window. A matching
`setup.callSid` is required before a fresh connection can replace the previous
socket. Issuing a pending replacement alone does not revoke the live connection.
Terminal calls and service retirement revoke admission.

[Twilio documents reconnecting through a new `<Connect><ConversationRelay>` returned
by the `<Connect>` action callback](https://www.twilio.com/docs/voice/conversationrelay/websocket-messages#websocket-reconnection-logic),
with the same Call SID; it does not automatically reconnect a disconnected socket.
This fork emits that signed callback with a one-use action nonce and returns a
fresh call-bound WebSocket grant. MP3 completion/barge-in likewise emits a fresh
grant. Reusing an old signed WebSocket URL is rejected. Retrying a successful
CR action callback after a lost HTTP response returns the exact same CR-only
response: it does not rotate the grant or extend its expiry, and a spent grant
still cannot connect again. Initial/media webhook replays remain token-free.
Once newer TwiML has issued a pending grant, an older active connection's action
cannot restore the superseded flow. If the corresponding MP3 Call Update fails
before installing that TwiML, the old socket remains valid but its action callback
cannot recover it after a later disconnect; automatic recovery is not guaranteed
in this failure window. Do not log these private URL parameters.
[Twilio requires signature validation for the initial WebSocket handshake](https://www.twilio.com/docs/voice/conversationrelay/onboarding#websocket-security-with-signature-validation);
the grant supplements that validation. Custom `<Parameter>` values appear only in
`setup.customParameters`, so admission uses the signed URL query before upgrade.

`CONTACT_LIST.md` supplies known caller context. Completed calls produce dated
Markdown reports under the recorded agent's `call_logs` directory. Discord delivery
requires an explicit `postCallReport.discord.target`, such as `user:123456789012345678`
for a DM or `channel:123456789012345678` for a channel. A single `discord:` prefix
is also accepted. Without this setting, reports stay local. Discord sender
allowlists (`allowFrom`) never choose the report recipient. Set optional
`postCallReport.discord.accountId` to select a configured Discord account; otherwise
the outbound adapter uses its default account. For example:

```json
{
  "postCallReport": {
    "discord": {
      "target": "user:123456789012345678",
      "accountId": "reports"
    }
  }
}
```

Targets must identify one numeric user or channel. Wildcards, access groups,
mentions, lists, names and unprefixed IDs are rejected. Summary runs have no tools
or durable auxiliary session. Reports are
published from a complete, synced temporary file with an atomic no-clobber link;
the final report is the dedupe receipt. A crash after publication but before
Discord delivery can miss the notification. External delivery is best effort,
not transactional exactly-once delivery. Empty phantom calls are not reported.

Cleanup uses the recorded call agent and the host session lifecycle API. It
removes only generated per-call sessions and call audio; shared/per-phone/main
sessions survive. Service retirement prevents new reports or playback effects.
Late synthesis removes its own obsolete audio file without deleting audio owned
by a newer turn.
