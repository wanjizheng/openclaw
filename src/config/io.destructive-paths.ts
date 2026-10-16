import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  applyUnsetPathsForWrite,
  resolveManagedUnsetPathsForWrite,
} from "./config-path-mutation.js";
import { stampConfigWriteMetadata } from "./io.meta.js";
import type { ConfigWriteOptions } from "./io.types.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

/** Keys and array indices retain structural identity; dotted strings are never authority. */
export type ConfigPath = readonly (string | number)[];

function configPathKey(path: ConfigPath): string {
  return JSON.stringify(path);
}

/** Decode only the structural path encoding emitted by configPathKey. */
export function parseConfigPathKey(key: string): ConfigPath {
  const components: unknown = JSON.parse(key);
  if (
    !Array.isArray(components) ||
    !components.every(
      (component: unknown): component is string | number =>
        typeof component === "string" ||
        (typeof component === "number" && Number.isSafeInteger(component) && component >= 0),
    )
  ) {
    throw new Error("Invalid structural config path encoding");
  }
  return components;
}

function configPathHasPrefix(path: ConfigPath, prefix: ConfigPath): boolean {
  if (prefix.length > path.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i += 1) {
    if (path[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

/** Same UTF-8 model as file-size checks, applied to each changed value. */
function approxSerializedSize(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return 0;
  }
  if (serialized === undefined) {
    return 0;
  }
  return Buffer.byteLength(serialized, "utf-8");
}

export function collectDestructiveChanges(
  before: unknown,
  target: unknown,
  path: ConfigPath,
  output: Set<string>,
): void {
  if (before !== undefined && before !== null && (target === undefined || target === null)) {
    output.add(configPathKey(path));
    return;
  }
  if (target !== undefined && target !== null && (before === undefined || before === null)) {
    return;
  }
  if (isDeepStrictEqual(before, target)) {
    return;
  }

  const beforeSize = approxSerializedSize(before);
  const targetSize = approxSerializedSize(target);

  if (Array.isArray(before) && Array.isArray(target)) {
    const max = Math.max(before.length, target.length);
    for (let index = 0; index < max; index += 1) {
      const childBefore = index < before.length ? before[index] : undefined;
      const childTarget = index < target.length ? target[index] : undefined;
      collectDestructiveChanges(childBefore, childTarget, [...path, index], output);
    }
    return;
  }
  if (isRecord(before) && isRecord(target)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(target)]);
    for (const key of keys) {
      const childBefore = Object.hasOwn(before, key) ? before[key] : undefined;
      const childTarget = Object.hasOwn(target, key) ? target[key] : undefined;
      collectDestructiveChanges(childBefore, childTarget, [...path, key], output);
    }
    return;
  }
  if (targetSize < beforeSize) {
    output.add(configPathKey(path));
  }
}

/** Derive exact pruned parents so managed removal never grants siblings authority. */
function resolveWriterManagedConfigPathsForWrite(snapshot: unknown): ConfigPath[] {
  if (!isRecord(snapshot)) {
    return [];
  }
  const managedUnset = resolveManagedUnsetPathsForWrite(undefined);
  const managedOnlyOutput = applyUnsetPathsForWrite(snapshot, managedUnset);
  const destructive = new Set<string>();
  collectDestructiveChanges(snapshot, managedOnlyOutput, [], destructive);
  const out: ConfigPath[] = [];
  for (const key of destructive) {
    out.push(parseConfigPathKey(key));
  }
  return out;
}

function collectUnauthorizedDestructivePaths(params: {
  before: unknown;
  after: unknown;
  authorizedPaths: readonly ConfigPath[] | undefined;
}): string[] {
  if (params.authorizedPaths === undefined) {
    return [];
  }
  const destructive = new Set<string>();
  collectDestructiveChanges(params.before, params.after, [], destructive);
  const authorized = [
    ...params.authorizedPaths,
    ...resolveWriterManagedConfigPathsForWrite(params.before),
  ];
  return [...destructive].filter((key) => {
    const path = parseConfigPathKey(key);
    return !authorized.some((prefix) => configPathHasPrefix(path, prefix));
  });
}

/** Normalize writer-owned version stamps before checking the final authored payload. */
export function collectUnauthorizedDestructivePathsForWrite(
  snapshot: Pick<ConfigFileSnapshot, "exists" | "parsed">,
  output: OpenClawConfig,
  options: Pick<ConfigWriteOptions, "lastTouchedVersionOverride" | "authorizedDestructivePaths">,
  env: NodeJS.ProcessEnv,
): string[] {
  if (!snapshot.exists || options.authorizedDestructivePaths === undefined) {
    return [];
  }
  const parsed = snapshot.parsed;
  if (!isRecord(parsed)) {
    // Invalid roots belong to the writer's existing rejection/audit and explicit
    // repair flow, not to structural path authority for valid config objects.
    return [];
  }
  return collectUnauthorizedDestructivePaths({
    // A canonical version change (e.g. 2026.7.1-2 -> 2026.10.3) is writer-owned.
    before: stampConfigWriteMetadata(parsed, options.lastTouchedVersionOverride, undefined, env),
    after: output,
    authorizedPaths: options.authorizedDestructivePaths,
  });
}
