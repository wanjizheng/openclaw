import fs from "node:fs";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
} from "./doctor-health-contributions.test-support.js";

/** Reuse the contribution suite's mocks and context while grouping update config authority tests. */
export function registerDoctorUpdateConfigTests({
  mocks,
  createDoctorContext,
  requireDoctorContribution,
}: {
  mocks: { replaceConfigFile: Mock; applyWizardMetadata: Mock; readConfigFileSnapshot: Mock };
  createDoctorContext: (
    overrides?: Parameters<typeof createDoctorHealthFlowContext>[0] & { shouldRepair?: boolean },
  ) => ReturnType<typeof createDoctorHealthFlowContext>;
  requireDoctorContribution: (
    id: string,
  ) => ReturnType<typeof resolveDoctorHealthContributions>[number];
}) {
  describe("config size drops during update", () => {
    beforeEach(() => {
      mocks.replaceConfigFile.mockReset().mockResolvedValue(undefined);
      mocks.applyWizardMetadata.mockImplementation((cfg: unknown) => cfg);
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
    });

    function buildWriteConfigCtx(env: Record<string, string | undefined>) {
      const cfg: OpenClawConfig = { gateway: { mode: "local" } };
      return createDoctorContext({
        cfg,
        cfgForPersistence: { gateway: { mode: "remote" } },
        configResult: {
          cfg,
          shouldWriteConfig: true,
          skipPluginValidationOnWrite: false,
        },
        shouldRepair: true,
        env,
      });
    }

    const writeConfigContribution = requireDoctorContribution("doctor:write-config");

    it.each([
      {
        name: "legacy update parents",
        env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
        shouldWrite: false,
        skipPluginValidation: true,
      },
      {
        name: "current update parents",
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        },
        shouldWrite: true,
        skipPluginValidation: true,
      },
    ])("handles config writes for $name", async ({ env, shouldWrite, skipPluginValidation }) => {
      const ctx = buildWriteConfigCtx(env);

      await writeConfigContribution.run(ctx);

      if (shouldWrite) {
        expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
          expect.objectContaining({
            writeOptions: expect.objectContaining({
              auditOrigin: "doctor",
              allowConfigSizeDrop: false,
              authorizedDestructivePaths: [],
              skipPluginValidation,
            }),
          }),
        );
      } else {
        expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
        expect(ctx.runtime.log).toHaveBeenCalledWith(
          "Skipping doctor config write during legacy update handoff.",
        );
      }
    });

    it("retains only named migration shrink authority during an update", async () => {
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });
      ctx.configResult.allowConfigSizeDropOnWrite = true;
      ctx.configResult.authorizedDestructivePaths = [["channels", "legacy.name"]];
      await writeConfigContribution.run(ctx);
      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            allowConfigSizeDrop: true,
            authorizedDestructivePaths: [["channels", "legacy.name"]],
          }),
        }),
      );
    });

    it("preserves source config version for legacy parent writable update doctor writes", async () => {
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });
      ctx.configResult.sourceLastTouchedVersion = "2026.5.16-beta.4";

      await writeConfigContribution.run(ctx);

      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            lastTouchedVersionOverride: "2026.5.16-beta.4",
          }),
        }),
      );
    });

    it("does not preserve source config version for explicit deferral update doctors", async () => {
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });
      ctx.configResult.sourceLastTouchedVersion = "2026.5.16-beta.4";

      await writeConfigContribution.run(ctx);

      expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          writeOptions: expect.not.objectContaining({
            lastTouchedVersionOverride: expect.anything(),
          }),
        }),
      );
    });

    it("consumes committed roster format while preserving later explicit edits", async () => {
      const ctx = buildWriteConfigCtx({});
      ctx.cfg.agents = { ownership: "explicit", entries: { default: {} } };
      ctx.configResult.persistCanonicalAgentRoster = true;
      ctx.configResult.explicitSetPaths = [["agents", "ownership"]];

      await writeConfigContribution.run(ctx);

      expect(mocks.replaceConfigFile).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            persistCanonicalAgentRoster: true,
            explicitSetPaths: [["agents", "ownership"]],
          }),
        }),
      );

      expect(ctx.configResultWriteCommitted).toBe(true);
      expect(ctx.configResult.persistCanonicalAgentRoster).toBe(true);

      ctx.cfg = { ...ctx.cfg, gateway: { mode: "remote" } };
      await writeConfigContribution.run(ctx);

      expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(2);
      expect(mocks.replaceConfigFile).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          writeOptions: expect.objectContaining({
            persistCanonicalAgentRoster: undefined,
            explicitSetPaths: [["agents", "ownership"]],
          }),
        }),
      );
    });

    it("points update-time config rewrites at the pre-update backup", async () => {
      vi.mocked(fs.existsSync).mockImplementation((value) => String(value).endsWith(".pre-update"));
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });

      await writeConfigContribution.run(ctx);

      expect(ctx.runtime.log).toHaveBeenCalledWith(
        "Update changed config; pre-update backup: /tmp/fake-openclaw.json.pre-update",
      );
    });

    it("skips plugin schema validation for final validation during update doctor runs", async () => {
      const contribution = requireDoctorContribution("doctor:final-config-validation");

      await contribution.run(
        createDoctorContext({
          cfg: {},
          cfgForPersistence: {},
          configResult: { cfg: {} },
          shouldRepair: true,
          env: {
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
          },
        }),
      );

      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({
        skipPluginValidation: true,
      });
    });

    it("keeps plugin schema validation for ordinary doctor final validation", async () => {
      const contribution = requireDoctorContribution("doctor:final-config-validation");

      await contribution.run(
        createDoctorContext({
          cfg: {},
          cfgForPersistence: {},
          configResult: { cfg: {} },
          shouldRepair: true,
          env: {},
        }),
      );

      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({
        skipPluginValidation: false,
      });
    });
  });
}
