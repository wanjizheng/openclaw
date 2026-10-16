import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { listConfigAuditRecordsForTests } from "./io.audit.test-support.js";
import type { createConfigIO } from "./io.js";
import {
  configPathForHome,
  formatConfig,
  writeConfigFixture,
} from "./io.write-config.test-support.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.openclaw.js";

/** Register migration shrink and gateway protection cases under the owning IO suite fixture. */
export function registerConfigWriteDestructiveAuthorityTests({
  itWithHome,
  createHomeConfigIO,
  createExistingConfigSnapshot,
  expectConfigWriteRejected,
}: {
  itWithHome: (name: string, testCase: (home: string) => Promise<void>) => void;
  createHomeConfigIO: (
    home: string,
    options?: Parameters<typeof createConfigIO>[0],
  ) => ReturnType<typeof createConfigIO>;
  createExistingConfigSnapshot: (
    configPath: string,
    config: OpenClawConfig,
    raw: string | null,
  ) => ConfigFileSnapshot;
  expectConfigWriteRejected: (promise: Promise<unknown>) => Promise<void>;
}) {
  itWithHome("bounds migration size-drop authority to its exact paths", async (home) => {
    const original = {
      gateway: { mode: "local" as const },
      channels: {
        telegram: {
          enabled: true,
          allowFrom: Array.from({ length: 80 }, (_, i) => `telegram:${i}`),
        },
      },
      tools: { allow: ["exec", "read", "write"] },
    };
    await writeConfigFixture(home, original);
    const configPath = configPathForHome(home);
    const originalRaw = await fs.readFile(configPath, "utf-8");
    const io = createHomeConfigIO(home, { env: { VITEST: "true" } as NodeJS.ProcessEnv });
    const candidate = { gateway: original.gateway, tools: original.tools };
    await expectConfigWriteRejected(
      io.writeConfigFile(candidate, {
        allowConfigSizeDrop: true,
        authorizedDestructivePaths: [["channels", "telegram"]],
      }),
    );
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    await expectConfigWriteRejected(
      io.writeConfigFile(
        { gateway: original.gateway },
        {
          allowConfigSizeDrop: true,
          authorizedDestructivePaths: [["channels"]],
        },
      ),
    );
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    await io.writeConfigFile(candidate, {
      allowConfigSizeDrop: true,
      authorizedDestructivePaths: [["channels"]],
    });
    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8"));
    expect(persisted.channels).toBeUndefined();
    expect(persisted.tools).toEqual(original.tools);
  });

  itWithHome(
    "allows intentional size-drop writes without disabling gateway-mode protection",
    async (home) => {
      const configPath = configPathForHome(home);
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.4.30" },
        gateway: { mode: "local" },
        channels: {
          telegram: {
            enabled: true,
            allowFrom: Array.from({ length: 80 }, (_, index) => `telegram:${index}`),
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = formatConfig(original);
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createHomeConfigIO(home, {
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
      });
      const baseSnapshot = createExistingConfigSnapshot(configPath, original, originalRaw);

      const acceptedWrite = await io.writeConfigFile(
        { meta: original.meta, gateway: { mode: "local" } },
        {
          allowConfigSizeDrop: true,
          baseSnapshot,
        },
      );
      expect(acceptedWrite.persistedConfig.gateway).toEqual({ mode: "local" });
      const acceptedSnapshot = await io.readConfigFileSnapshot();

      await expectConfigWriteRejected(
        io.writeConfigFile(
          { meta: original.meta },
          {
            allowConfigSizeDrop: true,
            baseSnapshot: acceptedSnapshot,
          },
        ),
      );
    },
  );
  for (const scoped of [false, true]) {
    for (const repair of [false, true]) {
      itWithHome(
        `keeps invalid array roots in the writer rejection/repair flow (scoped=${scoped}, repair=${repair})`,
        async (home) => {
          const configPath = configPathForHome(home);
          const originalRaw = "[]\n";
          await fs.mkdir(path.dirname(configPath), { recursive: true });
          await fs.writeFile(configPath, originalRaw, "utf-8");
          const env: NodeJS.ProcessEnv = { VITEST: "true", OPENCLAW_TEST_FAST: "1" };
          const io = createHomeConfigIO(home, { configPath, env });
          const candidate: OpenClawConfig = { gateway: { mode: "local" } };
          const options = {
            allowConfigSizeDrop: true,
            allowDestructiveWrite: repair,
            ...(scoped ? { authorizedDestructivePaths: [] } : {}),
          };
          if (repair) {
            await io.writeConfigFile(candidate, options);
            expect(JSON.parse(await fs.readFile(configPath, "utf-8"))).toMatchObject(candidate);
          } else {
            await expect(io.writeConfigFile(candidate, options)).rejects.toMatchObject({
              code: "CONFIG_WRITE_REJECTED",
              reasons: expect.arrayContaining(["unreadable-config-before-write"]),
            });
            await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
            const rejected = (await fs.readdir(path.dirname(configPath))).filter((name) =>
              name.includes(".rejected."),
            );
            expect(rejected).toHaveLength(1);
            expect(
              JSON.parse(
                await fs.readFile(path.join(path.dirname(configPath), rejected[0]!), "utf-8"),
              ),
            ).toMatchObject(candidate);
          }
          const audit = listConfigAuditRecordsForTests({ env, homedir: () => home }).findLast(
            (entry) => entry.event === "config.write" && entry.configPath === configPath,
          );
          expect(audit).toMatchObject({
            event: "config.write",
            result: repair ? "rename" : "rejected",
          });
        },
      );
    }
  }
}
