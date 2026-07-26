// Final doctor config-write decision after preview/repair mode has collected mutations.
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Decide whether doctor should write the repaired candidate config or only print hints. */
export async function finalizeDoctorConfigFlow(params: {
  cfg: OpenClawConfig;
  candidate: OpenClawConfig;
  pendingChanges: boolean;
  shouldRepair: boolean;
  fixHints: string[];
  confirm: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
  note: (message: string, title?: string) => void;
  /**
   * Explicit opt-in for the 50% size-drop guard. Owner: a named migration
   * step that knows it must remove legacy keys. Generic `shouldWriteConfig`
   * is no longer enough — auto-update's `doctor --fix` non-interactive pass
   * also trips that flag, which previously let unattended update flows
   * silently shrink the user's config and force a `.bak` → main auto-restore
   * on next startup (#80077 regression vector).
   *
   * The opt-in is independent of `shouldRepair`: it is validated against the
   * FINAL write decision, including the interactive `confirm` path, so a
   * user-confirmed legacy migration in plain `openclaw doctor` still gets
   * the size-drop override when the upstream migration step set it.
   */
  allowConfigSizeDropOnWrite?: boolean;
}): Promise<{
  cfg: OpenClawConfig;
  shouldWriteConfig: boolean;
  allowConfigSizeDropOnWrite: boolean;
}> {
  const requestedSizeDropOptIn = params.allowConfigSizeDropOnWrite === true;

  if (!params.shouldRepair && params.pendingChanges) {
    const shouldApply = await params.confirm({
      message: "Apply recommended config repairs now?",
      initialValue: true,
    });
    if (shouldApply) {
      return {
        cfg: params.candidate,
        shouldWriteConfig: true,
        allowConfigSizeDropOnWrite: requestedSizeDropOptIn,
      };
    }
    if (params.fixHints.length > 0) {
      params.note(params.fixHints.join("\n"), "Doctor");
    }
    return {
      cfg: params.cfg,
      shouldWriteConfig: false,
      allowConfigSizeDropOnWrite: false,
    };
  }

  if (params.shouldRepair && params.pendingChanges) {
    return {
      cfg: params.cfg,
      shouldWriteConfig: true,
      allowConfigSizeDropOnWrite: requestedSizeDropOptIn,
    };
  }

  return {
    cfg: params.cfg,
    shouldWriteConfig: false,
    allowConfigSizeDropOnWrite: false,
  };
}
