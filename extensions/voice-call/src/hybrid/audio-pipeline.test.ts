import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceCallConfig } from "../config.js";
import type { CoreConfig } from "../core-bridge.js";

const textToSpeech = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/tts-runtime", () => ({ textToSpeech }));

import { generateHybridAudioFile } from "./audio-pipeline.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  textToSpeech.mockReset();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("generateHybridAudioFile", () => {
  it("makes a private fallback TTS file readable by the public audio server", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-call-audio-"));
    tempDirs.push(root);
    const outputDir = path.join(root, "public");
    const emptyBinDir = path.join(root, "bin");
    const privateAudio = path.join(root, "fallback.mp3");
    fs.mkdirSync(emptyBinDir);
    fs.writeFileSync(privateAudio, "audio", { mode: 0o600 });

    vi.stubEnv("PATH", emptyBinDir);
    vi.stubEnv("VOICE_MESSAGES_DIR", outputDir);
    textToSpeech.mockResolvedValue({ success: true, audioPath: privateAudio });

    const result = await generateHybridAudioFile({
      text: "hello",
      voiceConfig: {} as VoiceCallConfig,
      coreConfig: {} as CoreConfig,
      callId: "test-call",
    });

    expect(result).toBeDefined();
    expect(fs.statSync(result!).mode & 0o777).toBe(0o644);
  });
});
