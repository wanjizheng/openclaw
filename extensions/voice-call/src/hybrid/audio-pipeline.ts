/**
 * Hybrid voice-call audio pipeline.
 *
 * Generates ElevenLabs v3 mp3 files via the `sag` CLI (with core TTS as
 * fallback) and converts them to publicly hostable URLs.  These URLs are
 * injected into a live Twilio call via Call Update <Play> TwiML by the
 * hybrid play queue (see twilio.ts).
 *
 * Audio files are written to a directory served publicly by nginx (default
 * `~/.openclaw/workspace/voice_messages/`, mapped to
 * `${publicUrl-origin}/audio/`).
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { VoiceCallConfig } from "../config.js";
import type { CoreConfig } from "../core-bridge.js";

/** Resolve the directory where hybrid mode writes generated mp3 files. */
export function resolveVoiceMessagesDir(): string {
  const fromEnv = process.env.VOICE_MESSAGES_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return path.join(os.homedir(), ".openclaw", "workspace", "voice_messages");
}

/**
 * Resolve the public base URL where the audio directory is hosted.
 * Honors `VOICE_CALL_AUDIO_BASE_URL` / `AUDIO_BASE_URL` env overrides; otherwise
 * derives `${publicUrl-origin}/audio` from the voice-call config.
 */
export function resolveAudioBaseUrl(config: VoiceCallConfig): string | undefined {
  const envBase = process.env.VOICE_CALL_AUDIO_BASE_URL?.trim();
  if (envBase) {
    return envBase.replace(/\/+$/, "");
  }

  const legacyEnvBase = process.env.AUDIO_BASE_URL?.trim();
  if (legacyEnvBase) {
    return legacyEnvBase.replace(/\/+$/, "");
  }

  const publicUrl = config.publicUrl?.trim();
  if (!publicUrl) {
    return undefined;
  }

  try {
    const origin = new URL(publicUrl).origin;
    return `${origin}/audio`;
  } catch {
    return undefined;
  }
}

/** Convert a local mp3 file path to a publicly accessible URL. */
export function localPathToPublicUrl(
  localPath: string,
  config: VoiceCallConfig,
): string | undefined {
  const baseUrl = resolveAudioBaseUrl(config);
  if (!baseUrl) {
    return undefined;
  }
  const fileName = path.basename(localPath);
  return `${baseUrl}/${encodeURIComponent(fileName)}`;
}

/**
 * Synthesize the given text via the `sag` CLI (ElevenLabs v3 by default).
 * Returns true on success (output file exists).
 */
async function synthesizeWithSag(text: string, outputPath: string): Promise<boolean> {
  const voiceId = process.env.SAG_VOICE_ID?.trim() || "9lHjugDhwqoxA5MhX0az";
  const modelId = process.env.SAG_MODEL_ID?.trim() || "eleven_v3";
  const timeoutMs = Number(process.env.SAG_TIMEOUT_MS || "15000");

  return await new Promise<boolean>((resolve) => {
    const args = ["speak", "-v", voiceId, "--model-id", modelId, "--output", outputPath, text];
    const proc = spawn("sag", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk ?? "");
    });

    const timer = setTimeout(
      () => {
        proc.kill("SIGKILL");
        console.warn("[voice-call][hybrid] sag TTS timed out");
        resolve(false);
      },
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 45_000,
    );

    proc.on("error", (err) => {
      clearTimeout(timer);
      console.warn(`[voice-call][hybrid] sag TTS unavailable: ${err.message}`);
      resolve(false);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.warn(`[voice-call][hybrid] sag TTS failed (exit ${code}): ${stderr.trim()}`);
        resolve(false);
        return;
      }
      resolve(existsSync(outputPath));
    });
  });
}

/**
 * Generate an mp3 file for the given text and return its local path.
 * Tries `sag` (ElevenLabs v3) first, falls back to core TTS.
 */
export async function generateHybridAudioFile(params: {
  text: string;
  voiceConfig: VoiceCallConfig;
  coreConfig: CoreConfig;
  /** When provided, the file name is prefixed with the call id for easy cleanup. */
  callId?: string;
}): Promise<string | undefined> {
  try {
    const outputDir = resolveVoiceMessagesDir();
    mkdirSync(outputDir, { recursive: true });

    const callTag = params.callId ? `voice_${params.callId.replace(/-/g, "")}` : "call";
    const fileName = `${callTag}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}.mp3`;
    const destPath = path.join(outputDir, fileName);

    const sagOk = await synthesizeWithSag(params.text, destPath);
    if (sagOk) {
      chmodSync(destPath, 0o644);
      return destPath;
    }

    // Fallback: plugin-sdk textToSpeech (best effort)
    try {
      const ttsRuntime = (await import("openclaw/plugin-sdk/tts-runtime")) as {
        textToSpeech?: (input: {
          text: string;
          cfg: unknown;
          channel: string;
        }) => Promise<{ success: boolean; audioPath?: string }>;
      };
      if (typeof ttsRuntime.textToSpeech === "function") {
        const ttsResult = await ttsRuntime.textToSpeech({
          text: params.text,
          cfg: params.coreConfig,
          channel: "voice-call",
        });
        if (ttsResult.success && ttsResult.audioPath) {
          copyFileSync(ttsResult.audioPath, destPath);
          // Core TTS temp files are private. The hosted copy must be readable by
          // the nginx worker or Twilio receives a 403 and ends the call.
          chmodSync(destPath, 0o644);
          return destPath;
        }
      }
    } catch (err) {
      console.warn(
        `[voice-call][hybrid] Fallback TTS failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return undefined;
  } catch (err) {
    console.warn(
      `[voice-call][hybrid] Audio generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * Convenience: generate an audio file and return its public URL (or undefined
 * if generation or URL resolution fails).
 */
export async function generateHybridAudioUrl(params: {
  text: string;
  voiceConfig: VoiceCallConfig;
  coreConfig: CoreConfig;
  callId?: string;
}): Promise<string | undefined> {
  const localPath = await generateHybridAudioFile(params);
  if (!localPath) {
    return undefined;
  }
  return localPathToPublicUrl(localPath, params.voiceConfig);
}

/**
 * Delete all audio files generated for a specific call.
 * Removes files named `voice_{callIdNoDashes}_*.mp3`, plus any extra URLs
 * passed (e.g., a pre-generated initial-message file with no callId prefix).
 */
export async function deleteCallAudioFiles(
  callId: string,
  extraUrls: string[] = [],
): Promise<void> {
  const dir = resolveVoiceMessagesDir();
  const tag = `voice_${callId.replace(/-/g, "")}`;
  const deleted: string[] = [];

  try {
    const files = await fsp.readdir(dir);
    await Promise.all(
      files
        .filter((f) => f.startsWith(tag) && f.endsWith(".mp3"))
        .map((f) => {
          deleted.push(f);
          return fsp.unlink(path.join(dir, f)).catch(() => {});
        }),
    );
  } catch {
    // Directory missing or unreadable — nothing to do.
  }

  await Promise.all(
    extraUrls.map(async (urlOrPath) => {
      const fileName = decodeURIComponent(urlOrPath.split("/").pop() ?? "");
      if (!fileName) {
        return;
      }
      const fp = path.join(dir, fileName);
      deleted.push(fileName);
      await fsp.unlink(fp).catch(() => {});
    }),
  );

  if (deleted.length > 0) {
    console.log(
      `[voice-call][hybrid] Cleaned up ${deleted.length} audio file(s) for call ${callId}`,
    );
  }
}
