import fs from "node:fs";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import { VoiceCallConfigSchema } from "./src/config.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
) as { configSchema: JsonSchemaObject };

function validateManifestConfig(value: unknown) {
  return validateJsonSchemaValue({
    cacheKey: "voice-call.manifest.hybrid-config",
    schema: manifest.configSchema,
    value,
  });
}

describe("voice-call manifest streaming admission", () => {
  it("admits the hybrid configuration accepted by the runtime before plugin loading", () => {
    const config = {
      streaming: { enabled: true, hybridMode: true, crPath: "/acceptance/voice/cr" },
    };

    expect(VoiceCallConfigSchema.safeParse(config).success).toBe(true);
    expect(validateManifestConfig(config).ok).toBe(true);
  });

  it.each([
    ["non-boolean hybrid flag", { hybridMode: "true" }],
    ["non-string CR path", { crPath: 123 }],
    ["empty CR path", { crPath: "" }],
    ["unknown streaming field", { hybridMode: true, unexpected: true }],
  ])("rejects %s at both configuration boundaries", (_name, streaming) => {
    const config = { streaming };

    expect(VoiceCallConfigSchema.safeParse(config).success).toBe(false);
    expect(validateManifestConfig(config).ok).toBe(false);
  });
});
