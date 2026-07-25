import { collectDestructiveChanges } from "../../../config/io.write-prepare.js";
// Doctor config-flow steps for legacy compatibility and unknown-key cleanup.
import { formatConfigIssueLines } from "../../../config/issue-format.js";
import { protectActiveAuthProfileConfig } from "../../doctor-auth-profile-config.js";
import { stripUnknownConfigKeys } from "../../doctor-config-analysis.js";
import type { DoctorConfigPreflightResult } from "../../doctor-config-preflight.js";
import type { DoctorConfigMutationState } from "./config-mutation-state.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

/** Apply legacy config migrations and update preview/fix state for doctor config flow. */
export function applyLegacyCompatibilityStep(params: {
  snapshot: DoctorConfigPreflightResult["snapshot"];
  state: DoctorConfigMutationState;
  shouldRepair: boolean;
  doctorFixCommand: string;
}): {
  state: DoctorConfigMutationState;
  issueLines: string[];
  changeLines: string[];
  /**
   * Typed `ConfigPath` set of every destructive change the legacy migration
   * produced. The writer treats these as the only destructive size changes
   * the migration is authorized to perform; any further shrink in the same
   * transaction (path-removal, primitive shorten, container-shrink, array
   * truncation, object-children-removal) is rejected.
   */
  removedPaths: Array<readonly (string | number)[]>;
  partiallyValid?: boolean;
} {
  if (params.snapshot.legacyIssues.length === 0) {
    return {
      state: params.state,
      issueLines: [],
      changeLines: [],
      removedPaths: [],
    };
  }

  const issueLines = formatConfigIssueLines(params.snapshot.legacyIssues, "-");
  const { config: migrated, changes, partiallyValid } = migrateLegacyConfig(params.snapshot.parsed);
  if (!migrated) {
    return {
      state: {
        ...params.state,
        pendingChanges: params.state.pendingChanges || params.snapshot.legacyIssues.length > 0,
        fixHints: params.shouldRepair
          ? params.state.fixHints
          : [
              ...params.state.fixHints,
              `Run "${params.doctorFixCommand}" to migrate legacy config keys.`,
            ],
      },
      issueLines,
      changeLines: changes,
      removedPaths: [],
    };
  }

  // Diff snapshot.parsed vs migrated to record exactly which paths the legacy
  // migration made destructive (size shrink of any kind). The writer uses
  // this as the white-list of authorized destructive changes: any further
  // shrink by untrusted repairs cannot ride this list and will be rejected.
  const removedPathSet = new Set<string>();
  collectDestructiveChanges(params.snapshot.parsed, migrated, [], removedPathSet);
  const removedPaths = Array.from(removedPathSet).map(
    (key) => JSON.parse(key) as readonly (string | number)[],
  );

  return {
    state: {
      // Doctor should keep using the best-effort migrated shape in memory even
      // during preview mode; confirmation only controls whether we write it.
      // When partiallyValid, the migration succeeded but unrelated validation issues
      // remain — still commit the migration so doctor --fix always applies safe migrations
      // even when other problems prevent full validation from passing.
      cfg: migrated,
      candidate: migrated,
      // The read path can normalize legacy config into the snapshot before
      // migrateLegacyConfig emits concrete mutations. Legacy issues still mean
      // the on-disk config needs a doctor --fix path.
      pendingChanges: params.state.pendingChanges || params.snapshot.legacyIssues.length > 0,
      fixHints: params.shouldRepair
        ? params.state.fixHints
        : [
            ...params.state.fixHints,
            `Run "${params.doctorFixCommand}" to ${partiallyValid ? "finish fixing" : "migrate"} legacy config keys.`,
          ],
    },
    issueLines,
    changeLines: changes,
    removedPaths,
    partiallyValid: partiallyValid === true ? true : undefined,
  };
}

/** Strip unknown config keys while preserving active auth profile settings. */
export function applyUnknownConfigKeyStep(params: {
  state: DoctorConfigMutationState;
  shouldRepair: boolean;
  doctorFixCommand: string;
}): {
  state: DoctorConfigMutationState;
  removed: string[];
  /**
   * Typed `ConfigPath` form of `removed`, used by the writer to authorize
   * destructive size changes without path-string collisions.
   */
  removedPaths: Array<readonly (string | number)[]>;
  repairs: string[];
  warnings: string[];
} {
  const unknown = stripUnknownConfigKeys(params.state.candidate);
  if (unknown.removed.length === 0) {
    return { state: params.state, removed: [], removedPaths: [], repairs: [], warnings: [] };
  }
  const protectedAuth = protectActiveAuthProfileConfig({
    before: params.state.candidate,
    after: unknown.config,
  });

  return {
    state: {
      cfg: params.shouldRepair ? protectedAuth.config : params.state.cfg,
      candidate: protectedAuth.config,
      pendingChanges: true,
      fixHints: params.shouldRepair
        ? params.state.fixHints
        : [...params.state.fixHints, `Run "${params.doctorFixCommand}" to remove these keys.`],
    },
    removed: unknown.removed,
    removedPaths: unknown.removedPaths,
    repairs: protectedAuth.repairs,
    warnings: protectedAuth.warnings,
  };
}
