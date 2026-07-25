// Covers config write preparation, backup, and persistence behavior.
import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { readPersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { clearLoadPluginMetadataSnapshotMemo } from "../plugins/plugin-metadata-snapshot.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { hashConfigIncludeRaw } from "./includes.js";
import {
  createConfigIO,
  getRuntimeConfigSourceSnapshot,
  readConfigFileSnapshotForWrite,
  registerConfigWriteListener,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
  writeConfigFile,
} from "./io.js";
import { collectDestructiveChanges, configPathKey } from "./io.write-prepare.js";
import { replaceConfigFile } from "./mutate.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.openclaw.js";

const CONFIG_CLOBBER_SNAPSHOT_LIMIT = 32;
type ConfigHealthDatabase = Pick<OpenClawStateKyselyDatabase, "config_health_entries">;

// Mock the plugin manifest registry so we can register a fake channel whose
// AJV JSON Schema carries a `default` value.  This lets the #56772 regression
// test exercise the exact code path that caused the bug: AJV injecting
// defaults during the write-back validation pass.
const mockLoadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn(
    (): PluginManifestRegistry => ({
      diagnostics: [],
      plugins: [],
    }),
  ),
);
const mockMaintainConfigBackups = vi.hoisted(() =>
  vi.fn<typeof import("./backup-rotation.js").maintainConfigBackups>(async () => {}),
);

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: mockLoadPluginManifestRegistry,
}));

vi.mock("../plugins/plugin-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/plugin-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForPluginRegistry: mockLoadPluginManifestRegistry,
  };
});

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  return {
    ...actual,
    listPluginDoctorLegacyConfigRules: () => [],
    applyPluginDoctorCompatibilityMigrations: () => ({ next: null, changes: [] }),
  };
});

vi.mock("./backup-rotation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backup-rotation.js")>();
  return {
    ...actual,
    maintainConfigBackups: mockMaintainConfigBackups,
  };
});

describe("config io write", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-io-" });
  const silentLogger = {
    warn: () => {},
    error: () => {},
  };

  async function withSuiteHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = await suiteRootTracker.make("case");
    return withEnvAsync(
      {
        OPENCLAW_DEFER_SHELL_ENV_FALLBACK: undefined,
        OPENCLAW_LOAD_SHELL_ENV: undefined,
        OPENCLAW_SHELL_ENV_TIMEOUT_MS: undefined,
      },
      () => fn(home),
    );
  }

  beforeAll(async () => {
    await suiteRootTracker.setup();

    // Default: return an empty plugin list so existing tests that don't need
    // plugin-owned channel schemas keep working unchanged.
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [],
    } satisfies PluginManifestRegistry);
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    resetConfigRuntimeState();
    clearLoadPluginMetadataSnapshotMemo();
    mockMaintainConfigBackups.mockReset();
    mockMaintainConfigBackups.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    closeOpenClawStateDatabaseForTest();
    resetConfigRuntimeState();
    await suiteRootTracker.cleanup();
  });

  function readConfigHealthRow(home: string, configPath: string) {
    const { db } = openOpenClawStateDatabase({ env: { HOME: home } as NodeJS.ProcessEnv });
    const healthDb = getNodeSqliteKysely<ConfigHealthDatabase>(db);
    return executeSqliteQueryTakeFirstSync(
      db,
      healthDb
        .selectFrom("config_health_entries")
        .select(["config_path", "last_known_good_json"])
        .where("config_path", "=", configPath),
    );
  }

  const expectInputOwnerDisplayUnchanged = (input: Record<string, unknown>) => {
    expect((input.commands as Record<string, unknown>).ownerDisplay).toBe("hash");
  };

  const readPersistedCommands = async (configPath: string) => {
    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      commands?: Record<string, unknown>;
    };
    return persisted.commands;
  };

  const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`expected ${label} to be a record`);
    }
    return value as Record<string, unknown>;
  };

  const requireArray = (value: unknown, label: string): unknown[] => {
    if (!Array.isArray(value)) {
      throw new Error(`expected ${label} to be an array`);
    }
    return value;
  };

  const expectInstallRecord = (
    record: unknown,
    expected: { source: string; spec: string; installPath: string },
  ) => {
    const actual = requireRecord(record, "plugin install record");
    expect(actual.source).toBe(expected.source);
    expect(actual.spec).toBe(expected.spec);
    expect(actual.installPath).toBe(expected.installPath);
  };

  const expectConfigWriteRejected = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      expect(requireRecord(error, "config write rejection").code).toBe("CONFIG_WRITE_REJECTED");
      return;
    }
    throw new Error("expected config write rejection");
  };

  const expectPersistedHashResult = (result: unknown) => {
    const persistedHash = requireRecord(result, "config write result").persistedHash;
    expect(typeof persistedHash).toBe("string");
    expect(persistedHash).not.toBe("");
  };

  const createFastConfigIO = (home: string) =>
    createConfigIO({
      env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      homedir: () => home,
      logger: silentLogger,
    });

  it("writes health state to SQLite through public config reads", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const healthPath = path.join(home, ".openclaw", "logs", "config-health.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local" } }, null, 2)}\n`,
        "utf-8",
      );
      const warn = vi.fn();
      const io = createConfigIO({
        configPath,
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn, error: vi.fn() },
      });

      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.exists).toBe(true);
      expect(io.loadConfig().gateway).toEqual({ mode: "local" });
      await expect(fs.stat(healthPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(readConfigHealthRow(home, configPath)).toMatchObject({
        config_path: configPath,
        last_known_good_json: expect.any(String),
      });
      expect(warn.mock.calls.flat()).not.toContainEqual(
        expect.stringContaining("Config health-state write failed"),
      );
    });
  });

  it("refuses direct config writes in Nix mode without changing the file", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const initialRaw = `${JSON.stringify({ gateway: { mode: "local" } }, null, 2)}\n`;
      await fs.writeFile(configPath, initialRaw, "utf-8");
      const io = createConfigIO({
        configPath,
        env: {
          OPENCLAW_NIX_MODE: "1",
          OPENCLAW_TEST_FAST: "1",
        } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });

      await expect(io.writeConfigFile({ gateway: { mode: "local", port: 19001 } })).rejects.toThrow(
        "Agent-first Nix setup: https://github.com/openclaw/nix-openclaw#quick-start",
      );

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
    });
  });

  it("loads shipped plugin install config records without mutating config or plugin index", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const pluginDir = path.join(home, ".openclaw", "plugins", "demo");
      const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
      const source = path.join(pluginDir, "index.ts");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(source, "export function register() {}\n", "utf-8");
      await fs.writeFile(
        manifestPath,
        `${JSON.stringify({ id: "demo", configSchema: { type: "object" } }, null, 2)}\n`,
        "utf-8",
      );
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            plugins: {
              entries: { demo: { enabled: true } },
              installs: {
                demo: {
                  source: "npm",
                  spec: "demo@1.0.0",
                  installPath: pluginDir,
                },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      mockLoadPluginManifestRegistry.mockReturnValue({
        diagnostics: [],
        plugins: [
          {
            id: "demo",
            origin: "global",
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            rootDir: pluginDir,
            source,
            manifestPath,
            configSchema: {
              type: "object",
            },
          },
        ],
      } satisfies PluginManifestRegistry);

      const io = createFastConfigIO(home);
      try {
        const initialRaw = await fs.readFile(configPath, "utf-8");
        const cfg = io.loadConfig();

        expectInstallRecord(cfg.plugins?.installs?.demo, {
          source: "npm",
          spec: "demo@1.0.0",
          installPath: pluginDir,
        });
        const snapshot = await io.readConfigFileSnapshot();
        expectInstallRecord(snapshot.sourceConfig.plugins?.installs?.demo, {
          source: "npm",
          spec: "demo@1.0.0",
          installPath: pluginDir,
        });
        expectInstallRecord(snapshot.runtimeConfig.plugins?.installs?.demo, {
          source: "npm",
          spec: "demo@1.0.0",
          installPath: pluginDir,
        });
        await expect(
          readPersistedInstalledPluginIndex({
            stateDir: path.join(home, ".openclaw"),
          }),
        ).resolves.toBeNull();
        await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
      } finally {
        mockLoadPluginManifestRegistry.mockReturnValue({
          diagnostics: [],
          plugins: [],
        } satisfies PluginManifestRegistry);
      }
    });
  });

  it("retains included shipped plugin install records in write snapshots", async () => {
    await withSuiteHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const pluginsPath = path.join(configDir, "plugins.json5");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ plugins: { $include: "./plugins.json5" } }, null, 2)}\n`,
        "utf-8",
      );
      await fs.writeFile(
        pluginsPath,
        `${JSON.stringify(
          {
            installs: {
              demo: {
                source: "npm",
                spec: "demo@1.0.0",
                installPath: "/tmp/demo",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const prepared = await createFastConfigIO(home).readConfigFileSnapshotForWrite();

      expect(prepared.snapshot.valid).toBe(true);
      expect(prepared.snapshot.parsed).toEqual({
        plugins: { $include: "./plugins.json5" },
      });
      expectInstallRecord(prepared.snapshot.sourceConfig.plugins?.installs?.demo, {
        source: "npm",
        spec: "demo@1.0.0",
        installPath: "/tmp/demo",
      });
    });
  });

  it("migrates shipped plugin install config records into the plugin index during explicit writes", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const pluginDir = path.join(home, ".openclaw", "plugins", "demo");
      const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
      const source = path.join(pluginDir, "index.ts");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(source, "export function register() {}\n", "utf-8");
      await fs.writeFile(
        manifestPath,
        `${JSON.stringify({ id: "demo", configSchema: { type: "object" } }, null, 2)}\n`,
        "utf-8",
      );
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            plugins: {
              entries: { demo: { enabled: true } },
              installs: {
                demo: {
                  source: "npm",
                  spec: "demo@1.0.0",
                  installPath: pluginDir,
                },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      mockLoadPluginManifestRegistry.mockReturnValue({
        diagnostics: [],
        plugins: [
          {
            id: "demo",
            origin: "global",
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            rootDir: pluginDir,
            source,
            manifestPath,
            configSchema: {
              type: "object",
            },
          },
        ],
      } satisfies PluginManifestRegistry);

      const io = createFastConfigIO(home);
      try {
        await io.writeConfigFile({
          plugins: {
            entries: { demo: { enabled: true } },
          },
        });

        const index = requireRecord(
          await readPersistedInstalledPluginIndex({
            stateDir: path.join(home, ".openclaw"),
          }),
          "persisted plugin index",
        );
        expectInstallRecord(requireRecord(index.installRecords, "install records").demo, {
          source: "npm",
          spec: "demo@1.0.0",
          installPath: pluginDir,
        });
        const plugins = requireArray(index.plugins, "plugin index plugins");
        expect(plugins).toHaveLength(1);
        const indexedPlugin = requireRecord(plugins[0], "indexed plugin");
        expect(indexedPlugin.pluginId).toBe("demo");
        expect(indexedPlugin.installRecordHash).toMatch(/^[a-f0-9]{64}$/u);
        const persistedConfig = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
          plugins?: { installs?: unknown };
        };
        expect(persistedConfig.plugins?.installs).toBeUndefined();
      } finally {
        mockLoadPluginManifestRegistry.mockReturnValue({
          diagnostics: [],
          plugins: [],
        } satisfies PluginManifestRegistry);
      }
    });
  });

  it("migrates shipped plugin install config records during explicit writes even when the manifest is missing", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const pluginDir = path.join(home, ".openclaw", "plugins", "missing");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            plugins: {
              entries: { missing: { enabled: true } },
              installs: {
                missing: {
                  source: "npm",
                  spec: "missing-plugin@1.0.0",
                  installPath: pluginDir,
                },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const io = createFastConfigIO(home);
      await io.writeConfigFile({
        plugins: {
          entries: { missing: { enabled: true } },
        },
      });

      const index = requireRecord(
        await readPersistedInstalledPluginIndex({
          stateDir: path.join(home, ".openclaw"),
        }),
        "persisted plugin index",
      );
      expectInstallRecord(requireRecord(index.installRecords, "install records").missing, {
        source: "npm",
        spec: "missing-plugin@1.0.0",
        installPath: pluginDir,
      });
      expect(index.plugins).toEqual([]);
      const persistedConfig = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        plugins?: { installs?: unknown };
      };
      expect(persistedConfig.plugins?.installs).toBeUndefined();
    });
  });

  it("keeps shipped plugin install config records when index migration fails", async () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [],
    } satisfies PluginManifestRegistry);
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const unwritableStatePath = path.join(home, ".openclaw");
      const pluginDir = path.join(unwritableStatePath, "plugins", "demo");
      const original = {
        plugins: {
          entries: { demo: { enabled: true } },
          installs: {
            demo: {
              source: "npm",
              spec: "demo@1.0.0",
              installPath: pluginDir,
            },
          },
        },
      };
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`, "utf-8");
      const warn = vi.fn();
      const io = createConfigIO({
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn, error: vi.fn() },
      });
      await fs.writeFile(path.join(unwritableStatePath, "state"), "not a directory", "utf-8");

      const loadedConfig = io.loadConfig();
      expectInstallRecord(loadedConfig.plugins?.installs?.demo, {
        source: "npm",
        spec: "demo@1.0.0",
        installPath: pluginDir,
      });
      expect(warn.mock.calls).toContainEqual([
        "Config warnings:\n- plugins.entries.demo: plugin not found: demo (stale config entry ignored; remove it from plugins config)",
      ]);

      await expect(io.writeConfigFile({ gateway: { mode: "local" } })).rejects.toThrow(
        "Config write blocked: shipped plugins.installs records",
      );

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as typeof original;
      expectInstallRecord(persisted.plugins.installs.demo, {
        source: "npm",
        spec: "demo@1.0.0",
        installPath: pluginDir,
      });
    });
  });

  it("keeps shipped plugin install index migration when config write fails", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const pluginDir = path.join(home, ".openclaw", "plugins", "demo");
      const original = {
        plugins: {
          entries: { demo: { enabled: true } },
          installs: {
            demo: {
              source: "npm",
              spec: "demo@1.0.0",
              installPath: pluginDir,
            },
          },
        },
      };
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`, "utf-8");
      mockMaintainConfigBackups.mockRejectedValueOnce(new Error("backup failed"));

      const io = createFastConfigIO(home);
      await expect(io.writeConfigFile({ gateway: { mode: "local" } })).rejects.toThrow(
        "backup failed",
      );

      const persistedConfig = JSON.parse(await fs.readFile(configPath, "utf-8")) as typeof original;
      expectInstallRecord(persistedConfig.plugins.installs.demo, {
        source: "npm",
        spec: "demo@1.0.0",
        installPath: pluginDir,
      });
      const persistedIndex = await readPersistedInstalledPluginIndex({
        stateDir: path.join(home, ".openclaw"),
      });
      expectInstallRecord(persistedIndex?.installRecords.demo, {
        source: "npm",
        spec: "demo@1.0.0",
        installPath: pluginDir,
      });
    });
  });

  const writeGatewayPortAndReadConfig = async (home: string, configPath: string) => {
    const io = createFastConfigIO(home);

    await io.writeConfigFile({
      gateway: { mode: "local", port: 18789 },
    });

    return JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      $schema?: string;
      gateway?: { mode?: string; port?: number };
    };
  };

  it.runIf(process.platform !== "win32")(
    "tightens world-writable state dir when writing the default config",
    async () => {
      await withSuiteHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        await fs.mkdir(stateDir, { recursive: true, mode: 0o777 });
        await fs.chmod(stateDir, 0o777);

        const io = createConfigIO({
          env: {} as NodeJS.ProcessEnv,
          homedir: () => home,
          logger: silentLogger,
        });

        await io.writeConfigFile({ gateway: { mode: "local" } });

        const stat = await fs.stat(stateDir);
        expect(stat.mode & 0o777).toBe(0o700);
      });
    },
  );

  it("keeps writes inside an OPENCLAW_STATE_DIR override even when the real home config exists", async () => {
    await withSuiteHome(async (home) => {
      const liveConfigPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(liveConfigPath), { recursive: true });
      await fs.writeFile(
        liveConfigPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
        "utf-8",
      );

      const overrideDir = path.join(home, "isolated-state");
      const env = { OPENCLAW_STATE_DIR: overrideDir } as NodeJS.ProcessEnv;
      const io = createConfigIO({
        env,
        homedir: () => home,
        logger: silentLogger,
      });

      expect(io.configPath).toBe(path.join(overrideDir, "openclaw.json"));

      await io.writeConfigFile({
        agents: { list: [{ id: "main", default: true }] },
        gateway: { mode: "local" },
        session: { mainKey: "main", store: path.join(overrideDir, "sessions.json") },
      });

      const livePersisted = JSON.parse(await fs.readFile(liveConfigPath, "utf-8")) as {
        gateway?: { mode?: unknown; port?: unknown };
      };
      expect(livePersisted.gateway).toEqual({ mode: "local", port: 18789 });

      const overridePersisted = JSON.parse(
        await fs.readFile(path.join(overrideDir, "openclaw.json"), "utf-8"),
      ) as {
        session?: { store?: unknown };
      };
      expect(overridePersisted.session?.store).toBe(path.join(overrideDir, "sessions.json"));
    });
  });

  it("does not mutate caller config when unsetPaths is applied on first write", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });

      const input: Record<string, unknown> = {
        gateway: { mode: "local" },
        commands: { ownerDisplay: "hash" },
      };

      await io.writeConfigFile(input, { unsetPaths: [["commands", "ownerDisplay"]] });

      expect(input).toEqual({
        gateway: { mode: "local" },
        commands: { ownerDisplay: "hash" },
      });
      expectInputOwnerDisplayUnchanged(input);
      expect((await readPersistedCommands(configPath)) ?? {}).not.toHaveProperty("ownerDisplay");
    });
  });

  it("does not log an overwrite audit entry when creating config for the first time", async () => {
    await withSuiteHome(async (home) => {
      const warn = vi.fn();
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: {
          warn,
          error: vi.fn(),
        },
      });

      await io.writeConfigFile({
        gateway: { mode: "local" },
      });

      const overwriteLogs = warn.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("Config overwrite:"),
      );
      expect(overwriteLogs).toHaveLength(0);
    });
  });

  it("does not print overwrite audit output by default when updating config", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
        "utf-8",
      );
      const warn = vi.fn();
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: {
          warn,
          error: vi.fn(),
        },
      });

      await io.writeConfigFile({
        gateway: { mode: "local", port: 18790 },
      });

      const overwriteLogs = warn.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("Config overwrite:"),
      );
      expect(overwriteLogs).toHaveLength(0);
    });
  });

  it("does not print benign missing-meta write anomalies by default", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
        "utf-8",
      );
      const warn = vi.fn();
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: {
          warn,
          error: vi.fn(),
        },
      });

      await io.writeConfigFile({
        gateway: { mode: "local", port: 18790 },
      });

      const anomalyLogs = warn.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("Config write anomaly:"),
      );
      expect(anomalyLogs).toHaveLength(0);
    });
  });

  it("prints missing-meta write anomalies when anomaly logging is requested", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
        "utf-8",
      );
      const warn = vi.fn();
      const io = createConfigIO({
        env: {
          OPENCLAW_CONFIG_WRITE_ANOMALY_LOG: "1",
        } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: {
          warn,
          error: vi.fn(),
        },
      });

      await io.writeConfigFile({
        gateway: { mode: "local", port: 18790 },
      });

      expect(warn.mock.calls).toContainEqual([expect.stringContaining("Config write anomaly:")]);
      expect(warn.mock.calls).toContainEqual([
        expect.stringContaining("missing-meta-before-write"),
      ]);
    });
  });

  it("suppresses overwrite audit output when skipOutputLogs is set", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
        "utf-8",
      );
      const warn = vi.fn();
      const io = createConfigIO({
        env: {
          VITEST: "true",
          OPENCLAW_TEST_CONFIG_OVERWRITE_LOG: "1",
        } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: {
          warn,
          error: vi.fn(),
        },
      });

      await io.writeConfigFile(
        {
          gateway: { mode: "local", port: 18790 },
        },
        { skipOutputLogs: true },
      );

      const overwriteLogs = warn.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("Config overwrite:"),
      );
      expect(overwriteLogs).toHaveLength(0);
    });
  });

  it("preserves root $schema during partial writes", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            $schema: "https://openclaw.ai/config.json",
            gateway: { mode: "local" },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const persisted = await writeGatewayPortAndReadConfig(home, configPath);
      expect(persisted.$schema).toBe("https://openclaw.ai/config.json");
      expect(persisted.gateway).toEqual({ mode: "local", port: 18789 });
    });
  });

  it("recovers configs polluted by a leading status line", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const cleanConfig = {
        gateway: { mode: "local" },
        agents: { list: [{ id: "main", default: true }, { id: "discord-dm" }] },
      } satisfies ConfigFileSnapshot["config"];
      const cleanRaw = `${JSON.stringify(cleanConfig, null, 2)}\n`;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `Found and updated: False\n${cleanRaw}`, "utf-8");
      const warn = vi.fn();
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn, error: vi.fn() },
      });

      const initialSnapshot = await io.readConfigFileSnapshot();
      expect(initialSnapshot.valid).toBe(false);

      await expect(io.recoverConfigFromJsonRootSuffix(initialSnapshot)).resolves.toBe(true);
      const recoveredSnapshot = await io.readConfigFileSnapshot();

      expect(recoveredSnapshot.valid).toBe(true);
      expect(recoveredSnapshot.config.gateway?.mode).toBe("local");
      expect(recoveredSnapshot.config.agents?.list?.map((entry) => entry.id)).toEqual([
        "main",
        "discord-dm",
      ]);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(cleanRaw);
      const entries = await fs.readdir(path.dirname(configPath));
      const clobberedEntries = entries.filter((entry) => entry.includes(".clobbered."));
      expect(clobberedEntries).toHaveLength(1);
      expect(warn.mock.calls).toEqual([
        [
          `Config auto-stripped non-JSON prefix: ${configPath} (original saved as ${path.join(
            path.dirname(configPath),
            clobberedEntries[0] ?? "",
          )})`,
        ],
      ]);
    });
  });

  it("rotates repeated prefix-recovery clobber snapshots for doctor-style repair loops", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const cleanConfig = {
        gateway: { mode: "local" },
        agents: { list: [{ id: "main", default: true }] },
      } satisfies ConfigFileSnapshot["config"];
      const cleanRaw = `${JSON.stringify(cleanConfig, null, 2)}\n`;
      const warn = vi.fn();
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn, error: vi.fn() },
      });

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      for (let index = 0; index < CONFIG_CLOBBER_SNAPSHOT_LIMIT + 4; index++) {
        await fs.writeFile(configPath, `Found and updated: False ${index}\n${cleanRaw}`, "utf-8");
        const snapshot = await io.readConfigFileSnapshot();
        expect(snapshot.valid).toBe(false);
        await expect(io.recoverConfigFromJsonRootSuffix(snapshot)).resolves.toBe(true);
      }

      const entries = await fs.readdir(path.dirname(configPath));
      const clobbered = entries.filter((entry) => entry.includes(".clobbered."));
      expect(clobbered).toHaveLength(CONFIG_CLOBBER_SNAPSHOT_LIMIT);
      const clobberedContents = await Promise.all(
        clobbered.map((entry) => fs.readFile(path.join(path.dirname(configPath), entry), "utf-8")),
      );
      expect(clobberedContents).not.toContain(`Found and updated: False 0\n${cleanRaw}`);
      expect(clobberedContents).toContain(
        `Found and updated: False ${CONFIG_CLOBBER_SNAPSHOT_LIMIT + 3}\n${cleanRaw}`,
      );
      const capWarnings = warn.mock.calls.filter(
        ([message]) =>
          typeof message === "string" && message.includes("Config clobber snapshot cap reached"),
      );
      expect(capWarnings).toHaveLength(1);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(cleanRaw);
    });
  });

  it("rejects destructive internal writes before replacing the config", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        gateway: { mode: "local" },
        channels: { telegram: { enabled: true, dmPolicy: "pairing" } },
        agents: { list: [{ id: "main", default: true, workspace: "/tmp/openclaw-main" }] },
        tools: { profile: "messaging" },
        commands: { ownerDisplay: "hash" },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const warn = vi.fn();
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn, error: vi.fn() },
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await expectConfigWriteRejected(
        io.writeConfigFile(
          { update: { channel: "beta" } },
          {
            baseSnapshot,
          },
        ),
      );

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
      const entries = await fs.readdir(path.dirname(configPath));
      const rejectedEntries = entries.filter((entry) => entry.includes(".rejected."));
      expect(rejectedEntries).toHaveLength(1);
      expect(warn.mock.calls).toEqual([
        [
          `Config write rejected: ${configPath} (gateway-mode-removed). Rejected payload saved to ${path.join(
            path.dirname(configPath),
            rejectedEntries[0] ?? "",
          )}.`,
        ],
      ]);
    });
  });

  it("does not preflight runtime secrets before rejecting blocked root writes", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.4.30" },
        gateway: { mode: "local", port: 18789 },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        configPath,
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;
      let preflightCalls = 0;

      await expectConfigWriteRejected(
        io.writeConfigFile(
          { update: { channel: "beta" } },
          {
            baseSnapshot,
            preCommitRuntimePreflight: async () => {
              preflightCalls += 1;
              throw new Error("should not preflight rejected writes");
            },
          },
        ),
      );

      expect(preflightCalls).toBe(0);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("allows intentional size-drop writes without disabling gateway-mode protection", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
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
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

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
    });
  });

  it("rejects writes that remove paths the trusted migration did not authorize", async () => {
    // Regression: a transaction-level size-drop opt-in must not be carried by
    // a later repair that removes paths the trusted migration did not
    // authorize. The path-based authorization enforces the exact removal set
    // the migration itself produced.
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      // The original config is intentionally much larger than the trusted
      // migration output so the size-drop signal is unambiguous. The trusted
      // migration removed the legacy `channels.telegram` block; an untrusted
      // repair that also strips `gateway.mode` must be rejected.
      const original = {
        meta: { lastTouchedVersion: "2026.4.30" },
        gateway: { mode: "local" },
        channels: {
          telegram: {
            enabled: true,
            allowFrom: Array.from({ length: 4000 }, (_, index) => `telegram:${index}`),
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      // The trusted migration removed the legacy `channels.telegram` block.
      // The writer authorizes the path diff the migration produced.
      const trustedMigrationOutput = {
        meta: { lastTouchedVersion: "2026.4.30" },
        gateway: { mode: "local" },
      } as const;
      const authorizedDestructivePaths: Array<readonly (string | number)[]> = [["channels"]];

      // First write at the authorized set is allowed: matches what the migration produced.
      const acceptedWrite = await io.writeConfigFile(trustedMigrationOutput, {
        allowConfigSizeDrop: true,
        authorizedDestructivePaths,
        lastTouchedVersionOverride: "2026.4.30",
        baseSnapshot,
      });
      expect(acceptedWrite.persistedConfig.gateway).toEqual({ mode: "local" });
      const acceptedSnapshot = await io.readConfigFileSnapshot();

      // A second write that drops ADDITIONAL paths must be rejected, even
      // though `allowConfigSizeDrop: true` is still set. The untrusted
      // repair tries to also strip `gateway.mode`, which is NOT in the
      // authorized set.
      const untrustedRepairOutput = {
        meta: { lastTouchedVersion: "2026.4.30" },
      };
      await expectConfigWriteRejected(
        io.writeConfigFile(untrustedRepairOutput, {
          allowConfigSizeDrop: true,
          authorizedDestructivePaths,
          lastTouchedVersionOverride: "2026.4.30",
          baseSnapshot: acceptedSnapshot,
        }),
      );
    });
  });

  it("emits 'unauthorized-destructive-paths' as the rejection reason", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.4.30" },
        gateway: { mode: "local" },
        channels: {
          telegram: {
            enabled: true,
            allowFrom: Array.from({ length: 4000 }, (_, index) => `telegram:${index}`),
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      const trustedMigrationOutput = {
        meta: { lastTouchedVersion: "2026.4.30" },
        gateway: { mode: "local" },
      } as const;
      const authorizedDestructivePaths: Array<readonly (string | number)[]> = [["channels"]];

      // Seed the trusted migration output, then read the snapshot back.
      await io.writeConfigFile(trustedMigrationOutput, {
        allowConfigSizeDrop: true,
        authorizedDestructivePaths,
        lastTouchedVersionOverride: "2026.4.30",
        baseSnapshot,
      });
      const acceptedSnapshot = await io.readConfigFileSnapshot();

      await expect(
        io
          .writeConfigFile(
            { meta: { lastTouchedVersion: "2026.4.30" } },
            {
              allowConfigSizeDrop: true,
              authorizedDestructivePaths,
              lastTouchedVersionOverride: "2026.4.30",
              baseSnapshot: acceptedSnapshot,
            },
          )
          .catch((err: { reasons?: string[] }) => err.reasons),
      ).resolves.toEqual(
        expect.arrayContaining([expect.stringMatching(/^unauthorized-destructive-paths:/)]),
      );
    });
  });

  it("rejects writes whose primitive value shrinks without removing a path (round-5 destructive)", async () => {
    // Round-5 [P1]: the authorized set covers path REMOVALS, but a primitive
    // can shrink in place (long string → short string, integer → null) without
    // the path itself disappearing. The destructive-diff model must catch this.
    //
    // Setup: write a config that has BOTH a long primitive (`gateway.mode`)
    // and a long array (`heartbeat.endpoints`). Authorize ONLY the array
    // removal. The primitive shrink is not authorized and must be rejected.
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const longMode = "x".repeat(4000);
      const original = {
        meta: { lastTouchedVersion: "2026.4.30" },
        gateway: { mode: longMode },
        heartbeat: { endpoints: Array.from({ length: 100 }, (_, i) => `ep-${i}`) },
      } as Record<string, unknown> as ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } as ConfigFileSnapshot;

      // Trusted migration authorized ONLY the `heartbeat` removal. The
      // primitive shrink on `gateway.mode` is NOT in the authorized set.
      const authorizedDestructivePaths: Array<readonly (string | number)[]> = [["heartbeat"]];

      let caught: unknown = undefined;
      try {
        await io.writeConfigFile(
          {
            meta: { lastTouchedVersion: "2026.4.30" },
            // gateway.mode shrunk to a short string (destructive), heartbeat
            // was removed (authorized).
            gateway: { mode: "local" },
          },
          {
            allowConfigSizeDrop: true,
            authorizedDestructivePaths,
            lastTouchedVersionOverride: "2026.4.30",
            baseSnapshot,
          },
        );
      } catch (err) {
        caught = err;
      }
      expect((caught as { code?: string } | undefined)?.code).toBe("CONFIG_WRITE_REJECTED");
    });
  });

  it("auto-unions writer-managed plugins.installs into the authorized destructive set (round-5 writer-managed)", async () => {
    // Round-5 [P1]: the writer's own canonical payload-preparation removes
    // `plugins.installs` on every commit. Without auto-union, the writer
    // would self-reject every config write that doesn't enumerate
    // `plugins.installs` in the authorized set.
    //
    // We trigger this by writing a small `heartbeat` block (which is the
    // sole authorized destructive change) while the on-disk config has a
    // long `plugins.installs` record. The size drop is unambiguous, the
    // size-drop opt-in is on, and the only thing the writer needs to also
    // remove is `plugins.installs` (writer-managed, auto-unioned).
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.4.30" },
        heartbeat: { interval: 30 },
        plugins: {
          installs: {
            "telegram@1.0.0": { version: "1.0.0", long: "x".repeat(4000) },
            "discord@2.0.0": { version: "2.0.0", long: "y".repeat(4000) },
          },
        },
      } as Record<string, unknown> as ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } as ConfigFileSnapshot;

      // Authorize ONLY the heartbeat removal. The writer will also strip
      // `plugins.installs`; the write must succeed because that path is
      // writer-managed and auto-unioned.
      const authorizedDestructivePaths: Array<readonly (string | number)[]> = [["heartbeat"]];

      const result = await io.writeConfigFile(
        { meta: { lastTouchedVersion: "2026.4.30" } },
        {
          allowConfigSizeDrop: true,
          authorizedDestructivePaths,
          lastTouchedVersionOverride: "2026.4.30",
          baseSnapshot,
        },
      );
      expect(result.persistedConfig.meta).toBeDefined();
    });
  });

  it("rejects a whole-plugins removal when a sibling plugin entry also exists (round-7 [P1] sibling)", async () => {
    // Round-7 [P1]: when the on-disk config has BOTH `plugins.installs`
    // (writer-managed) and `plugins.entries` (owner-managed), the writer's
    // own unset-paths transform must NOT promote its destructive
    // authorization to the entire `plugins` subtree. If the next config
    // accidentally removes the entire `plugins` object, the writer must
    // still reject the write because the parent `plugins` removal is not
    // covered by the writer-managed `["plugins", "installs"]` child.
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.4.30" },
        heartbeat: { interval: 30 },
        plugins: {
          installs: {
            "telegram@1.0.0": { version: "1.0.0", long: "x".repeat(4000) },
          },
          entries: {
            telegram: { enabled: true },
          },
        },
      } as Record<string, unknown> as ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        runtimeConfig: original,
        config: original,
        valid: true,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } as ConfigFileSnapshot;

      // Authorize ONLY an unrelated path. The whole `plugins` object
      // removal is NOT in the writer-managed set (which is
      // `["plugins","installs"]` only because `entries` is a sibling).
      const authorizedDestructivePaths: Array<readonly (string | number)[]> = [["heartbeat"]];

      await expectConfigWriteRejected(
        io.writeConfigFile(
          { meta: { lastTouchedVersion: "2026.4.30" } },
          {
            allowConfigSizeDrop: true,
            authorizedDestructivePaths,
            lastTouchedVersionOverride: "2026.4.30",
            baseSnapshot,
          },
        ),
      );
    });
  });

  it("accepts the installs-only empty-parent prune (round-7 [P1] prune)", async () => {
    // Round-7 [P1]: when `plugins.installs` is the ONLY child of
    // `plugins`, the writer's unset transform prunes the empty parent —
    // the destructive diff is `["plugins"]`, which directional coverage
    // must approve under the writer-managed authorization computed
    // dynamically from the snapshot.
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.4.30" },
        heartbeat: { interval: 30 },
        plugins: {
          installs: {
            "telegram@1.0.0": { version: "1.0.0", long: "x".repeat(4000) },
          },
        },
      } as Record<string, unknown> as ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        runtimeConfig: original,
        config: original,
        valid: true,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } as ConfigFileSnapshot;

      // Authorize ONLY the heartbeat removal. The writer also prunes
      // the empty `plugins` parent after removing `plugins.installs`;
      // the dynamic writer-managed authorization must cover that.
      const authorizedDestructivePaths: Array<readonly (string | number)[]> = [["heartbeat"]];

      const result = await io.writeConfigFile(
        { meta: { lastTouchedVersion: "2026.4.30" } },
        {
          allowConfigSizeDrop: true,
          authorizedDestructivePaths,
          lastTouchedVersionOverride: "2026.4.30",
          baseSnapshot,
        },
      );
      expect(result.persistedConfig.meta).toBeDefined();
      const persistedPlugins = (result.persistedConfig as { plugins?: unknown }).plugins;
      expect(persistedPlugins).toBeUndefined();
    });
  });

  it("rejects destructive paths under a top-level key whose literal name is dotted (round-5 collision)", async () => {
    // Round-5 [P2]: a top-level key literally named `"agents.list"` (with a
    // dot inside its name) must NOT cover the nested path `agents.list`
    // (an array of agents). The old dotted-string implementation would
    // have falsely authorized the nested removal.
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.4.30" },
        // Top-level key whose name is literally "agents.list" (no nesting).
        "agents.list": { some: "long string that shrinks on write" },
        // Nested array at `agents.list` (the real agents list).
        agents: {
          list: [
            { id: "alpha", params: { model: "x" } },
            { id: "beta", params: { model: "y" } },
          ],
        },
      } as Record<string, unknown> as ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } as ConfigFileSnapshot;

      // Authorize ONLY the top-level dotted key (literal `"agents.list"`).
      // The destructive removal of the nested `agents.list` array must NOT
      // be covered.
      const authorizedDestructivePaths: Array<readonly (string | number)[]> = [["agents.list"]];

      await expectConfigWriteRejected(
        io.writeConfigFile(
          {
            meta: { lastTouchedVersion: "2026.4.30" },
            // Truncate the nested agents.list to one element. The literal
            // top-level "agents.list" key is preserved (not a path removal).
            agents: { list: [{ id: "alpha", params: { model: "x" } }] },
          },
          {
            allowConfigSizeDrop: true,
            authorizedDestructivePaths,
            lastTouchedVersionOverride: "2026.4.30",
            baseSnapshot,
          },
        ),
      );
    });
  });

  it("does not flag growth or additions as destructive (round-6 [P1-1])", () => {
    // Round-6 [P1-1]: the destructive-delta model must compare serialized
    // costs. New keys, longer strings, larger arrays, and equal-size
    // replacements are NOT destructive changes. The earlier round-5
    // implementation flagged every shape change as destructive, which
    // would have caused real doctor writes to be rejected whenever the
    // wizard metadata or plugin auto-enable block added/updated fields.
    const destructive = new Set<string>();
    const collect = (before: unknown, target: unknown) => {
      destructive.clear();
      collectDestructiveChanges(before, target, [], destructive);
    };

    // Missing → added key: never destructive.
    collect({}, { a: 1 });
    expect(destructive).toEqual(new Set());

    // Short → longer value: never destructive.
    collect({ a: "a" }, { a: "a much longer value" });
    expect(destructive).toEqual(new Set());

    // Equal-size primitive replacement: 4 chars → 4 chars, not destructive.
    // (`true` and `false` have different serialized sizes 4 and 5, so this
    // test stays on equal-length strings to keep the size comparison honest.)
    collect({ name: "abcd" }, { name: "wxyz" });
    expect(destructive).toEqual(new Set());

    // Small array → larger array: never destructive.
    collect({ list: [1] }, { list: [1, 2, 3, 4, 5] });
    expect(destructive).toEqual(new Set());

    // Nested missing → added: never destructive.
    collect({ agent: {} }, { agent: { defaults: { heartbeat: { enabled: true } } } });
    expect(destructive).toEqual(new Set());
  });

  it("rejects parent destruction even when a leaf is authorized (round-6 [P1-2])", async () => {
    // Round-6 [P1-2]: authorization is DIRECTIONAL. An authorized leaf
    // (e.g. `["channels", "telegram"]`) must NOT cover destruction of its
    // parent (`["channels"]`). The earlier round-5 implementation used a
    // symmetric `configPathOverlaps` check that would have accepted this.
    //
    // We authorize the leaf `["channels", "telegram"]` and write a payload
    // that drops the entire `channels` object. The destructive diff emits
    // `["channels"]` (the parent removal); under directional coverage, the
    // authorized leaf does NOT cover the parent, so the write is rejected.
    //
    // We deliberately use a `channels` path (not `plugins.installs`) because
    // the writer auto-unions the parent of every writer-managed path —
    // `["plugins"]` would be covered by that auto-union and the rejection
    // would never fire.
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.4.30" },
        channels: {
          telegram: {
            enabled: true,
            allowFrom: Array.from({ length: 4000 }, (_, index) => `telegram:${index}`),
          },
        },
      } as Record<string, unknown> as ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } as ConfigFileSnapshot;

      const authorizedDestructivePaths: Array<readonly (string | number)[]> = [
        ["channels", "telegram"],
      ];

      let caught: unknown = undefined;
      try {
        await io.writeConfigFile(
          { meta: { lastTouchedVersion: "2026.4.30" } },
          {
            allowConfigSizeDrop: true,
            authorizedDestructivePaths,
            lastTouchedVersionOverride: "2026.4.30",
            baseSnapshot,
          },
        );
      } catch (err) {
        caught = err;
      }
      expect((caught as { code?: string } | undefined)?.code).toBe("CONFIG_WRITE_REJECTED");
      // The destructively emitted path is `["channels"]` (the parent),
      // which is what must remain unauthorized. The reason string
      // joins JSON-stringified paths, so look for the encoded form.
      const reasons = (caught as { reasons?: string[] } | undefined)?.reasons ?? [];
      expect(reasons.some((r) => r.includes(configPathKey(["channels"])))).toBe(true);
    });
  });

  it("supports the full doctor write chain with a real legacy migration (round-6 [P1-3] / round-7 strict)", async () => {
    // Round-6 [P1-3] / round-7 strict: the complete doctor write path —
    // a real trusted legacy migration → applyLegacyCompatibilityStep →
    // applyWizardMetadata → real replaceConfigFile — must succeed
    // end-to-end. The earlier round-5 implementation would have rejected
    // the write because the wizard metadata + plugin auto-enable blocks
    // added/updated fields that the destructive-delta model mistakenly
    // classified as destructive.
    //
    // The previous version of this test asserted `authorizedDestructivePaths`
    // was *optionally* present and never exercised the size-drop opt-in,
    // which meant the contract was only proven when doctor happened to
    // produce an empty `removedPaths` (the inverse of the trust boundary).
    //
    // This version uses a fixture that DEFINITELY produces a trusted
    // destructive migration: `session.parentForkMaxTokens` is a core-level
    // legacy key that the runtime migration removes entirely (no
    // replacement). The diff therefore records
    // `["session","parentForkMaxTokens"]` in `removedPaths`, and the
    // trust contract requires the writer to accept that removal AND any
    // non-destructive growth (wizard metadata added by the wizard owner)
    // without rejecting either.
    //
    // The test exercises the real `applyLegacyCompatibilityStep` (the
    // trusted migration owner) directly, then applies `applyWizardMetadata`
    // (the real wizard owner path) before calling the real
    // `replaceConfigFile` with the recovered `authorizedDestructivePaths`
    // and `allowConfigSizeDrop` flags. The chain fails closed otherwise:
    // any untrusted shrink in this transaction would be rejected.
    await withSuiteHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      await fs.mkdir(configDir, { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.4.30" },
        session: {
          parentForkMaxTokens: 4096,
        },
      } as Record<string, unknown> as ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");

      // Run the real `applyLegacyCompatibilityStep` against the on-disk
      // config. The `session.parentForkMaxTokens` legacy key triggers
      // the runtime migration that removes it. The diff is destructive
      // (a legacy key is removed), so the returned `removedPaths` MUST
      // be non-empty.
      const { applyLegacyCompatibilityStep } =
        await import("../commands/doctor/shared/config-flow-steps.js");
      const { findLegacyConfigIssues } = await import("../config/legacy.js");
      const parsedForMigration = structuredClone(original) as Record<string, unknown>;
      const legacyIssues = findLegacyConfigIssues(parsedForMigration);
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: parsedForMigration,
        sourceConfig: original,
        resolved: original,
        runtimeConfig: original,
        config: original,
        valid: true,
        issues: [],
        warnings: [],
        legacyIssues,
      } as ConfigFileSnapshot;
      const legacyStep = applyLegacyCompatibilityStep({
        snapshot: baseSnapshot,
        state: {
          cfg: original,
          candidate: original,
          pendingChanges: false,
          fixHints: [],
        },
        shouldRepair: true,
        doctorFixCommand: "openclaw doctor --fix",
      });

      // The trusted migration must have produced a destructive diff. A
      // missing `removedPaths` entry here would mean the legacy
      // migration silently no-oped and the test is no longer exercising
      // the chain it's meant to guard.
      expect(legacyStep.removedPaths.length).toBeGreaterThan(0);
      expect(legacyStep.removedPaths).toContainEqual(["session", "parentForkMaxTokens"]);
      // applyLegacyCompatibilityStep returns the migrated candidate in
      // `state.cfg` when the rule applies. We assert that the legacy
      // key is gone from the migrated config (the migration actually
      // fired) before handing it to the writer.
      const migratedCandidate = legacyStep.state.cfg as Record<string, unknown>;
      expect(
        (migratedCandidate.session as Record<string, unknown> | undefined)?.parentForkMaxTokens,
      ).toBeUndefined();

      // The size-drop opt-in is granted only when the trusted migration
      // actually changed the candidate (per the round-5 contract). The
      // chain we're proving must assume this opt-in is set, otherwise
      // the writer is allowed to refuse the write outright.
      const authorizedDestructivePaths = legacyStep.removedPaths;

      // Apply wizard metadata (the real wizard-owner path) before the
      // real `replaceConfigFile`. This adds a `wizard` block to the
      // candidate; the writer must accept that growth (round-6 [P1-1])
      // AND the destructive legacy migration listed above.
      const { applyWizardMetadata } = await import("../commands/onboard-helpers.js");
      const nextConfig = applyWizardMetadata(
        migratedCandidate as Parameters<typeof applyWizardMetadata>[0],
        { command: "openclaw doctor --fix", mode: "local" },
      );

      const writeOptions = {
        allowConfigSizeDrop: true,
        authorizedDestructivePaths,
      };

      const writeResult = await replaceConfigFile({
        nextConfig: nextConfig as OpenClawConfig,
        writeOptions: {
          ...writeOptions,
          ownedConfigPathForWrite: configPath,
        },
      });
      expect(writeResult.snapshot).toBeDefined();
      expect(writeResult.nextConfig).toBeDefined();
      expect(typeof writeResult.persistedHash).toBe("string");

      // The returned `nextConfig` is the persisted config. The
      // round-7 contract requires the trusted migration to have
      // removed `session.parentForkMaxTokens` and the wizard block
      // to be present in the same write.
      const persistedNext = writeResult.nextConfig as Record<string, unknown>;
      const persistedNextSession = persistedNext.session as Record<string, unknown> | undefined;
      expect(persistedNextSession?.parentForkMaxTokens).toBeUndefined();
      expect((persistedNext.wizard as Record<string, unknown>).lastRunCommand).toBe(
        "openclaw doctor --fix",
      );

      // Verify the on-disk file matches the persisted config. This
      // proves the chain is faithful to the round-7 contract:
      // doctor-mandated destructive changes AND wizard-owner growth
      // land together in the same write.
      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<
        string,
        unknown
      >;
      const persistedSession = persisted.session as Record<string, unknown> | undefined;
      expect(persistedSession?.parentForkMaxTokens).toBeUndefined();
      expect((persisted.wizard as Record<string, unknown>).lastRunCommand).toBe(
        "openclaw doctor --fix",
      );
    });
  });

  it("rejects trusted removal combined with an untrusted primitive shrink (round-6 [P1-4])", async () => {
    // Round-6 [P1-4]: when a trusted migration authorizes a removal
    // (e.g. legacy `channels.telegram` block), any untrusted shrink in
    // the same write must still be rejected. The earlier round-5
    // implementation only checked the destructive paths after writing,
    // so a permissive `allowConfigSizeDrop` flag was enough; here we
    // also pass the authoritative `authorizedDestructivePaths` and
    // confirm the untrusted primitive shrink on `gateway.mode` is
    // surfaced as a rejection.
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        meta: { lastTouchedVersion: "2026.4.30" },
        gateway: { mode: "x".repeat(4000) },
        channels: {
          telegram: {
            enabled: true,
            allowFrom: Array.from({ length: 4000 }, (_, index) => `telegram:${index}`),
          },
        },
      } as Record<string, unknown> as ConfigFileSnapshot["config"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: original,
        config: original,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } as ConfigFileSnapshot;

      // Trusted migration authorized ONLY the `channels` removal. The
      // unrelated long string in `gateway.mode` shrinks in the new
      // payload but is NOT in the authorized set.
      const authorizedDestructivePaths: Array<readonly (string | number)[]> = [["channels"]];

      await expectConfigWriteRejected(
        io.writeConfigFile(
          {
            meta: { lastTouchedVersion: "2026.4.30" },
            gateway: { mode: "local" },
          },
          {
            allowConfigSizeDrop: true,
            authorizedDestructivePaths,
            lastTouchedVersionOverride: "2026.4.30",
            baseSnapshot,
          },
        ),
      );
    });
  });

  it("keeps authored agent provider params during narrowed internal agent writes", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        gateway: { mode: "local" },
        agents: {
          defaults: {
            params: { transport: "sse", openaiWsWarmup: false },
            models: {
              "openai/gpt-5.4": {
                alias: "GPT",
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
          },
          list: [{ id: "main" }],
        },
      } satisfies ConfigFileSnapshot["sourceConfig"];
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: originalRaw,
        parsed: original,
        sourceConfig: original,
        resolved: original,
        valid: true,
        runtimeConfig: {
          ...original,
          agents: {
            ...original.agents,
            defaults: {
              ...original.agents.defaults,
              maxConcurrent: 4,
            },
          },
        },
        config: {
          ...original,
          agents: {
            ...original.agents,
            defaults: {
              ...original.agents.defaults,
              maxConcurrent: 4,
            },
          },
        },
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      await io.writeConfigFile(
        {
          gateway: { mode: "local" },
          agents: { list: [{ id: "main" }, { id: "ops" }] },
        },
        { baseSnapshot },
      );

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as OpenClawConfig;
      expect(persisted.agents?.defaults?.params).toEqual({
        transport: "sse",
        openaiWsWarmup: false,
      });
      expect(persisted.agents?.defaults?.models?.["openai/gpt-5.4"]).toEqual({
        alias: "GPT",
        params: { transport: "sse", openaiWsWarmup: false },
      });
      expect(persisted.agents?.list).toEqual([{ id: "main" }, { id: "ops" }]);
    });
  });

  it("preserves parsed source config when snapshot validation fails", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = {
        gateway: { mode: "local" },
        channels: { "test-plugin-channel": { enabled: true } },
      };
      const originalRaw = `${JSON.stringify(original, null, 2)}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createFastConfigIO(home);

      const snapshot = await io.readConfigFileSnapshot();

      expect(snapshot.valid).toBe(false);
      expect(snapshot.raw).toBe(originalRaw);
      expect(snapshot.parsed).toEqual(original);
      expect(snapshot.sourceConfig).toEqual(original);
      expect(snapshot.config).toEqual(original);
      expect(snapshot.issues[0]?.message).toContain("unknown channel id: test-plugin-channel");
    });
  });

  it("returns the read-time environment snapshot for invalid config repairs", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            gateway: {
              mode: "local",
              auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
            },
            channels: { "test-plugin-channel": { enabled: true } },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      const io = createConfigIO({
        env: {
          OPENCLAW_GATEWAY_TOKEN: "gateway-token-at-read",
          OPENCLAW_TEST_FAST: "1",
        } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });

      const result = await io.readConfigFileSnapshotForWrite();

      expect(result.snapshot.valid).toBe(false);
      expect(result.writeOptions.envSnapshotForRestore?.OPENCLAW_GATEWAY_TOKEN).toBe(
        "gateway-token-at-read",
      );
    });
  });

  it("returns the read-time environment snapshot when invalid reads fall back after resolution", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            gateway: {
              mode: "local",
              auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
            },
            channels: { "test-plugin-channel": { enabled: true } },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      mockLoadPluginManifestRegistry.mockImplementationOnce(() => {
        throw new Error("plugin metadata failed");
      });
      const io = createConfigIO({
        env: {
          OPENCLAW_GATEWAY_TOKEN: "gateway-token-at-read",
          OPENCLAW_TEST_FAST: "1",
        } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });

      const result = await io.readConfigFileSnapshotForWrite();

      expect(result.snapshot.valid).toBe(false);
      expect(result.writeOptions.envSnapshotForRestore?.OPENCLAW_GATEWAY_TOKEN).toBe(
        "gateway-token-at-read",
      );
    });
  });

  it("returns the snapshot-time hash when an included file is malformed", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const includePath = path.join(home, ".openclaw", "plugins.json5");
      const malformedRaw = "{ malformed";
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ plugins: { $include: "./plugins.json5" } }, null, 2)}\n`,
        "utf-8",
      );
      await fs.writeFile(includePath, malformedRaw, "utf-8");
      const io = createConfigIO({
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });

      const result = await io.readConfigFileSnapshotForWrite();
      await fs.writeFile(includePath, "{ differently malformed", "utf-8");

      expect(result.snapshot.valid).toBe(false);
      expect(result.writeOptions.includeFileHashesForWrite?.[includePath]).toBe(
        hashConfigIncludeRaw(malformedRaw),
      );
      expect(result.writeOptions.includeFileTargetsForWrite?.[includePath]).toBe(
        await fs.realpath(includePath),
      );
    });
  });

  it("returns a write guard that rejects a changed active config path", async () => {
    await withSuiteHome(async (home) => {
      const firstConfigPath = path.join(home, ".openclaw", "first.json");
      const secondConfigPath = path.join(home, ".openclaw", "second.json");
      await fs.mkdir(path.dirname(firstConfigPath), { recursive: true });
      await fs.writeFile(firstConfigPath, "{}", "utf-8");
      await fs.writeFile(secondConfigPath, "{}", "utf-8");
      const env = {
        OPENCLAW_CONFIG_PATH: firstConfigPath,
        OPENCLAW_TEST_FAST: "1",
      } as NodeJS.ProcessEnv;
      const io = createConfigIO({ env, homedir: () => home, logger: silentLogger });

      const result = await io.readConfigFileSnapshotForWrite();
      env.OPENCLAW_CONFIG_PATH = secondConfigPath;

      expect(() => result.writeOptions.assertConfigPathForWrite?.()).toThrow(
        "config path changed since last load",
      );
    });
  });

  it("rejects write snapshots when the IO instance no longer owns its config path", async () => {
    await withSuiteHome(async (home) => {
      const firstConfigPath = path.join(home, ".openclaw", "first.json");
      const secondConfigPath = path.join(home, ".openclaw", "second.json");
      await fs.mkdir(path.dirname(firstConfigPath), { recursive: true });
      await fs.writeFile(firstConfigPath, "{}", "utf-8");
      await fs.writeFile(secondConfigPath, "{}", "utf-8");
      const env = {
        OPENCLAW_CONFIG_PATH: firstConfigPath,
        OPENCLAW_TEST_FAST: "1",
      } as NodeJS.ProcessEnv;
      const io = createConfigIO({ env, homedir: () => home, logger: silentLogger });
      env.OPENCLAW_CONFIG_PATH = secondConfigPath;

      await expect(io.readConfigFileSnapshotForWrite()).rejects.toThrow(
        "config path changed since last load",
      );
    });
  });

  it("rejects local write ownership when config env changes path selection during the read", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const configuredNextPath = path.join(home, ".openclaw", "next.json");
      const sourceConfig = {
        env: { OPENCLAW_CONFIG_PATH: configuredNextPath },
        gateway: { mode: "local" },
      } satisfies OpenClawConfig;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify(sourceConfig, null, 2)}\n`, "utf-8");
      const io = createFastConfigIO(home);

      await expect(io.readConfigFileSnapshotForWrite()).rejects.toThrow(
        "config path changed since last load",
      );
    });
  });

  it("follows config env path selection before returning global write ownership", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const configuredNextPath = path.join(home, ".openclaw", "next.json");
      const sourceConfig = {
        env: { OPENCLAW_CONFIG_PATH: configuredNextPath },
        gateway: { mode: "local" },
      } satisfies OpenClawConfig;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify(sourceConfig, null, 2)}\n`, "utf-8");
      await fs.writeFile(
        configuredNextPath,
        `${JSON.stringify({ gateway: { mode: "local" } }, null, 2)}\n`,
        "utf-8",
      );

      await withEnvAsync(
        {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_HOME: home,
          OPENCLAW_STATE_DIR: undefined,
          OPENCLAW_TEST_FAST: "1",
        },
        async () => {
          const prepared = await readConfigFileSnapshotForWrite();

          expect(prepared.snapshot.path).toBe(configuredNextPath);
          expect(() => prepared.writeOptions.assertConfigPathForWrite?.()).not.toThrow();
          await writeConfigFile(
            {
              ...prepared.snapshot.sourceConfig,
              gateway: { mode: "remote" },
            },
            {
              baseSnapshot: prepared.snapshot,
              ...prepared.writeOptions,
            },
          );
        },
      );

      const initialConfig = JSON.parse(await fs.readFile(configPath, "utf-8")) as OpenClawConfig;
      const persisted = JSON.parse(
        await fs.readFile(configuredNextPath, "utf-8"),
      ) as OpenClawConfig;
      expect(initialConfig.gateway?.mode).toBe("local");
      expect(persisted.gateway?.mode).toBe("remote");
    });
  });

  it("does not use expectedConfigPath as the write destination", async () => {
    await withSuiteHome(async (home) => {
      const expectedConfigPath = path.join(home, ".openclaw", "expected.json");
      const activeConfigPath = path.join(home, ".openclaw", "active.json");
      await fs.mkdir(path.dirname(expectedConfigPath), { recursive: true });
      await fs.writeFile(
        expectedConfigPath,
        `${JSON.stringify({ gateway: { mode: "local" } }, null, 2)}\n`,
        "utf-8",
      );
      await fs.writeFile(activeConfigPath, "{}\n", "utf-8");

      await withEnvAsync(
        {
          OPENCLAW_CONFIG_PATH: activeConfigPath,
          OPENCLAW_TEST_FAST: "1",
        },
        async () => {
          await writeConfigFile(
            { gateway: { mode: "remote" } },
            {
              expectedConfigPath,
            },
          );
        },
      );

      const expectedConfig = JSON.parse(
        await fs.readFile(expectedConfigPath, "utf-8"),
      ) as OpenClawConfig;
      const activeConfig = JSON.parse(
        await fs.readFile(activeConfigPath, "utf-8"),
      ) as OpenClawConfig;
      expect(expectedConfig.gateway?.mode).toBe("local");
      expect(activeConfig.gateway?.mode).toBe("remote");
    });
  });

  it("returns the missing-file hash when an included file is absent", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const includePath = path.join(home, ".openclaw", "plugins.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ plugins: { $include: "./plugins.json5" } }, null, 2)}\n`,
        "utf-8",
      );
      const io = createConfigIO({
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });

      const result = await io.readConfigFileSnapshotForWrite();

      expect(result.snapshot.valid).toBe(false);
      expect(result.writeOptions.includeFileHashesForWrite?.[includePath]).toBe(
        hashConfigIncludeRaw(null),
      );
      expect(result.writeOptions.includeFileTargetsForWrite?.[includePath]).toBe(
        path.join(await fs.realpath(path.dirname(includePath)), path.basename(includePath)),
      );
    });
  });

  it("rejects root-include partial writes instead of flattening the root config", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const includePath = path.join(home, ".openclaw", "extra.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        includePath,
        `${JSON.stringify({ $schema: "https://openclaw.ai/config-from-include.json" }, null, 2)}\n`,
        "utf-8",
      );
      await fs.writeFile(
        configPath,
        `{\n  "$include": "./extra.json5",\n  "gateway": { "mode": "local" }\n}\n`,
        "utf-8",
      );
      const originalRaw = await fs.readFile(configPath, "utf-8");

      await expect(writeGatewayPortAndReadConfig(home, configPath)).rejects.toThrow(
        "Config write would flatten $include-owned config at <root>",
      );
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("rejects a stale base snapshot before overwriting the root config", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
        "utf-8",
      );
      const io = createConfigIO({
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const snapshot = await io.readConfigFileSnapshot();
      const concurrentRaw = `${JSON.stringify(
        { gateway: { mode: "local", port: 19001 } },
        null,
        2,
      )}\n`;
      await fs.writeFile(configPath, concurrentRaw, "utf-8");

      await expect(
        io.writeConfigFile({ gateway: { mode: "local", port: 19002 } }, { baseSnapshot: snapshot }),
      ).rejects.toThrow("config changed since last load");

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(concurrentRaw);
    });
  });

  it("rejects a base snapshot from a different config path before overwriting the root config", async () => {
    await withSuiteHome(async (home) => {
      const firstConfigPath = path.join(home, ".openclaw", "first.json");
      const secondConfigPath = path.join(home, ".openclaw", "second.json");
      await fs.mkdir(path.dirname(firstConfigPath), { recursive: true });
      const originalRaw = `${JSON.stringify(
        { gateway: { mode: "local", port: 18789 } },
        null,
        2,
      )}\n`;
      await fs.writeFile(firstConfigPath, originalRaw, "utf-8");
      await fs.writeFile(secondConfigPath, originalRaw, "utf-8");
      const firstIo = createConfigIO({
        configPath: firstConfigPath,
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const secondIo = createConfigIO({
        configPath: secondConfigPath,
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const firstSnapshot = await firstIo.readConfigFileSnapshot();

      await expect(
        secondIo.writeConfigFile(
          { gateway: { mode: "local", port: 19002 } },
          { baseSnapshot: firstSnapshot },
        ),
      ).rejects.toThrow("config path changed since last load");

      await expect(fs.readFile(secondConfigPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("rolls back a root write when config path ownership changes during commit", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const secondConfigPath = path.join(home, ".openclaw", "second.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const originalRaw = `${JSON.stringify(
        { gateway: { mode: "local", port: 18789 } },
        null,
        2,
      )}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        configPath,
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const snapshot = await io.readConfigFileSnapshot();
      let activeConfigPath = configPath;
      const assertConfigPathForWrite = () => {
        if (fsNode.readFileSync(configPath, "utf-8") !== originalRaw) {
          activeConfigPath = secondConfigPath;
        }
        if (activeConfigPath !== configPath) {
          throw new ConfigMutationConflictError("config path changed since last load", {
            currentHash: null,
            retryable: false,
          });
        }
      };

      await expect(
        io.writeConfigFile(
          { gateway: { mode: "local", port: 19002 } },
          { baseSnapshot: snapshot, assertConfigPathForWrite },
        ),
      ).rejects.toThrow("config path changed since last load");

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("rejects a base snapshot changed during preflight before replacing the root config", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
        "utf-8",
      );
      const io = createConfigIO({
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const snapshot = await io.readConfigFileSnapshot();
      const concurrentRaw = `${JSON.stringify(
        { gateway: { mode: "local", port: 19001 } },
        null,
        2,
      )}\n`;

      await expect(
        io.writeConfigFile(
          { gateway: { mode: "local", port: 19002 } },
          {
            baseSnapshot: snapshot,
            preCommitRuntimePreflight: async () => {
              await fs.writeFile(configPath, concurrentRaw, "utf-8");
            },
          },
        ),
      ).rejects.toThrow("config changed since last load");

      expect(mockMaintainConfigBackups).not.toHaveBeenCalled();
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(concurrentRaw);
    });
  });

  it("rejects a base snapshot changed during backup rotation", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
        "utf-8",
      );
      const io = createConfigIO({
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const snapshot = await io.readConfigFileSnapshot();
      const concurrentRaw = `${JSON.stringify(
        { gateway: { mode: "local", port: 19001 } },
        null,
        2,
      )}\n`;
      mockMaintainConfigBackups.mockImplementationOnce(async () => {
        await fs.writeFile(configPath, concurrentRaw, "utf-8");
      });

      await expect(
        io.writeConfigFile({ gateway: { mode: "local", port: 19002 } }, { baseSnapshot: snapshot }),
      ).rejects.toThrow("config changed since last load");

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(concurrentRaw);
    });
  });

  it("rejects a missing base config created empty during preflight", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const io = createConfigIO({
        configPath,
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.exists).toBe(false);

      await expect(
        io.writeConfigFile(
          { gateway: { mode: "local", port: 19002 } },
          {
            baseSnapshot: snapshot,
            preCommitRuntimePreflight: async () => {
              await fs.writeFile(configPath, "", "utf-8");
            },
          },
        ),
      ).rejects.toThrow("config changed since last load");

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe("");
    });
  });

  it("assigns distinct snapshot hashes to missing and empty root config", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const io = createConfigIO({
        configPath,
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const missingSnapshot = await io.readConfigFileSnapshot();
      expect(missingSnapshot.exists).toBe(false);

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, "", "utf-8");
      const emptySnapshot = await io.readConfigFileSnapshot();
      expect(emptySnapshot.exists).toBe(true);
      expect(emptySnapshot.hash).not.toBe(missingSnapshot.hash);
    });
  });

  it("rejects an empty base config removed during preflight", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, "", "utf-8");
      const io = createConfigIO({
        configPath,
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.exists).toBe(true);

      await expect(
        io.writeConfigFile(
          { gateway: { mode: "local", port: 19002 } },
          {
            baseSnapshot: snapshot,
            preCommitRuntimePreflight: async () => {
              await fs.unlink(configPath);
            },
          },
        ),
      ).rejects.toThrow("config changed since last load");

      await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects invalid include-backed repairs instead of persisting substituted secrets", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const includePath = path.join(home, ".openclaw", "gateway.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        includePath,
        `${JSON.stringify(
          {
            mode: "local",
            auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
            invalid: true,
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { $include: "./gateway.json5" } }, null, 2)}\n`,
        "utf-8",
      );
      const originalRootRaw = await fs.readFile(configPath, "utf-8");
      const io = createConfigIO({
        env: {
          OPENCLAW_GATEWAY_TOKEN: "gateway-token-runtime",
          OPENCLAW_TEST_FAST: "1",
        } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(false);

      await expect(
        io.writeConfigFile({
          gateway: {
            mode: "local",
            auth: { mode: "token", token: "gateway-token-runtime" },
          },
        }),
      ).rejects.toThrow("Config write would flatten $include-owned config at gateway");

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRootRaw);
      await expect(fs.readFile(includePath, "utf-8")).resolves.toContain(
        '"token": "${OPENCLAW_GATEWAY_TOKEN}"',
      );
    });
  });

  it("repairs invalid root-authored siblings without flattening included config", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const includePath = path.join(home, ".openclaw", "agent-defaults.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        includePath,
        `${JSON.stringify({ maxConcurrent: 1 }, null, 2)}\n`,
        "utf-8",
      );
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            agents: {
              defaults: { $include: "./agent-defaults.json5", legacyKey: true },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      const originalIncludeRaw = await fs.readFile(includePath, "utf-8");
      const io = createConfigIO({
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(false);

      await io.writeConfigFile({ agents: { defaults: { maxConcurrent: 1 } } });

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        agents?: { defaults?: Record<string, unknown> };
      };
      expect(persisted.agents?.defaults).toEqual({ $include: "./agent-defaults.json5" });
      await expect(fs.readFile(includePath, "utf-8")).resolves.toBe(originalIncludeRaw);
    });
  });

  it("rejects repairs that would flatten a valid outer include with a broken nested include", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const pluginsPath = path.join(home, ".openclaw", "plugins.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        pluginsPath,
        `${JSON.stringify({ $include: "./missing-entries.json5" }, null, 2)}\n`,
        "utf-8",
      );
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ plugins: { $include: "./plugins.json5" } }, null, 2)}\n`,
        "utf-8",
      );
      const originalRootRaw = await fs.readFile(configPath, "utf-8");
      const originalPluginsRaw = await fs.readFile(pluginsPath, "utf-8");
      const io = createConfigIO({
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(false);

      await expect(io.writeConfigFile({ plugins: { entries: {} } })).rejects.toThrow(
        "Config write would flatten $include-owned config at plugins",
      );

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRootRaw);
      await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(originalPluginsRaw);
    });
  });

  it("allows replacement repair of a malformed include directive", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ plugins: { $include: 42 } }, null, 2)}\n`,
        "utf-8",
      );
      const io = createConfigIO({
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(false);

      await io.writeConfigFile({ plugins: {} });

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        plugins?: Record<string, unknown>;
      };
      expect(persisted.plugins).toEqual({});
    });
  });

  it("preserves escaped root literals before validating unrelated includes", async () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "literal-plugin",
          origin: "bundled",
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          rootDir: "/tmp/openclaw-test-literal-plugin",
          source: "/tmp/openclaw-test-literal-plugin/index.ts",
          manifestPath: "/tmp/openclaw-test-literal-plugin/openclaw.plugin.json",
          configSchema: {
            type: "object",
            properties: {
              token: { type: "string", const: "${ROOT_LITERAL_TOKEN}" },
            },
            required: ["token"],
            additionalProperties: false,
          },
        },
      ],
    } satisfies PluginManifestRegistry);

    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const agentsPath = path.join(home, ".openclaw", "agents.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        agentsPath,
        `${JSON.stringify({ list: [{ id: "main", default: true }] }, null, 2)}\n`,
        "utf-8",
      );
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            agents: { $include: "./agents.json5" },
            plugins: {
              entries: {
                "literal-plugin": {
                  enabled: true,
                  config: { token: "$${ROOT_LITERAL_TOKEN}" },
                },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      const io = createConfigIO({
        env: {
          OPENCLAW_TEST_FAST: "1",
          ROOT_LITERAL_TOKEN: "secret",
        } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      await io.writeConfigFile({
        ...snapshot.sourceConfig,
        gateway: { mode: "local" },
      });

      await expect(fs.readFile(configPath, "utf-8")).resolves.toContain(
        '"token": "$${ROOT_LITERAL_TOKEN}"',
      );
    });
  });

  it("repairs invalid config without flattening array-nested includes", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const includePath = path.join(home, ".openclaw", "main-agent.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        includePath,
        `${JSON.stringify({ id: "main", workspace: "${OPENCLAW_AGENT_WORKSPACE}" }, null, 2)}\n`,
        "utf-8",
      );
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            agents: {
              defaults: { params: { stale: true } },
              list: [{ $include: "./main-agent.json5" }],
            },
            channels: { "test-plugin-channel": { enabled: true } },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      const originalRootRaw = await fs.readFile(configPath, "utf-8");
      const io = createConfigIO({
        env: {
          OPENCLAW_AGENT_WORKSPACE: "/resolved/agent-workspace",
          OPENCLAW_TEST_FAST: "1",
        } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(false);

      await io.writeConfigFile({
        agents: { list: [{ id: "main", workspace: "/resolved/agent-workspace" }] },
      });

      await expect(fs.readFile(configPath, "utf-8")).resolves.not.toBe(originalRootRaw);
      const persistedRoot = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        agents?: { defaults?: unknown; list?: unknown[] };
      };
      expect(persistedRoot.agents?.defaults).toBeUndefined();
      expect(persistedRoot.agents?.list).toEqual([{ $include: "./main-agent.json5" }]);
      await expect(fs.readFile(includePath, "utf-8")).resolves.toContain(
        '"workspace": "${OPENCLAW_AGENT_WORKSPACE}"',
      );
    });
  });

  it("writes disabled plugin entries without requiring plugin config", async () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "required-plugin",
          origin: "bundled",
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          rootDir: "/tmp/openclaw-test-required-plugin",
          source: "/tmp/openclaw-test-required-plugin/index.ts",
          manifestPath: "/tmp/openclaw-test-required-plugin/openclaw.plugin.json",
          configSchema: {
            type: "object",
            properties: {
              token: { type: "string" },
            },
            required: ["token"],
            additionalProperties: true,
          },
        },
      ],
    } satisfies PluginManifestRegistry);

    await withSuiteHome(async (home) => {
      const io = createConfigIO({
        env: { VITEST: "true" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });

      expectPersistedHashResult(
        await io.writeConfigFile({
          agents: { list: [{ id: "main", default: true }] },
          plugins: {
            entries: {
              "required-plugin": {
                enabled: false,
              },
            },
          },
        }),
      );
    });

    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [],
    } satisfies PluginManifestRegistry);
  });

  it("writes runtime-derived edits back to source SecretRef markers", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            gateway: { mode: "local" },
            models: {
              providers: {
                openai: {
                  baseUrl: "https://api.openai.com/v1",
                  apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                  models: [],
                },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
        setRuntimeConfigSnapshot(
          {
            gateway: { mode: "local" },
            models: {
              providers: {
                openai: {
                  baseUrl: "https://api.openai.com/v1",
                  apiKey: "sk-runtime-resolved",
                  models: [],
                },
              },
            },
          },
          {
            gateway: { mode: "local" },
            models: {
              providers: {
                openai: {
                  baseUrl: "https://api.openai.com/v1",
                  apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                  models: [],
                },
              },
            },
          },
        );

        await writeConfigFile({
          gateway: { mode: "local", port: 18789 },
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                apiKey: "sk-runtime-resolved",
                models: [],
              },
            },
          },
        });

        const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
          meta?: Record<string, unknown>;
        };
        expect(persisted).toEqual({
          gateway: { mode: "local", port: 18789 },
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                models: [],
              },
            },
          },
          meta: {
            lastTouchedAt: persisted.meta?.lastTouchedAt,
            lastTouchedVersion: persisted.meta?.lastTouchedVersion,
          },
        });
        expect(typeof persisted.meta?.lastTouchedAt).toBe("string");
        expect(typeof persisted.meta?.lastTouchedVersion).toBe("string");
      });
    });
  });

  it("notifies in-process reloaders with resolved source config when persisted env refs are restored", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            gateway: {
              mode: "local",
              auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
            },
            agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      const observedSources: unknown[] = [];
      const unsubscribe = registerConfigWriteListener((event) => {
        observedSources.push(event.sourceConfig);
      });

      try {
        await withEnvAsync(
          {
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_GATEWAY_TOKEN: "gateway-token-runtime",
          },
          async () => {
            setRuntimeConfigSnapshot(
              {
                gateway: {
                  mode: "local",
                  auth: { mode: "token", token: "gateway-token-runtime" },
                },
                agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
              },
              {
                gateway: {
                  mode: "local",
                  auth: { mode: "token", token: "gateway-token-runtime" },
                },
                agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
              },
            );

            await writeConfigFile({
              gateway: {
                mode: "local",
                auth: { mode: "token", token: "gateway-token-runtime" },
              },
              agents: {
                defaults: { model: { primary: "openrouter/anthropic/claude-sonnet-4.6" } },
              },
            });

            const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
              gateway?: { auth?: { token?: string } };
            };
            expect(persisted.gateway?.auth?.token).toBe("${OPENCLAW_GATEWAY_TOKEN}");
            expect(observedSources).toHaveLength(1);
            const observedSource = requireRecord(observedSources[0], "observed source config");
            expect(observedSource.gateway).toEqual({
              mode: "local",
              auth: { mode: "token", token: "gateway-token-runtime" },
            });
            expect(observedSource.agents).toEqual({
              defaults: {
                model: { primary: "openrouter/anthropic/claude-sonnet-4.6" },
              },
            });
          },
        );
      } finally {
        unsubscribe();
      }
    });
  });

  it("rejects ambiguous removals from arrays containing environment references", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const originalRaw = `${JSON.stringify(
        { plugins: { allow: ["${PLUGIN_A}", "${PLUGIN_B}"] } },
        null,
        2,
      )}\n`;
      await fs.writeFile(configPath, originalRaw, "utf-8");
      const io = createConfigIO({
        env: {
          OPENCLAW_TEST_FAST: "1",
          PLUGIN_A: "same-plugin",
          PLUGIN_B: "same-plugin",
        } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });

      await expect(io.writeConfigFile({ plugins: { allow: ["same-plugin"] } })).rejects.toThrow(
        "Config write would reorder or modify an array",
      );

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("preserves escaped literals when config writes reorder arrays", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ plugins: { allow: ["$${PLUGIN_ID}", "literal-plugin"] } }, null, 2)}\n`,
        "utf-8",
      );
      const io = createConfigIO({
        env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: silentLogger,
      });

      await io.writeConfigFile({ plugins: { allow: ["literal-plugin", "${PLUGIN_ID}"] } });

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        plugins?: { allow?: string[] };
      };
      expect(persisted.plugins?.allow).toEqual(["literal-plugin", "$${PLUGIN_ID}"]);
    });
  });

  it("notifies in-process reloaders with canonical post-write source config", async () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "demo",
          origin: "bundled",
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          rootDir: "/tmp/openclaw-test-demo",
          source: "/tmp/openclaw-test-demo/index.ts",
          manifestPath: "/tmp/openclaw-test-demo/openclaw.plugin.json",
          configSchema: {
            type: "object",
            properties: {
              mode: { type: "string", default: "auto" },
            },
            additionalProperties: true,
          },
        },
      ],
    } satisfies PluginManifestRegistry);

    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const sourceConfig = {
        gateway: { mode: "local" },
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
        plugins: { entries: { demo: { enabled: true, config: {} } } },
      } satisfies ConfigFileSnapshot["sourceConfig"];
      await fs.writeFile(configPath, `${JSON.stringify(sourceConfig, null, 2)}\n`, "utf-8");
      const runtimeConfig = {
        ...structuredClone(sourceConfig),
        plugins: {
          entries: {
            demo: { enabled: true, config: { mode: "auto" } },
          },
        },
      } satisfies ConfigFileSnapshot["config"];
      const observedSources: unknown[] = [];
      const unsubscribe = registerConfigWriteListener((event) => {
        observedSources.push(event.sourceConfig);
      });

      try {
        await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
          setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

          await writeConfigFile({
            ...runtimeConfig,
            agents: {
              defaults: {
                model: { primary: "openrouter/anthropic/claude-sonnet-4.6" },
              },
            },
          });

          const postWriteSnapshot = await createConfigIO({
            env: { OPENCLAW_CONFIG_PATH: configPath, VITEST: "true" } as NodeJS.ProcessEnv,
            homedir: () => home,
            logger: silentLogger,
          }).readConfigFileSnapshot();

          expect(postWriteSnapshot.valid).toBe(true);
          expect(observedSources).toEqual([postWriteSnapshot.sourceConfig]);
          expect(getRuntimeConfigSourceSnapshot()).toEqual(postWriteSnapshot.sourceConfig);
          expect(postWriteSnapshot.sourceConfig.meta?.lastTouchedAt).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
          );
          expect(postWriteSnapshot.sourceConfig.plugins?.entries?.demo?.config).toStrictEqual({});
        });
      } finally {
        unsubscribe();
        mockLoadPluginManifestRegistry.mockReturnValue({
          diagnostics: [],
          plugins: [],
        } satisfies PluginManifestRegistry);
      }
    });
  });

  it("rolls back the root config when post-write runtime refresh fails", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const initialConfig = { gateway: { mode: "local", port: 18789 } } satisfies OpenClawConfig;
      const initialRaw = `${JSON.stringify(initialConfig, null, 2)}\n`;
      await fs.writeFile(configPath, initialRaw, "utf-8");

      try {
        await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
          setRuntimeConfigSnapshotRefreshHandler({
            refresh: () => {
              throw new Error("synthetic refresh failure");
            },
          });

          await expect(
            writeConfigFile({ gateway: { mode: "local", port: 19001 } }),
          ).rejects.toThrow(/runtime snapshot refresh failed: synthetic refresh failure/);

          await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
        });
      } finally {
        setRuntimeConfigSnapshotRefreshHandler(null);
      }
    });
  });

  it("does not delete an existing root config when rollback has no previous raw payload", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const initialConfig = { gateway: { mode: "local", port: 18789 } } satisfies OpenClawConfig;
      await fs.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf-8");
      const baseSnapshot = {
        path: configPath,
        exists: true,
        raw: null,
        parsed: initialConfig,
        sourceConfig: initialConfig,
        resolved: initialConfig,
        valid: true,
        runtimeConfig: initialConfig,
        config: initialConfig,
        issues: [],
        warnings: [],
        legacyIssues: [],
      } satisfies ConfigFileSnapshot;

      try {
        await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
          setRuntimeConfigSnapshotRefreshHandler({
            refresh: () => {
              throw new Error("synthetic refresh failure");
            },
          });

          await expect(
            writeConfigFile(
              { gateway: { mode: "local", port: 19001 } },
              {
                baseSnapshot,
              },
            ),
          ).rejects.toThrow(/runtime snapshot refresh failed: synthetic refresh failure/);

          const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as OpenClawConfig;
          expect(persisted.gateway).toEqual({ mode: "local", port: 19001 });
        });
      } finally {
        setRuntimeConfigSnapshotRefreshHandler(null);
      }
    });
  });

  it("does not overwrite concurrent root config edits during failed refresh rollback", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
        "utf-8",
      );
      const concurrentRaw = `${JSON.stringify(
        { gateway: { mode: "local", port: 19191 } },
        null,
        2,
      )}\n`;

      try {
        await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
          setRuntimeConfigSnapshotRefreshHandler({
            refresh: async () => {
              await fs.writeFile(configPath, concurrentRaw, "utf-8");
              throw new Error("synthetic refresh failure");
            },
          });

          await expect(
            writeConfigFile({ gateway: { mode: "local", port: 19001 } }),
          ).rejects.toThrow(/runtime snapshot refresh failed: synthetic refresh failure/);

          await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(concurrentRaw);
        });
      } finally {
        setRuntimeConfigSnapshotRefreshHandler(null);
      }
    });
  });

  it("keeps plugin install index migration when runtime refresh fails", async () => {
    await withSuiteHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      const pluginDir = path.join(stateDir, "plugins", "demo");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const initialConfig = {
        plugins: {
          entries: { demo: { enabled: true } },
          installs: {
            demo: {
              source: "npm",
              spec: "demo@1.0.0",
              installPath: pluginDir,
            },
          },
        },
      } satisfies OpenClawConfig;
      const initialRaw = `${JSON.stringify(initialConfig, null, 2)}\n`;
      await fs.writeFile(configPath, initialRaw, "utf-8");

      try {
        await withEnvAsync(
          {
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_STATE_DIR: stateDir,
          },
          async () => {
            setRuntimeConfigSnapshotRefreshHandler({
              refresh: () => {
                throw new Error("synthetic refresh failure");
              },
            });

            await expect(
              writeConfigFile({ plugins: { entries: { demo: { enabled: true } } } }),
            ).rejects.toThrow(/runtime snapshot refresh failed: synthetic refresh failure/);

            await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
            const persistedIndex = await readPersistedInstalledPluginIndex({ stateDir });
            expectInstallRecord(persistedIndex?.installRecords.demo, {
              source: "npm",
              spec: "demo@1.0.0",
              installPath: pluginDir,
            });
          },
        );
      } finally {
        setRuntimeConfigSnapshotRefreshHandler(null);
      }
    });
  });

  it("blocks runtime preflight failures before committing root writes", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const initialRaw = `${JSON.stringify({ gateway: { mode: "local" } }, null, 2)}\n`;
      let observedSource: OpenClawConfig | undefined;

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, initialRaw, "utf-8");

      try {
        await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
          setRuntimeConfigSnapshotRefreshHandler({
            preflight: async ({ sourceConfig }) => {
              observedSource = sourceConfig;
              throw new Error("missing included secret");
            },
            refresh: () => true,
          });

          await expect(
            writeConfigFile({
              gateway: { mode: "local", port: 19001 },
              logging: { level: "debug" },
            }),
          ).rejects.toThrow(/active SecretRef resolution failed: missing included secret/);

          expect(observedSource?.gateway?.port).toBe(19001);
          await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
        });
      } finally {
        setRuntimeConfigSnapshotRefreshHandler(null);
      }
    });
  });

  it("blocks runtime preflight failures before direct config IO commits root writes", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const initialRaw = `${JSON.stringify({ gateway: { mode: "local" } }, null, 2)}\n`;
      const env = {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
      } as NodeJS.ProcessEnv;
      let observedSource: OpenClawConfig | undefined;

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, initialRaw, "utf-8");

      try {
        setRuntimeConfigSnapshotRefreshHandler({
          preflight: async ({ sourceConfig }) => {
            observedSource = sourceConfig;
            throw new Error("missing direct IO secret");
          },
          refresh: () => true,
        });

        await expect(
          createConfigIO({ env, logger: silentLogger }).writeConfigFile({
            gateway: { mode: "local", port: 19001 },
          }),
        ).rejects.toThrow(/active SecretRef resolution failed: missing direct IO secret/);

        expect(observedSource?.gateway?.port).toBe(19001);
        await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
      } finally {
        setRuntimeConfigSnapshotRefreshHandler(null);
      }
    });
  });

  it("restores config env vars when post-write runtime refresh rollback succeeds", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const envKey = "OPENCLAW_TEST_RUNTIME_ROLLBACK_ENV";
      const initialConfig = { gateway: { mode: "local", port: 18789 } } satisfies OpenClawConfig;
      const initialRaw = `${JSON.stringify(initialConfig, null, 2)}\n`;

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, initialRaw, "utf-8");

      try {
        await withEnvAsync(
          {
            OPENCLAW_CONFIG_PATH: configPath,
            [envKey]: undefined,
          },
          async () => {
            setRuntimeConfigSnapshotRefreshHandler({
              refresh: () => {
                expect(process.env[envKey]).toBe("written-env-value");
                throw new Error("synthetic refresh failure");
              },
            });

            await expect(
              writeConfigFile({
                gateway: { mode: "local", port: 19001 },
                env: { vars: { [envKey]: "written-env-value" } },
              }),
            ).rejects.toThrow(/runtime snapshot refresh failed: synthetic refresh failure/);

            await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
            expect(process.env[envKey]).toBeUndefined();
          },
        );
      } finally {
        setRuntimeConfigSnapshotRefreshHandler(null);
      }
    });
  });

  it("rolls back root writes when canonical reread changes config path ownership", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const nextConfigPath = path.join(home, ".openclaw", "next.json");
      const initialConfig = { gateway: { mode: "local", port: 18789 } } satisfies OpenClawConfig;
      const initialRaw = `${JSON.stringify(initialConfig, null, 2)}\n`;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, initialRaw, "utf-8");

      await withEnvAsync(
        {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_HOME: home,
          OPENCLAW_STATE_DIR: undefined,
          OPENCLAW_TEST_FAST: "1",
        },
        async () => {
          const prepared = await readConfigFileSnapshotForWrite();

          await expect(
            writeConfigFile(
              {
                gateway: { mode: "local", port: 19001 },
                env: { OPENCLAW_CONFIG_PATH: nextConfigPath },
              },
              {
                baseSnapshot: prepared.snapshot,
                ...prepared.writeOptions,
              },
            ),
          ).rejects.toThrow("config path changed since last load");

          await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
          expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
          await expect(fs.stat(nextConfigPath)).rejects.toMatchObject({ code: "ENOENT" });
        },
      );
    });
  });

  it("uses injected filesystem operations when rolling back ownership loss", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const otherConfigPath = path.join(home, ".openclaw", "other.json");
      const initialConfig = { gateway: { mode: "local", port: 18789 } } satisfies OpenClawConfig;
      const initialRaw = `${JSON.stringify(initialConfig, null, 2)}\n`;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, initialRaw, "utf-8");
      const env = {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_TEST_FAST: "1",
      } as NodeJS.ProcessEnv;
      const readFile = fsNode.promises.readFile.bind(fsNode.promises);
      const rename = fsNode.promises.rename.bind(fsNode.promises);
      let committed = false;
      let rollbackReadUsedInjectedFs = false;
      const injectedFs = {
        ...fsNode,
        promises: {
          ...fsNode.promises,
          readFile: async (target, options) => {
            if (committed && target === configPath) {
              rollbackReadUsedInjectedFs = true;
            }
            return await readFile(target, options);
          },
          rename: async (from, to) => {
            await rename(from, to);
            if (!committed && to === configPath) {
              committed = true;
              env.OPENCLAW_CONFIG_PATH = otherConfigPath;
            }
          },
        },
      } as typeof fsNode;
      const io = createConfigIO({ env, fs: injectedFs, homedir: () => home, logger: silentLogger });
      const prepared = await io.readConfigFileSnapshotForWrite();

      await expect(
        io.writeConfigFile(
          { gateway: { mode: "local", port: 19001 } },
          {
            baseSnapshot: prepared.snapshot,
            ...prepared.writeOptions,
          },
        ),
      ).rejects.toThrow("config path changed since last load");

      expect(rollbackReadUsedInjectedFs).toBe(true);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(initialRaw);
    });
  });

  it("persists explicit default-valued paths through the exported write wrapper", async () => {
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "demo",
          origin: "bundled",
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          rootDir: "/tmp/openclaw-test-demo",
          source: "/tmp/openclaw-test-demo/index.ts",
          manifestPath: "/tmp/openclaw-test-demo/openclaw.plugin.json",
          configSchema: {
            type: "object",
            properties: {
              mode: { type: "string", default: "auto" },
            },
            additionalProperties: true,
          },
        },
      ],
    } satisfies PluginManifestRegistry);

    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const sourceConfig = {
        gateway: { mode: "local" },
        plugins: { entries: { demo: { enabled: true, config: {} } } },
      } satisfies ConfigFileSnapshot["sourceConfig"];
      await fs.writeFile(configPath, `${JSON.stringify(sourceConfig, null, 2)}\n`, "utf-8");
      const runtimeConfig = {
        ...structuredClone(sourceConfig),
        plugins: {
          entries: {
            demo: { enabled: true, config: { mode: "auto" } },
          },
        },
      } satisfies ConfigFileSnapshot["config"];

      try {
        await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
          setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

          await writeConfigFile(runtimeConfig, {
            explicitSetPaths: [["plugins", "entries", "demo", "config"]],
          });

          const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as OpenClawConfig;
          expect(persisted.plugins?.entries?.demo?.config).toStrictEqual({ mode: "auto" });
        });
      } finally {
        mockLoadPluginManifestRegistry.mockReturnValue({
          diagnostics: [],
          plugins: [],
        } satisfies PluginManifestRegistry);
      }
    });
  });

  it("skipPluginValidation bypasses plugin schema rejection on writeConfigFile (#76800)", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, "{}\n", "utf-8");
      mockLoadPluginManifestRegistry.mockReturnValue({
        diagnostics: [],
        plugins: [
          {
            id: "strict-plugin",
            origin: "bundled",
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            rootDir: "/tmp/openclaw-test-strict-plugin",
            source: "/tmp/openclaw-test-strict-plugin/index.ts",
            manifestPath: "/tmp/openclaw-test-strict-plugin/openclaw.plugin.json",
            configSchema: {
              type: "object",
              properties: { token: { type: "string" } },
              required: ["token"],
              additionalProperties: false,
            },
          },
        ],
      } satisfies PluginManifestRegistry);

      try {
        // Plugin is enabled but missing required "token" — validation fails without skip.
        const cfg: OpenClawConfig = {
          agents: { list: [{ id: "main", default: true }] },
          plugins: { entries: { "strict-plugin": { enabled: true } } },
        };

        await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
          await writeConfigFile(cfg, { skipPluginValidation: true });
          await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"strict-plugin"');

          await expect(writeConfigFile(cfg, { skipPluginValidation: false })).rejects.toThrow(
            /Config validation failed/,
          );
          await expect(
            writeConfigFile({ agents: { list: "not-array" } } as unknown as OpenClawConfig, {
              skipPluginValidation: true,
            }),
          ).rejects.toThrow(/Config validation failed/);
        });
      } finally {
        mockLoadPluginManifestRegistry.mockReturnValue({
          diagnostics: [],
          plugins: [],
        } satisfies PluginManifestRegistry);
      }
    });
  });

  it("preserves authored tilde paths when runtime-shaped writes hand back absolute paths", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            logging: { file: "~/openclaw-upgrade-survivor/gateway.jsonl" },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();

      await io.writeConfigFile(
        {
          logging: {
            file: path.join(home, "openclaw-upgrade-survivor", "gateway.jsonl"),
            level: "debug",
          },
        },
        { baseSnapshot: snapshot },
      );

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as OpenClawConfig;
      expect(persisted.logging?.file).toBe("~/openclaw-upgrade-survivor/gateway.jsonl");
      expect(persisted.logging?.level).toBe("debug");
    });
  });
});
