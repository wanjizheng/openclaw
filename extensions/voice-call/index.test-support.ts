// Voice-call CLI test fixtures own registration and captured command execution.
import { Command } from "commander";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";

export function createVoiceCallCliTestHarness(logger: OpenClawPluginApi["logger"]) {
  function captureStdout() {
    let output = "";
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      output += String(chunk);
      return true;
    });
    return {
      output: () => output,
      restore: () => writeSpy.mockRestore(),
    };
  }

  async function registerVoiceCallCli(
    program: Command,
    pluginConfig: Record<string, unknown> = { provider: "mock" },
  ) {
    const registerCli = vi.fn<OpenClawPluginApi["registerCli"]>();
    plugin.register(
      createTestPluginApi({
        id: "voice-call",
        name: "Voice Call",
        description: "test",
        version: "0",
        source: "test",
        registrationMode: "full",
        config: {},
        pluginConfig,
        runtime: createPluginRuntimeMock({ tts: { textToSpeechTelephony: vi.fn() } }),
        logger,
        registerGatewayMethod: () => {},
        registerTool: () => {},
        registerCli,
        registerService: () => {},
        resolvePath: (p: string) => p,
      }),
    );
    const registrar = registerCli.mock.calls[0]?.[0];
    if (!registrar) {
      throw new Error("voice-call CLI registrar was not registered");
    }
    await registrar({ program, parentPath: [], config: {}, workspaceDir: undefined, logger });
  }

  async function runVoiceCallCli(
    args: string[],
    pluginConfig: Record<string, unknown> = { provider: "mock" },
  ): Promise<string> {
    vi.stubEnv("OPENCLAW_CLI", "1");
    const program = new Command();
    const stdout = captureStdout();
    try {
      await registerVoiceCallCli(program, pluginConfig);
      await program.parseAsync(args, { from: "user" });
      return stdout.output();
    } finally {
      stdout.restore();
    }
  }

  return { captureStdout, registerVoiceCallCli, runVoiceCallCli };
}
