import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig as CoreConfig } from "openclaw/plugin-sdk/config-contracts";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceCallConfig } from "../config.js";

const textToSpeech = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/tts-runtime", () => ({ textToSpeech }));

import { deleteCallAudioFiles, generateHybridAudioUrl } from "./audio-pipeline.js";

const tempDirs: string[] = [];
const managedDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  textToSpeech.mockReset();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("generateHybridAudioUrl", () => {
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

    const result = await generateHybridAudioUrl({
      text: "hello",
      voiceConfig: { publicUrl: "https://example.test/voice" } as VoiceCallConfig,
      coreConfig: {} as CoreConfig,
      callId: "test-call",
    });

    expect(result).toBeDefined();
    if (!result) {
      throw new Error("Expected a public fallback audio URL");
    }
    const audioName = decodeURIComponent(path.basename(new URL(result).pathname));
    expect(new URL(result).origin).toBe("https://example.test");
    expect(fs.statSync(path.join(outputDir, audioName)).mode & 0o777).toBe(0o644);
  });
});

it("deletes only a late synthesis result after its call or turn is retired", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-call-stale-audio-"));
  tempDirs.push(root);
  const outputDir = path.join(root, "public");
  const emptyBinDir = path.join(root, "bin");
  const privateAudio = path.join(root, "fallback.mp3");
  fs.mkdirSync(emptyBinDir);
  fs.mkdirSync(outputDir);
  fs.writeFileSync(privateAudio, "audio", { mode: 0o600 });
  const newer = path.join(outputDir, "voice_testcall_newer.mp3");
  fs.writeFileSync(newer, "newer audio");
  vi.stubEnv("PATH", emptyBinDir);
  vi.stubEnv("VOICE_MESSAGES_DIR", outputDir);
  let resolveTts!: (result: { success: boolean; audioPath: string }) => void;
  const entered = new Promise<void>((resolve) => {
    textToSpeech.mockImplementation(() => {
      resolve();
      return new Promise((complete) => {
        resolveTts = complete;
      });
    });
  });
  let current = true;
  const pending = generateHybridAudioUrl({
    text: "stale",
    voiceConfig: { publicUrl: "https://example.test/voice" } as VoiceCallConfig,
    coreConfig: {} as CoreConfig,
    callId: "test-call",
    isCurrent: () => current,
  });
  await entered;
  current = false;
  resolveTts({ success: true, audioPath: privateAudio });
  expect(await pending).toBeUndefined();
  expect(fs.readdirSync(outputDir)).toEqual([path.basename(newer)]);
});

describe("deleteCallAudioFiles", () => {
  it("attempts sibling files despite one permission failure and retains unrelated audio", async () => {
    const directory = managedDirs.make("voice-call-delete-");
    const failed = path.join(directory, "voice_call1_failed.mp3");
    const removed = path.join(directory, "voice_call1_removed.mp3");
    const unrelated = path.join(directory, "voice_other_keep.mp3");
    for (const name of [failed, removed, unrelated]) {
      fs.writeFileSync(name, "audio");
    }
    const unlink = fsp.unlink.bind(fsp);
    vi.spyOn(fsp, "unlink").mockImplementation(async (target) => {
      if (String(target) === failed) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      await unlink(target);
    });
    await expect(deleteCallAudioFiles("call-1", [], directory)).rejects.toBeInstanceOf(
      AggregateError,
    );
    expect(fs.existsSync(failed)).toBe(true);
    expect(fs.existsSync(removed)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it("reports directory I/O failures but treats missing audio as already cleaned", async () => {
    const directory = managedDirs.make("voice-call-delete-directory-");
    vi.spyOn(fsp, "readdir").mockRejectedValueOnce(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );
    await expect(deleteCallAudioFiles("call-1", [], directory)).rejects.toBeInstanceOf(
      AggregateError,
    );
    await expect(
      deleteCallAudioFiles("call-1", [], path.join(directory, "absent")),
    ).resolves.toBeUndefined();
  });
});
