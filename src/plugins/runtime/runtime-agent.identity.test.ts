import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntimeAgent } from "./runtime-agent.js";

describe("plugin runtime agent display identity", () => {
  it("uses the canonical workspace name with real bold-colon identity metadata", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-display-identity-"));
    try {
      await fs.writeFile(
        path.join(workspaceDir, "IDENTITY.md"),
        "# Identity\n- **Name:** Willow\n- **NickName:** Leaf\n",
      );
      await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Your name is **Willow**.\n");
      const identity = await createRuntimeAgent().resolveAgentDisplayIdentity({
        cfg: {},
        agentId: "main",
        workspaceDir,
      });
      expect(identity).toMatchObject({ name: "Willow", nameSource: "workspace", agentId: "main" });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("preserves canonical configured-name precedence over workspace metadata", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-display-identity-"));
    try {
      await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), "- Name: Willow\n");
      const identity = await createRuntimeAgent().resolveAgentDisplayIdentity({
        cfg: { agents: { entries: { main: { identity: { name: "Juniper" } } } } },
        agentId: "main",
        workspaceDir,
      });
      expect(identity).toMatchObject({ name: "Juniper", nameSource: "agent", agentId: "main" });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
