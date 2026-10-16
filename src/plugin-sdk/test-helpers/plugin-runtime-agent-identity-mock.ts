import { vi } from "vitest";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

/** Agent identity defaults shared by the complete runtime fixture. */
export function createPluginAgentIdentityRuntimeMock(): Pick<
  PluginRuntime["agent"],
  "resolveAgentIdentity" | "resolveAgentDisplayIdentity"
> {
  return {
    resolveAgentIdentity: vi.fn<PluginRuntime["agent"]["resolveAgentIdentity"]>(() => ({
      name: "test-agent",
    })),
    resolveAgentDisplayIdentity: vi.fn<PluginRuntime["agent"]["resolveAgentDisplayIdentity"]>(
      async ({ agentId }) => ({
        agentId: agentId ?? "main",
        name: "test-agent",
        avatar: "T",
        nameSource: "agent",
      }),
    ),
  };
}
