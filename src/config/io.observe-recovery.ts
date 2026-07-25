// Observes and recovers config files that appear missing, corrupt, or clobbered.
import crypto from "node:crypto";
import { isRecord } from "../utils.js";
import {
  appendConfigAuditRecord,
  appendConfigAuditRecordSync,
  snapshotConfigAuditProcessInfo,
  type ConfigObserveAuditRecord,
} from "./io.audit.js";
import {
  persistBoundedClobberedConfigSnapshot,
  persistBoundedClobberedConfigSnapshotSync,
} from "./io.clobber-snapshot.js";
import {
  readConfigHealthStateFromStore,
  writeConfigHealthStateToStore,
  type ConfigHealthEntry,
  type ConfigHealthFingerprint,
  type ConfigHealthState,
} from "./io.health-state.js";
import { resolveConfigObserveSuspiciousReasons } from "./io.observe-suspicious.js";
import { formatConfigIssueSummary } from "./issue-format.js";
import {
  isPluginLocalInvalidConfigSnapshot,
  shouldAttemptLastKnownGoodRecovery,
} from "./recovery-policy.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

/** Dependencies injected into config recovery observation for testable filesystem behavior. */
export type ObserveRecoveryDeps = {
  fs: {
    promises: {
      stat(path: string): Promise<{
        mtimeMs?: number;
        ctimeMs?: number;
        dev?: number | bigint;
        ino?: number | bigint;
        mode?: number;
        nlink?: number;
        uid?: number;
        gid?: number;
      } | null>;
      readFile(path: string, encoding: BufferEncoding): Promise<string>;
      writeFile(
        path: string,
        data: string,
        options?: { encoding?: BufferEncoding; mode?: number; flag?: string },
      ): Promise<unknown>;
      copyFile(src: string, dest: string): Promise<unknown>;
      chmod?(path: string, mode: number): Promise<unknown>;
      mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
      readdir(path: string): Promise<string[]>;
      rmdir(path: string): Promise<unknown>;
      unlink(path: string): Promise<unknown>;
      appendFile(
        path: string,
        data: string,
        options?: { encoding?: BufferEncoding; mode?: number },
      ): Promise<unknown>;
    };
    statSync(
      path: string,
      options?: { throwIfNoEntry?: boolean },
    ): {
      mtimeMs?: number;
      ctimeMs?: number;
      dev?: number | bigint;
      ino?: number | bigint;
      mode?: number;
      nlink?: number;
      uid?: number;
      gid?: number;
    } | null;
    readFileSync(path: string, encoding: BufferEncoding): string;
    writeFileSync(
      path: string,
      data: string,
      options?: { encoding?: BufferEncoding; mode?: number; flag?: string },
    ): unknown;
    copyFileSync(src: string, dest: string): unknown;
    chmodSync?(path: string, mode: number): unknown;
    mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): unknown;
    readdirSync(path: string): string[];
    rmdirSync(path: string): unknown;
    unlinkSync(path: string): unknown;
    appendFileSync(
      path: string,
      data: string,
      options?: { encoding?: BufferEncoding; mode?: number },
    ): unknown;
  };
  json5: { parse(value: string): unknown };
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  logger: Pick<typeof console, "warn">;
};

type ConfigStatMetadataSource =
  | ({
      mtimeMs?: number;
      ctimeMs?: number;
      dev?: number | bigint;
      ino?: number | bigint;
      mode?: number;
      nlink?: number;
      uid?: number;
      gid?: number;
    } & Record<string, unknown>)
  | null;

type ConfigReadRecoveryParams = {
  deps: ObserveRecoveryDeps;
  configPath: string;
  raw: string;
  parsed: unknown;
  /**
   * Runtime validity gate. Receives the candidate's source (`last-good` or
   * backup) so the validator can reject a stale `.last-good` snapshot from an
   * older release while still accepting a current-release `.bak`. The
   * validator is invoked for BOTH candidates; rejection of `.last-good`
   * causes the picker to fall back to `.bak`, rejection of `.bak` aborts
   * recovery. Keep the validator side-effect free.
   */
  validateBackup?: (backup: {
    source: "last-good" | "backup";
    path: string;
    raw: string;
    parsed: unknown;
  }) => Promise<boolean>;
  validateBackupSync?: (backup: {
    source: "last-good" | "backup";
    path: string;
    raw: string;
    parsed: unknown;
  }) => boolean;
  allowBackupRecovery?: () => Promise<boolean>;
};

type ConfigReadRecoveryResult = {
  raw: string;
  parsed: unknown;
};

function createConfigObserveAuditRecord(params: {
  ts: string;
  configPath: string;
  valid: boolean;
  current: ConfigHealthFingerprint;
  suspicious: string[];
  lastKnownGood: ConfigHealthFingerprint | undefined;
  backup: ConfigHealthFingerprint | null | undefined;
  clobberedPath: string | null;
  restoredFromBackup: boolean;
  restoredBackupPath: string | null;
  restoreErrorCode?: string | null;
  restoreErrorMessage?: string | null;
}): ConfigObserveAuditRecord {
  return {
    ts: params.ts,
    source: "config-io",
    event: "config.observe",
    phase: "read",
    configPath: params.configPath,
    ...snapshotConfigAuditProcessInfo(),
    exists: true,
    valid: params.valid,
    hash: params.current.hash,
    bytes: params.current.bytes,
    mtimeMs: params.current.mtimeMs,
    ctimeMs: params.current.ctimeMs,
    dev: params.current.dev,
    ino: params.current.ino,
    mode: params.current.mode,
    nlink: params.current.nlink,
    uid: params.current.uid,
    gid: params.current.gid,
    hasMeta: params.current.hasMeta,
    gatewayMode: params.current.gatewayMode,
    suspicious: params.suspicious,
    lastKnownGoodHash: params.lastKnownGood?.hash ?? null,
    lastKnownGoodBytes: params.lastKnownGood?.bytes ?? null,
    lastKnownGoodMtimeMs: params.lastKnownGood?.mtimeMs ?? null,
    lastKnownGoodCtimeMs: params.lastKnownGood?.ctimeMs ?? null,
    lastKnownGoodDev: params.lastKnownGood?.dev ?? null,
    lastKnownGoodIno: params.lastKnownGood?.ino ?? null,
    lastKnownGoodMode: params.lastKnownGood?.mode ?? null,
    lastKnownGoodNlink: params.lastKnownGood?.nlink ?? null,
    lastKnownGoodUid: params.lastKnownGood?.uid ?? null,
    lastKnownGoodGid: params.lastKnownGood?.gid ?? null,
    lastKnownGoodGatewayMode: params.lastKnownGood?.gatewayMode ?? null,
    backupHash: params.backup?.hash ?? null,
    backupBytes: params.backup?.bytes ?? null,
    backupMtimeMs: params.backup?.mtimeMs ?? null,
    backupCtimeMs: params.backup?.ctimeMs ?? null,
    backupDev: params.backup?.dev ?? null,
    backupIno: params.backup?.ino ?? null,
    backupMode: params.backup?.mode ?? null,
    backupNlink: params.backup?.nlink ?? null,
    backupUid: params.backup?.uid ?? null,
    backupGid: params.backup?.gid ?? null,
    backupGatewayMode: params.backup?.gatewayMode ?? null,
    clobberedPath: params.clobberedPath,
    restoredFromBackup: params.restoredFromBackup,
    restoredBackupPath: params.restoredBackupPath,
    restoreErrorCode: params.restoreErrorCode ?? null,
    restoreErrorMessage: params.restoreErrorMessage ?? null,
  };
}

type ConfigObserveAuditRecordParams = Parameters<typeof createConfigObserveAuditRecord>[0];

function createConfigObserveAuditAppendParams(
  deps: ObserveRecoveryDeps,
  params: ConfigObserveAuditRecordParams,
) {
  return {
    fs: deps.fs,
    env: deps.env,
    homedir: deps.homedir,
    record: createConfigObserveAuditRecord(params),
  };
}

function extractRestoreErrorDetails(error: unknown): {
  code: string | null;
  message: string | null;
} {
  if (!error || typeof error !== "object") {
    return { code: null, message: typeof error === "string" ? error : null };
  }
  const code =
    "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : null;
  const message =
    "message" in error && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : null;
  return { code, message };
}

function hashConfigRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

function resolveConfigSnapshotHash(snapshot: {
  hash?: string;
  raw?: string | null;
}): string | null {
  if (typeof snapshot.hash === "string") {
    const trimmed = snapshot.hash.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  if (typeof snapshot.raw !== "string") {
    return null;
  }
  return hashConfigRaw(snapshot.raw);
}

function hasConfigMeta(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.meta) &&
    (typeof value.meta.lastTouchedVersion === "string" ||
      typeof value.meta.lastTouchedAt === "string")
  );
}

function resolveGatewayMode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.gateway)) {
    return null;
  }
  return typeof value.gateway.mode === "string" ? value.gateway.mode : null;
}

function resolveConfigStatMetadata(stat: ConfigStatMetadataSource): {
  dev: string | null;
  ino: string | null;
  mode: number | null;
  nlink: number | null;
  uid: number | null;
  gid: number | null;
} {
  if (!stat) {
    return {
      dev: null,
      ino: null,
      mode: null,
      nlink: null,
      uid: null,
      gid: null,
    };
  }
  return {
    dev: typeof stat.dev === "number" || typeof stat.dev === "bigint" ? String(stat.dev) : null,
    ino: typeof stat.ino === "number" || typeof stat.ino === "bigint" ? String(stat.ino) : null,
    mode: typeof stat.mode === "number" ? stat.mode : null,
    nlink: typeof stat.nlink === "number" ? stat.nlink : null,
    uid: typeof stat.uid === "number" ? stat.uid : null,
    gid: typeof stat.gid === "number" ? stat.gid : null,
  };
}

function createConfigHealthFingerprint(params: {
  hash: string;
  raw: string;
  parsed: unknown;
  gatewaySource: unknown;
  stat: ConfigStatMetadataSource;
  observedAt: string;
}): ConfigHealthFingerprint {
  return {
    hash: params.hash,
    bytes: Buffer.byteLength(params.raw, "utf-8"),
    mtimeMs: params.stat?.mtimeMs ?? null,
    ctimeMs: params.stat?.ctimeMs ?? null,
    ...resolveConfigStatMetadata(params.stat),
    hasMeta: hasConfigMeta(params.parsed),
    gatewayMode: resolveGatewayMode(params.gatewaySource),
    observedAt: params.observedAt,
  };
}

function parseConfigRawOrEmpty(deps: ObserveRecoveryDeps, raw: string): unknown {
  try {
    return deps.json5.parse(raw);
  } catch {
    return {};
  }
}

function returnOriginalConfigRead(params: ConfigReadRecoveryParams): ConfigReadRecoveryResult {
  return { raw: params.raw, parsed: params.parsed };
}

async function readConfigHealthState(deps: ObserveRecoveryDeps): Promise<ConfigHealthState> {
  return readConfigHealthStateFromStore(deps);
}

function readConfigHealthStateSync(deps: ObserveRecoveryDeps): ConfigHealthState {
  return readConfigHealthStateFromStore(deps);
}

async function writeConfigHealthState(
  deps: ObserveRecoveryDeps,
  state: ConfigHealthState,
): Promise<void> {
  writeConfigHealthStateToStore(deps, state);
}

function writeConfigHealthStateSync(deps: ObserveRecoveryDeps, state: ConfigHealthState): void {
  writeConfigHealthStateToStore(deps, state);
}

type VerifiedRecoveryCandidate = {
  source: "last-good" | "backup";
  path: string;
  raw: string;
  parsed: unknown;
  fingerprint: ConfigHealthFingerprint;
};

type RecoveryCandidateCommon = {
  deps: ObserveRecoveryDeps;
  source: "last-good" | "backup";
  path: string;
  raw: string;
  // Hash from `entry.lastPromotedGood.hash`. When set, the candidate raw must
  // hash-match. Absence is treated as "no integrity record" — the candidate is
  // rejected because we cannot prove it was a verified-good promotion.
  requiredHash?: string;
  // Caller-level policy: some callers (e.g. small valid clobbers outside the
  // gateway-mode-missing path) do not require a `gateway.mode` value.
  requireGatewayMode: boolean;
  now: string;
};

/**
 * Validates a single raw candidate before it is allowed to overwrite the main
 * config. A candidate is accepted only when every check passes; the rejection
 * reason is logged so the caller can pick the next candidate.
 *
 * Checks, in order:
 *   1. JSON5 parse
 *   2. Hash match against `entry.lastPromotedGood.hash` (when present)
 *   3. No redacted/polluted secret placeholders
 *   4. `gateway.mode` present (when required by the caller)
 *
 * The caller still owns the optional `validateBackup` runtime gate, because
 * its async/sync dispatch differs. The gate is applied to BOTH `.last-good`
 * and `.bak` candidates — `.last-good` is verified-good at promotion time,
 * but the runtime's notion of "good" can change between releases, so a
 * stale snapshot from an older version must still pass current validation
 * before it can overwrite the main config.
 */
function verifyRecoveryCandidate(
  params: RecoveryCandidateCommon,
): VerifiedRecoveryCandidate | null {
  let parsed: unknown;
  try {
    parsed = params.deps.json5.parse(params.raw);
  } catch {
    params.deps.logger.warn(
      `Config recovery skipped ${params.source} at ${params.path}: invalid JSON5`,
    );
    return null;
  }
  if (params.requiredHash) {
    const hash = hashConfigRaw(params.raw);
    if (hash !== params.requiredHash) {
      params.deps.logger.warn(
        `Config recovery skipped ${params.source} at ${params.path}: hash does not match lastPromotedGood`,
      );
      return null;
    }
  }
  const polluted = collectPollutedSecretPlaceholders(parsed);
  if (polluted.length > 0) {
    params.deps.logger.warn(
      `Config recovery skipped ${params.source} at ${params.path}: redacted secret placeholder at ${polluted[0]}`,
    );
    return null;
  }
  const fingerprint = createConfigHealthFingerprint({
    hash: hashConfigRaw(params.raw),
    raw: params.raw,
    parsed,
    gatewaySource: parsed,
    stat: null,
    observedAt: params.now,
  });
  if (params.requireGatewayMode && !fingerprint.gatewayMode) {
    return null;
  }
  return {
    source: params.source,
    path: params.path,
    raw: params.raw,
    parsed,
    fingerprint,
  };
}

type PickVerifiedCandidateAsyncParams = {
  deps: ObserveRecoveryDeps;
  now: string;
  lastGoodPath: string;
  lastGoodRaw: string | null;
  requiredLastGoodHash: string | undefined;
  backupPath: string;
  backupRaw: string | null;
  requireGatewayMode: boolean;
  validateBackup?: (backup: {
    source: "last-good" | "backup";
    path: string;
    raw: string;
    parsed: unknown;
  }) => Promise<boolean>;
};

type PickVerifiedCandidateSyncParams = {
  deps: ObserveRecoveryDeps;
  now: string;
  lastGoodPath: string;
  lastGoodRaw: string | null;
  requiredLastGoodHash: string | undefined;
  backupPath: string;
  backupRaw: string | null;
  requireGatewayMode: boolean;
  validateBackupSync?: (backup: {
    source: "last-good" | "backup";
    path: string;
    raw: string;
    parsed: unknown;
  }) => boolean;
};

/**
 * Picks the first verified recovery candidate. `.last-good` is preferred
 * because it is only ever written after a verified-good promotion; we require
 * its raw hash to match `entry.lastPromotedGood.hash` so a corrupted or
 * doctor-shrunken `.last-good` file cannot silently overwrite the main config.
 *
 * If `entry.lastPromotedGood.hash` is missing, `.last-good` is treated as
 * untrustworthy and we skip straight to `.bak` — the same invariant that
 * `recoverConfigFromLastKnownGood` enforces. This avoids letting a `.last-good`
 * file placed by an external party (or by a partial doctor pass) bypass the
 * size-drop guard.
 *
 * `.bak` is used as a fallback for users on older installs that never wrote a
 * `.last-good`. It is also reached when `.last-good` exists but is corrupt,
 * hash-mismatched, polluted, or missing the required `gateway.mode` shape.
 *
 * The runtime `validateBackup` gate is applied to BOTH candidates — a
 * `.last-good` file was verified-good at promotion time, but the runtime's
 * notion of "good" can change between releases, so a stale snapshot from an
 * older version must still pass current validation before it can overwrite
 * the main config.
 */
async function pickVerifiedRecoveryCandidateAsync(
  params: PickVerifiedCandidateAsyncParams,
): Promise<VerifiedRecoveryCandidate | null> {
  if (params.requiredLastGoodHash && params.lastGoodRaw != null && params.lastGoodRaw !== "") {
    const lastGood = verifyRecoveryCandidate({
      deps: params.deps,
      source: "last-good",
      path: params.lastGoodPath,
      raw: params.lastGoodRaw,
      requiredHash: params.requiredLastGoodHash,
      requireGatewayMode: params.requireGatewayMode,
      now: params.now,
    });
    if (lastGood) {
      if (params.validateBackup) {
        const approved = await params.validateBackup({
          source: "last-good",
          path: params.lastGoodPath,
          raw: lastGood.raw,
          parsed: lastGood.parsed,
        });
        if (!approved) {
          params.deps.logger.warn(
            `Config recovery skipped last-good at ${params.lastGoodPath}: runtime validation rejected it`,
          );
        } else {
          return lastGood;
        }
      } else {
        return lastGood;
      }
    }
  }
  if (params.backupRaw != null && params.backupRaw !== "") {
    const backup = verifyRecoveryCandidate({
      deps: params.deps,
      source: "backup",
      path: params.backupPath,
      raw: params.backupRaw,
      requireGatewayMode: params.requireGatewayMode,
      now: params.now,
    });
    if (backup && params.validateBackup) {
      const approved = await params.validateBackup({
        source: "backup",
        path: params.backupPath,
        raw: backup.raw,
        parsed: backup.parsed,
      });
      if (!approved) {
        return null;
      }
    }
    if (backup) {
      return backup;
    }
  }
  return null;
}

function pickVerifiedRecoveryCandidateSync(
  params: PickVerifiedCandidateSyncParams,
): VerifiedRecoveryCandidate | null {
  if (params.requiredLastGoodHash && params.lastGoodRaw != null && params.lastGoodRaw !== "") {
    const lastGood = verifyRecoveryCandidate({
      deps: params.deps,
      source: "last-good",
      path: params.lastGoodPath,
      raw: params.lastGoodRaw,
      requiredHash: params.requiredLastGoodHash,
      requireGatewayMode: params.requireGatewayMode,
      now: params.now,
    });
    if (lastGood) {
      if (params.validateBackupSync) {
        const approved = params.validateBackupSync({
          source: "last-good",
          path: params.lastGoodPath,
          raw: lastGood.raw,
          parsed: lastGood.parsed,
        });
        if (!approved) {
          params.deps.logger.warn(
            `Config recovery skipped last-good at ${params.lastGoodPath}: runtime validation rejected it`,
          );
        } else {
          return lastGood;
        }
      } else {
        return lastGood;
      }
    }
  }
  if (params.backupRaw != null && params.backupRaw !== "") {
    const backup = verifyRecoveryCandidate({
      deps: params.deps,
      source: "backup",
      path: params.backupPath,
      raw: params.backupRaw,
      requireGatewayMode: params.requireGatewayMode,
      now: params.now,
    });
    if (backup && params.validateBackupSync) {
      const approved = params.validateBackupSync({
        source: "backup",
        path: params.backupPath,
        raw: backup.raw,
        parsed: backup.parsed,
      });
      if (!approved) {
        return null;
      }
    }
    if (backup) {
      return backup;
    }
  }
  return null;
}

function getConfigHealthEntry(state: ConfigHealthState, configPath: string): ConfigHealthEntry {
  const entries = state.entries;
  if (!entries || !isRecord(entries)) {
    return {};
  }
  const entry = entries[configPath];
  return entry && isRecord(entry) ? entry : {};
}

function setConfigHealthEntry(
  state: ConfigHealthState,
  configPath: string,
  entry: ConfigHealthEntry,
): ConfigHealthState {
  return {
    ...state,
    entries: {
      ...state.entries,
      [configPath]: entry,
    },
  };
}

function createLastObservedSuspiciousEntry(
  entry: ConfigHealthEntry,
  suspiciousSignature: string,
): ConfigHealthEntry {
  return {
    ...entry,
    lastObservedSuspiciousSignature: suspiciousSignature,
  };
}

function createRecoveredSuspiciousHealthState(params: {
  healthState: ConfigHealthState;
  configPath: string;
  entry: ConfigHealthEntry;
  suspiciousSignature: string;
}): ConfigHealthState {
  return setConfigHealthEntry(
    params.healthState,
    params.configPath,
    createLastObservedSuspiciousEntry(params.entry, params.suspiciousSignature),
  );
}

function logBackupRestoreResult(params: {
  deps: ObserveRecoveryDeps;
  configPath: string;
  restoredSourcePath: string | null;
  suspicious: string[];
  restoredFromBackup: boolean;
  restoreErrorMessage: string | null;
}): void {
  const sourceLabel = params.restoredSourcePath?.endsWith(".last-good")
    ? "last-known-good"
    : "backup";
  if (params.restoredFromBackup) {
    params.deps.logger.warn(
      `Config auto-restored from ${sourceLabel}: ${params.configPath} (${params.suspicious.join(", ")})`,
    );
    return;
  }
  params.deps.logger.warn(
    `Config auto-restore from ${sourceLabel} failed: ${params.configPath} (${params.suspicious.join(", ")}${
      params.restoreErrorMessage ? `; ${params.restoreErrorMessage}` : ""
    })`,
  );
}

function createBackupRestoreAuditAppendParams(params: {
  deps: ObserveRecoveryDeps;
  now: string;
  configPath: string;
  restoredFromBackup: boolean;
  current: ConfigHealthFingerprint;
  suspicious: string[];
  entry: ConfigHealthEntry;
  backup: ConfigHealthFingerprint | null | undefined;
  clobberedPath: string | null;
  backupPath: string;
  restoreErrorDetails: { code: string | null; message: string | null };
}) {
  return createConfigObserveAuditAppendParams(params.deps, {
    ts: params.now,
    configPath: params.configPath,
    valid: params.restoredFromBackup,
    current: params.current,
    suspicious: params.suspicious,
    lastKnownGood: params.entry.lastKnownGood,
    backup: params.backup,
    clobberedPath: params.clobberedPath,
    restoredFromBackup: params.restoredFromBackup,
    restoredBackupPath: params.backupPath,
    restoreErrorCode: params.restoreErrorDetails.code,
    restoreErrorMessage: params.restoreErrorDetails.message,
  });
}

function resolveSuspiciousSignature(
  current: ConfigHealthFingerprint,
  suspicious: string[],
): string {
  return `${current.hash}:${suspicious.join(",")}`;
}

function isRecoverableConfigReadSuspiciousReason(reason: string): boolean {
  return (
    reason === "missing-meta-vs-last-good" ||
    reason === "gateway-mode-missing-vs-last-good" ||
    reason === "update-channel-only-root" ||
    reason.startsWith("size-drop-vs-last-good:")
  );
}

function resolveConfigReadRecoveryContext(params: {
  current: ConfigHealthFingerprint;
  parsed: unknown;
  entry: ConfigHealthEntry;
  backupBaseline?: ConfigHealthFingerprint;
}): { suspicious: string[]; suspiciousSignature: string } | null {
  const suspicious = resolveConfigObserveSuspiciousReasons({
    bytes: params.current.bytes,
    hasMeta: params.current.hasMeta,
    gatewayMode: params.current.gatewayMode,
    parsed: params.parsed,
    lastKnownGood: params.backupBaseline,
  });
  if (!suspicious.some(isRecoverableConfigReadSuspiciousReason)) {
    return null;
  }
  const suspiciousSignature = resolveSuspiciousSignature(params.current, suspicious);
  if (params.entry.lastObservedSuspiciousSignature === suspiciousSignature) {
    return null;
  }
  return { suspicious, suspiciousSignature };
}

async function readConfigFingerprintForPath(
  deps: ObserveRecoveryDeps,
  targetPath: string,
  requiredHash?: string | null,
): Promise<ConfigHealthFingerprint | null> {
  try {
    const raw = await deps.fs.promises.readFile(targetPath, "utf-8");
    const actualHash = hashConfigRaw(raw);
    if (requiredHash && actualHash !== requiredHash) {
      deps.logger.warn(
        `Config recovery baseline skipped ${targetPath}: file hash does not match expected hash`,
      );
      return null;
    }
    const stat = await deps.fs.promises.stat(targetPath).catch(() => null);
    const parsed = parseConfigRawOrEmpty(deps, raw);
    return createConfigHealthFingerprint({
      hash: actualHash,
      raw,
      parsed,
      gatewaySource: parsed,
      stat: stat as ConfigStatMetadataSource,
      observedAt: new Date().toISOString(),
    });
  } catch {
    return null;
  }
}

function readConfigFingerprintForPathSync(
  deps: ObserveRecoveryDeps,
  targetPath: string,
  requiredHash?: string | null,
): ConfigHealthFingerprint | null {
  try {
    const raw = deps.fs.readFileSync(targetPath, "utf-8");
    const actualHash = hashConfigRaw(raw);
    if (requiredHash && actualHash !== requiredHash) {
      deps.logger.warn(
        `Config recovery baseline skipped ${targetPath}: file hash does not match expected hash`,
      );
      return null;
    }
    const stat = deps.fs.statSync(targetPath, { throwIfNoEntry: false }) ?? null;
    const parsed = parseConfigRawOrEmpty(deps, raw);
    return createConfigHealthFingerprint({
      hash: actualHash,
      raw,
      parsed,
      gatewaySource: parsed,
      stat,
      observedAt: new Date().toISOString(),
    });
  } catch {
    return null;
  }
}

export function resolveLastKnownGoodConfigPath(configPath: string): string {
  return `${configPath}.last-good`;
}

function isSensitiveConfigPath(pathLabel: string): boolean {
  return /(^|\.)(api[-_]?key|auth|bearer|credential|password|private[-_]?key|secret|token)(\.|$)/i.test(
    pathLabel,
  );
}

function collectPollutedSecretPlaceholders(
  value: unknown,
  pathLabel = "",
  output: string[] = [],
): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "***" || trimmed === "[redacted]") {
      output.push(pathLabel || "<root>");
      return output;
    }
    if (isSensitiveConfigPath(pathLabel) && (trimmed.includes("...") || trimmed.includes("…"))) {
      output.push(pathLabel || "<root>");
    }
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectPollutedSecretPlaceholders(item, `${pathLabel}[${index}]`, output),
    );
    return output;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = pathLabel ? `${pathLabel}.${key}` : key;
      collectPollutedSecretPlaceholders(child, childPath, output);
    }
  }
  return output;
}

export async function maybeRecoverSuspiciousConfigRead(
  params: ConfigReadRecoveryParams,
): Promise<ConfigReadRecoveryResult> {
  const stat = await params.deps.fs.promises.stat(params.configPath).catch(() => null);
  const now = new Date().toISOString();
  const current = createConfigHealthFingerprint({
    hash: hashConfigRaw(params.raw),
    raw: params.raw,
    parsed: params.parsed,
    gatewaySource: params.parsed,
    stat: stat as ConfigStatMetadataSource,
    observedAt: now,
  });

  let healthState = await readConfigHealthState(params.deps);
  const entry = getConfigHealthEntry(healthState, params.configPath);
  const lastGoodPath = resolveLastKnownGoodConfigPath(params.configPath);
  const backupPath = `${params.configPath}.bak`;
  // The recovery baseline is separate from the restore source. We use the
  // most recent verified-good fingerprint (entry.lastKnownGood, fallback to
  // a freshly-read `.last-good` or `.bak`) to decide whether the current read
  // is suspicious. The actual restore source is picked by `pickVerifiedCandidate`
  // below and is never trusted by the baseline alone.
  //
  // The `.last-good` baseline is gated against `entry.lastPromotedGood.hash`
  // so an attacker-supplied `.last-good` file cannot silently widen the
  // suspicious threshold or trigger a false-positive recovery. When no
  // promoted-good hash exists (the very first run before any verification
  // has happened), we must NOT use `.last-good` as a baseline at all —
  // there is nothing to compare against, and trusting a freshly-supplied
  // file would let an attacker reset the suspicious threshold. The `.bak`
  // fallback has no stored hash so it remains unverified, but it is only
  // used as a last resort if no verified baseline exists.
  const requiredLastGoodHash = entry.lastPromotedGood?.hash;
  const baselineFromLastGood = requiredLastGoodHash
    ? await readConfigFingerprintForPath(params.deps, lastGoodPath, requiredLastGoodHash)
    : null;
  const baselineFromBackup = await readConfigFingerprintForPath(params.deps, backupPath);
  const backupBaseline =
    entry.lastKnownGood ?? baselineFromLastGood ?? baselineFromBackup ?? undefined;
  const recoveryContext = resolveConfigReadRecoveryContext({
    current,
    parsed: params.parsed,
    entry,
    backupBaseline,
  });
  if (!recoveryContext) {
    return returnOriginalConfigRead(params);
  }
  const { suspicious, suspiciousSignature } = recoveryContext;
  const lastGoodRaw = await params.deps.fs.promises
    .readFile(lastGoodPath, "utf-8")
    .catch(() => null);
  const backupRaw = await params.deps.fs.promises.readFile(backupPath, "utf-8").catch(() => null);

  const candidate = await pickVerifiedRecoveryCandidateAsync({
    deps: params.deps,
    now,
    lastGoodPath,
    lastGoodRaw,
    requiredLastGoodHash,
    backupPath,
    backupRaw,
    requireGatewayMode: true,
    validateBackup: params.validateBackup,
  });
  if (!candidate) {
    return returnOriginalConfigRead(params);
  }
  if (params.allowBackupRecovery && !(await params.allowBackupRecovery())) {
    return returnOriginalConfigRead(params);
  }

  const clobberedPath = await persistBoundedClobberedConfigSnapshot({
    deps: params.deps,
    configPath: params.configPath,
    raw: params.raw,
    observedAt: now,
  });

  let restoredFromBackup = false;
  let restoreError: unknown;
  try {
    await params.deps.fs.promises.writeFile(params.configPath, candidate.raw, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await params.deps.fs.promises.chmod?.(params.configPath, 0o600).catch(() => {});
    restoredFromBackup = true;
  } catch (error) {
    restoreError = error;
  }

  const restoreErrorDetails = restoredFromBackup
    ? { code: null, message: null }
    : extractRestoreErrorDetails(restoreError);

  logBackupRestoreResult({
    deps: params.deps,
    configPath: params.configPath,
    restoredSourcePath: candidate.path,
    suspicious,
    restoredFromBackup,
    restoreErrorMessage: restoreErrorDetails.message,
  });
  await appendConfigAuditRecord(
    createBackupRestoreAuditAppendParams({
      deps: params.deps,
      now,
      configPath: params.configPath,
      restoredFromBackup,
      current,
      suspicious,
      entry,
      backup: candidate.fingerprint,
      clobberedPath,
      backupPath: candidate.path,
      restoreErrorDetails,
    }),
  );

  if (restoredFromBackup) {
    healthState = createRecoveredSuspiciousHealthState({
      healthState,
      configPath: params.configPath,
      entry,
      suspiciousSignature,
    });
    await writeConfigHealthState(params.deps, healthState);
  }
  return { raw: candidate.raw, parsed: candidate.parsed };
}

export function maybeRecoverSuspiciousConfigReadSync(
  params: ConfigReadRecoveryParams,
): ConfigReadRecoveryResult {
  const stat = params.deps.fs.statSync(params.configPath, { throwIfNoEntry: false }) ?? null;
  const now = new Date().toISOString();
  const current = createConfigHealthFingerprint({
    hash: hashConfigRaw(params.raw),
    raw: params.raw,
    parsed: params.parsed,
    gatewaySource: params.parsed,
    stat,
    observedAt: now,
  });

  let healthState = readConfigHealthStateSync(params.deps);
  const entry = getConfigHealthEntry(healthState, params.configPath);
  const lastGoodPath = resolveLastKnownGoodConfigPath(params.configPath);
  const backupPath = `${params.configPath}.bak`;
  // Mirror the async path: the baseline is the most recent verified-good
  // fingerprint we can find, not the restore source. The restore source is
  // picked by `pickVerifiedCandidateSync` and is never trusted by the
  // baseline alone.
  //
  // The `.last-good` baseline is gated against `entry.lastPromotedGood.hash`
  // so an attacker-supplied `.last-good` file cannot silently widen the
  // suspicious threshold or trigger a false-positive recovery. When no
  // promoted-good hash exists (the very first run before any verification
  // has happened), we must NOT use `.last-good` as a baseline at all —
  // there is nothing to compare against, and trusting a freshly-supplied
  // file would let an attacker reset the suspicious threshold. The `.bak`
  // fallback has no stored hash so it remains unverified, but it is only
  // used as a last resort if no verified baseline exists.
  const requiredLastGoodHash = entry.lastPromotedGood?.hash;
  const baselineFromLastGood = requiredLastGoodHash
    ? readConfigFingerprintForPathSync(params.deps, lastGoodPath, requiredLastGoodHash)
    : null;
  const baselineFromBackup = readConfigFingerprintForPathSync(params.deps, backupPath);
  const backupBaseline =
    entry.lastKnownGood ?? baselineFromLastGood ?? baselineFromBackup ?? undefined;
  const recoveryContext = resolveConfigReadRecoveryContext({
    current,
    parsed: params.parsed,
    entry,
    backupBaseline,
  });
  if (!recoveryContext) {
    return returnOriginalConfigRead(params);
  }
  const { suspicious, suspiciousSignature } = recoveryContext;
  let lastGoodRaw: string | null = null;
  try {
    lastGoodRaw = params.deps.fs.readFileSync(lastGoodPath, "utf-8");
  } catch {}
  let backupRaw: string | null = null;
  try {
    backupRaw = params.deps.fs.readFileSync(backupPath, "utf-8");
  } catch {}

  const candidate = pickVerifiedRecoveryCandidateSync({
    deps: params.deps,
    now,
    lastGoodPath,
    lastGoodRaw,
    requiredLastGoodHash,
    backupPath,
    backupRaw,
    requireGatewayMode: true,
    validateBackupSync: params.validateBackupSync,
  });
  if (!candidate) {
    return returnOriginalConfigRead(params);
  }

  const clobberedPath = persistBoundedClobberedConfigSnapshotSync({
    deps: params.deps,
    configPath: params.configPath,
    raw: params.raw,
    observedAt: now,
  });

  let restoredFromBackup = false;
  let restoreError: unknown;
  try {
    params.deps.fs.writeFileSync(params.configPath, candidate.raw, {
      encoding: "utf-8",
      mode: 0o600,
    });
    try {
      params.deps.fs.chmodSync?.(params.configPath, 0o600);
    } catch {}
    restoredFromBackup = true;
  } catch (error) {
    restoreError = error;
  }

  const restoreErrorDetails = restoredFromBackup
    ? { code: null, message: null }
    : extractRestoreErrorDetails(restoreError);

  logBackupRestoreResult({
    deps: params.deps,
    configPath: params.configPath,
    restoredSourcePath: candidate.path,
    suspicious,
    restoredFromBackup,
    restoreErrorMessage: restoreErrorDetails.message,
  });
  appendConfigAuditRecordSync(
    createBackupRestoreAuditAppendParams({
      deps: params.deps,
      now,
      configPath: params.configPath,
      restoredFromBackup,
      current,
      suspicious,
      entry,
      backup: candidate.fingerprint,
      clobberedPath,
      backupPath: candidate.path,
      restoreErrorDetails,
    }),
  );

  if (restoredFromBackup) {
    healthState = createRecoveredSuspiciousHealthState({
      healthState,
      configPath: params.configPath,
      entry,
      suspiciousSignature,
    });
    writeConfigHealthStateSync(params.deps, healthState);
  }
  return { raw: candidate.raw, parsed: candidate.parsed };
}

export async function promoteConfigSnapshotToLastKnownGood(params: {
  deps: ObserveRecoveryDeps;
  snapshot: ConfigFileSnapshot;
  logger?: Pick<typeof console, "warn">;
}): Promise<boolean> {
  const { deps, snapshot } = params;
  if (!snapshot.exists || !snapshot.valid || typeof snapshot.raw !== "string") {
    return false;
  }
  const polluted = collectPollutedSecretPlaceholders(snapshot.parsed);
  if (polluted.length > 0) {
    params.logger?.warn(
      `Config last-known-good promotion skipped: redacted secret placeholder at ${polluted[0]}`,
    );
    return false;
  }
  const stat = await deps.fs.promises.stat(snapshot.path).catch(() => null);
  const now = new Date().toISOString();
  const current = createConfigHealthFingerprint({
    hash: resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(snapshot.raw),
    raw: snapshot.raw,
    parsed: snapshot.parsed,
    gatewaySource: snapshot.resolved,
    stat: stat as ConfigStatMetadataSource,
    observedAt: now,
  });
  const lastGoodPath = resolveLastKnownGoodConfigPath(snapshot.path);
  await deps.fs.promises.writeFile(lastGoodPath, snapshot.raw, {
    encoding: "utf-8",
    mode: 0o600,
  });
  await deps.fs.promises.chmod?.(lastGoodPath, 0o600).catch(() => {});
  const healthState = await readConfigHealthState(deps);
  const entry = getConfigHealthEntry(healthState, snapshot.path);
  await writeConfigHealthState(
    deps,
    setConfigHealthEntry(healthState, snapshot.path, {
      ...entry,
      lastKnownGood: current,
      lastPromotedGood: current,
      lastObservedSuspiciousSignature: null,
    }),
  );
  return true;
}

export async function recoverConfigFromLastKnownGood(params: {
  deps: ObserveRecoveryDeps;
  snapshot: ConfigFileSnapshot;
  reason: string;
}): Promise<boolean> {
  const { deps, snapshot } = params;
  if (!snapshot.exists || typeof snapshot.raw !== "string") {
    return false;
  }
  if (!shouldAttemptLastKnownGoodRecovery(snapshot)) {
    if (isPluginLocalInvalidConfigSnapshot(snapshot)) {
      deps.logger.warn(
        `Config last-known-good recovery skipped: invalidity is scoped to stale plugin config (${params.reason})`,
      );
    }
    return false;
  }
  const healthState = await readConfigHealthState(deps);
  const entry = getConfigHealthEntry(healthState, snapshot.path);
  const promoted = entry.lastPromotedGood;
  if (!promoted?.hash) {
    return false;
  }
  const lastGoodPath = resolveLastKnownGoodConfigPath(snapshot.path);
  const backupRaw = await deps.fs.promises.readFile(lastGoodPath, "utf-8").catch(() => null);
  if (!backupRaw || hashConfigRaw(backupRaw) !== promoted.hash) {
    return false;
  }
  let backupParsed: unknown;
  try {
    backupParsed = deps.json5.parse(backupRaw);
  } catch {
    return false;
  }
  const polluted = collectPollutedSecretPlaceholders(backupParsed);
  if (polluted.length > 0) {
    deps.logger.warn(
      `Config last-known-good recovery skipped: redacted secret placeholder at ${polluted[0]}`,
    );
    return false;
  }
  const now = new Date().toISOString();
  const stat = await deps.fs.promises.stat(snapshot.path).catch(() => null);
  const current = createConfigHealthFingerprint({
    hash: resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(snapshot.raw),
    raw: snapshot.raw,
    parsed: snapshot.parsed,
    gatewaySource: snapshot.resolved,
    stat: stat as ConfigStatMetadataSource,
    observedAt: now,
  });
  const clobberedPath = await persistBoundedClobberedConfigSnapshot({
    deps,
    configPath: snapshot.path,
    raw: snapshot.raw,
    observedAt: now,
  });
  await deps.fs.promises.writeFile(snapshot.path, backupRaw, {
    encoding: "utf-8",
    mode: 0o600,
  });
  await deps.fs.promises.chmod?.(snapshot.path, 0o600).catch(() => {});
  const issueSummary = formatConfigIssueSummary([...snapshot.issues, ...snapshot.legacyIssues]);
  deps.logger.warn(
    `Config auto-restored from last-known-good: ${snapshot.path} (${params.reason})${issueSummary ? `; Rejected validation details: ${issueSummary}.` : ""}`,
  );
  await appendConfigAuditRecord(
    createConfigObserveAuditAppendParams(deps, {
      ts: now,
      configPath: snapshot.path,
      valid: snapshot.valid,
      current,
      suspicious: [params.reason],
      lastKnownGood: promoted,
      backup: promoted,
      clobberedPath,
      restoredFromBackup: true,
      restoredBackupPath: lastGoodPath,
    }),
  );
  await writeConfigHealthState(
    deps,
    setConfigHealthEntry(healthState, snapshot.path, {
      ...entry,
      lastKnownGood: promoted,
      lastPromotedGood: promoted,
      lastObservedSuspiciousSignature: null,
    }),
  );
  return true;
}
