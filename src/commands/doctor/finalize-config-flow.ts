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
   */
  allowConfigSizeDropOnWrite?: boolean;
}): Promise<{
  cfg: OpenClawConfig;
  shouldWriteConfig: boolean;
  allowConfigSizeDropOnWrite: boolean;
}> {
  const baseShouldWrite = params.shouldRepair && params.pendingChanges;
  const allowConfigSizeDropOnWrite = baseShouldWrite && params.allowConfigSizeDropOnWrite === true;
  if (!params.shouldRepair && params.pendingChanges) {
    const shouldApply = await params.confirm({
      message: "Apply recommended config repairs now?",
      initialValue: true,
    });
    if (shouldApply) {
      return {
        cfg: params.candidate,
        shouldWriteConfig: true,
        allowConfigSizeDropOnWrite,
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

  if (baseShouldWrite) {
    return {
      cfg: params.cfg,
      shouldWriteConfig: true,
      allowConfigSizeDropOnWrite,
    };
  }

  return {
    cfg: params.cfg,
    shouldWriteConfig: false,
    allowConfigSizeDropOnWrite: false,
  };
}
